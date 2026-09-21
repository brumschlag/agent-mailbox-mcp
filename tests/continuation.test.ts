import { expect, test } from "bun:test";
import {
  buildContinuationTask,
  continuationTaskName,
  decideContinuation,
  firstHumanReply,
  hasContinuationMarker,
} from "../scripts/lib/continuation.mjs";

// Pure decision logic for the architecture-② continuation watcher. The watcher's
// I/O (MCP polling + kubectl apply) is a thin shell over these functions; the
// correctness that matters — "is this question answered?", "did we already spawn
// a continuation?", "what Task do we apply?" — lives here and is unit-tested.

const QID = "q-0183";
const ASKER = "kelos";

function question(overrides = {}) {
  return {
    id: QID,
    thread_id: QID,
    sender_id: ASKER,
    recipient_id: "local-brian",
    body: "Which environment should I deploy to?",
    metadata: { event_type: "ask_human", mode: "async", asker_id: ASKER },
    ...overrides,
  };
}

function humanReply(overrides = {}) {
  return {
    id: "r-1",
    thread_id: QID,
    sender_id: "local-brian",
    recipient_id: ASKER,
    reply_to_message_id: QID,
    body: "staging",
    metadata: {},
    ...overrides,
  };
}

test("firstHumanReply finds the human's answer addressed back to the asker", () => {
  const thread = [question(), humanReply()];
  const reply = firstHumanReply(thread, ASKER, QID);
  expect(reply?.body).toBe("staging");
});

test("firstHumanReply ignores the asker's own messages and the question itself", () => {
  const thread = [
    question(),
    { id: "self", thread_id: QID, sender_id: ASKER, recipient_id: "local-brian", body: "still waiting", metadata: {} },
  ];
  expect(firstHumanReply(thread, ASKER, QID)).toBeNull();
});

test("hasContinuationMarker detects an already-spawned continuation for this question", () => {
  const marker = {
    id: "m-1",
    thread_id: QID,
    sender_id: "local-brian",
    recipient_id: ASKER,
    body: "continuation spawned",
    metadata: { event_type: "continuation_spawned", question_id: QID, task_name: "resume-q-0183" },
  };
  expect(hasContinuationMarker([question(), humanReply(), marker], QID)).toBe(true);
  // A marker for a DIFFERENT question must not count.
  const otherMarker = { ...marker, metadata: { ...marker.metadata, question_id: "q-other" } };
  expect(hasContinuationMarker([question(), otherMarker], QID)).toBe(false);
});

test("decideContinuation: answered + not-yet-spawned => spawn with the answer", () => {
  const d = decideContinuation(question(), [question(), humanReply()]);
  expect(d.shouldSpawn).toBe(true);
  expect(d.answer).toBe("staging");
});

test("decideContinuation: unanswered => do not spawn", () => {
  const d = decideContinuation(question(), [question()]);
  expect(d.shouldSpawn).toBe(false);
  expect(d.answer).toBeNull();
});

test("decideContinuation: answered but marker present => do not spawn (idempotent)", () => {
  const marker = {
    id: "m-1", thread_id: QID, sender_id: "local-brian", recipient_id: ASKER,
    body: "x", metadata: { event_type: "continuation_spawned", question_id: QID },
  };
  const d = decideContinuation(question(), [question(), humanReply(), marker]);
  expect(d.shouldSpawn).toBe(false);
});

test("continuationTaskName is a deterministic, valid k8s name derived from the question id", () => {
  const name = continuationTaskName("01831307-AB_cd/xyz");
  expect(name).toMatch(/^resume-[a-z0-9-]+$/);
  expect(name.length).toBeLessThanOrEqual(63);
  // Deterministic: same question id => same name (dedup relies on this).
  expect(continuationTaskName("01831307-AB_cd/xyz")).toBe(name);
});

test("buildContinuationTask produces a valid kelos Task carrying the answer", () => {
  const task = buildContinuationTask({
    question: question({ metadata: { ...question().metadata, resume_context: "PR #4663 deploy target" } }),
    answer: "staging",
    namespace: "kelos-pilot",
    workspace: "envoverrides-scratch",
    model: "claude-sonnet-46",
  });
  expect(task.apiVersion).toBe("kelos.dev/v1alpha2");
  expect(task.kind).toBe("Task");
  expect(task.metadata.namespace).toBe("kelos-pilot");
  expect(task.metadata.name).toBe(continuationTaskName(QID));
  expect(task.spec.type).toBe("claude-code");
  expect(task.spec.workspaceRef.name).toBe("envoverrides-scratch");
  expect(task.spec.agentConfigRefs).toContainEqual({ name: "collab-bridge" });
  // The human's answer and the resume context must reach the continuation prompt.
  expect(task.spec.prompt).toContain("staging");
  expect(task.spec.prompt).toContain("PR #4663 deploy target");
  // Label lets us find/dedup spawned continuations on the cluster too.
  expect(task.metadata.labels["mailbox/question-id"]).toBe(continuationTaskName(QID).replace("resume-", ""));
});
