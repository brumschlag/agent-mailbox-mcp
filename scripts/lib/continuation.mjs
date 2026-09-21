// Pure decision logic for the architecture-② (escalate-and-resume) continuation
// watcher. No I/O here — the watcher shell (mb-resume-watcher.mjs) feeds these
// functions thread data pulled over MCP and applies the Task they build via
// kubectl. Keeping this pure makes the load-bearing logic unit-testable without
// a cluster (tests/continuation.test.ts).

export const API_VERSION = "kelos.dev/v1alpha2";

// The human's answer to an ask_human question: the first in-thread message that
// is NOT the question and NOT from the asker, addressed back to the asker (or an
// explicit reply to the question). Mirrors firstHumanReply in src/tools.ts so the
// watcher's view matches what the relay considers a reply.
export function firstHumanReply(threadMessages, askerId, questionId) {
  for (const m of threadMessages ?? []) {
    if (m.id === questionId) continue;
    if (m.sender_id === askerId) continue;
    if (m.recipient_id === askerId || m.reply_to_message_id === questionId) {
      return m;
    }
  }
  return null;
}

// Idempotency guard: has a continuation already been spawned for this question?
// The marker lives in the mailbox thread (survives watcher restarts), so we never
// double-spawn even across process crashes.
export function hasContinuationMarker(threadMessages, questionId) {
  return (threadMessages ?? []).some(
    (m) =>
      m.metadata &&
      m.metadata.event_type === "continuation_spawned" &&
      m.metadata.question_id === questionId,
  );
}

// Decide whether to spawn a continuation for an ask_human_async question given
// its full thread. Answered + not-yet-spawned => spawn, carrying the answer body.
export function decideContinuation(question, threadMessages) {
  const askerId = question.metadata?.asker_id ?? question.sender_id;
  const reply = firstHumanReply(threadMessages, askerId, question.id);
  const alreadySpawned = hasContinuationMarker(threadMessages, question.id);
  return {
    shouldSpawn: Boolean(reply) && !alreadySpawned,
    answer: reply ? reply.body : null,
    answerMessage: reply,
    alreadySpawned,
  };
}

// Deterministic, RFC1123-valid k8s Task name derived from the question id. Being
// deterministic is what makes `kubectl apply` a second dedup layer beneath the
// mailbox marker: the same question always maps to the same Task name.
export function continuationTaskName(questionId) {
  const slug = String(questionId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `resume-${slug}`.slice(0, 63).replace(/-+$/g, "");
}

// Build the continuation kelos Task as a plain object (applied as JSON, so
// human-typed answers can't break YAML). Mirrors the pilot's probe-task wiring:
// bedrock-gateway creds via podOverrides.env, collab-bridge for mailbox access.
export function buildContinuationTask({ question, answer, namespace, workspace, model }) {
  const name = continuationTaskName(question.id);
  const resumeContext = question.metadata?.resume_context ?? "(none provided)";
  const continuationHint = question.metadata?.continuation_task ?? "(none)";
  const prompt = [
    "You are the CONTINUATION of a previous agent run that paused to ask a human a question.",
    "",
    `Original question you asked: "${question.body}"`,
    `The human answered: "${answer}"`,
    `Resume context: ${resumeContext}`,
    `Continuation target hint: ${continuationHint}`,
    "",
    "First, print exactly this line so the escalate-and-resume loop can be verified end to end:",
    `RESUMED WITH ANSWER: ${answer}`,
    "",
    "Then continue the work described in the resume context, taking the human's answer",
    'as the decision. Use the `agent-mailbox` MCP tools (workspace "inpulse") if you need',
    "to coordinate or ask a further question via ask_human_async.",
  ].join("\n");

  return {
    apiVersion: API_VERSION,
    kind: "Task",
    metadata: {
      name,
      namespace,
      labels: {
        "mailbox/continuation": "true",
        "mailbox/question-id": name.replace(/^resume-/, ""),
      },
    },
    spec: {
      type: "claude-code",
      model,
      credentials: { type: "none" },
      workspaceRef: { name: workspace },
      agentConfigRefs: [{ name: "collab-bridge" }],
      ttlSecondsAfterFinished: 3600,
      prompt,
      podOverrides: {
        nodeSelector: { "kubernetes.io/arch": "amd64" },
        env: [
          { name: "ANTHROPIC_BASE_URL", value: "http://bedrock-gateway.honcho.svc.cluster.local" },
          {
            name: "ANTHROPIC_AUTH_TOKEN",
            valueFrom: { secretKeyRef: { name: "honcho-gateway-key", key: "gateway-api-key" } },
          },
          { name: "MAX_THINKING_TOKENS", value: "0" },
        ],
      },
    },
  };
}
