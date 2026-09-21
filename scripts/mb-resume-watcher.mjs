// Continuation watcher for architecture ② (escalate-and-resume).
//
// Polls the mailbox as local-brian for ask_human_async questions that a human
// has now answered, and spawns a continuation kelos Task carrying the answer.
// Idempotent two ways: a `continuation_spawned` marker posted into the question
// thread (survives watcher restarts) AND a deterministic Task name (kubectl
// apply can't create a duplicate).
//
// Usage:
//   MB_TOKEN=$(cat ~/.mailbox-local-token) \
//   MB_URL=http://127.0.0.1:8137/mcp \
//   KELOS_CONTEXT=arn:aws:eks:us-east-1:565715328522:cluster/software-engineering \
//   bun scripts/mb-resume-watcher.mjs [--dry-run] [--loops N] [--interval-ms MS] [--once]
//
// --dry-run : print the Task JSON that WOULD be applied; do not apply or mark.
// --once    : run a single poll and exit (handy for probes / cron).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContinuationTask,
  continuationTaskName,
  decideContinuation,
} from "./lib/continuation.mjs";

const token = process.env.MB_TOKEN;
const url = new URL(process.env.MB_URL || "http://127.0.0.1:8137/mcp");
const workspace = process.env.MB_WORKSPACE || "inpulse";
const kctx =
  process.env.KELOS_CONTEXT ||
  "arn:aws:eks:us-east-1:565715328522:cluster/software-engineering";
const ns = process.env.KELOS_NAMESPACE || "kelos-pilot";
const contWorkspace = process.env.CONT_WORKSPACE || "envoverrides-scratch";
const contModel = process.env.CONT_MODEL || "claude-sonnet-46";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const once = argv.includes("--once");
const loops = intArg("--loops", 120);
const intervalMs = intArg("--interval-ms", 5000);

function intArg(flag, def) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? parseInt(argv[i + 1], 10) : def;
}

if (!token) {
  console.error("MB_TOKEN is required (e.g. $(cat ~/.mailbox-local-token))");
  process.exit(2);
}

const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "mb-resume-watcher", version: "0.1.0" }, { capabilities: {} });
await client.connect(transport);

const parse = (r) => {
  const text = (r.content || []).map((c) => c.text ?? "").join("");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
};
const messagesOf = (parsed) =>
  Array.isArray(parsed) ? parsed : parsed.messages ?? [];

const applied = new Set(); // in-run guard against re-processing before the marker lands

async function pollOnce() {
  const inbox = parse(
    await client.callTool({
      name: "inbox",
      arguments: { workspace, unread_only: false, limit: 200 },
    }),
  );
  const questions = messagesOf(inbox).filter(
    (m) => m.metadata?.event_type === "ask_human" && m.metadata?.mode === "async",
  );
  if (questions.length === 0) {
    console.log(`[watch] no async questions pending`);
    return;
  }

  for (const q of questions) {
    if (applied.has(q.id)) continue;
    const thread = messagesOf(
      parse(
        await client.callTool({
          name: "get_thread",
          arguments: { workspace, thread_id: q.thread_id, limit: 200 },
        }),
      ),
    );
    const decision = decideContinuation(q, thread);
    if (!decision.shouldSpawn) {
      console.log(
        `[watch] q=${q.id} answered=${Boolean(decision.answer)} alreadySpawned=${decision.alreadySpawned} -> skip`,
      );
      continue;
    }

    const task = buildContinuationTask({
      question: q,
      answer: decision.answer,
      namespace: ns,
      workspace: contWorkspace,
      model: contModel,
    });
    const name = task.metadata.name;

    if (dryRun) {
      console.log(`[DRY-RUN] would apply continuation Task ${name} for q=${q.id}`);
      console.log(JSON.stringify(task, null, 2));
      continue;
    }

    // Spawn THEN mark (checkpoint-after-sink): if marking fails, the next loop
    // re-applies the same-named Task (idempotent) and re-marks — never a dup.
    const dir = mkdtempSync(join(tmpdir(), "mb-continuation-"));
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(task));
    const out = execFileSync(
      "kubectl",
      ["--context", kctx, "-n", ns, "apply", "-f", file],
      { encoding: "utf8" },
    );
    console.log(`[watch] applied ${name} for q=${q.id}: ${out.trim()}`);

    await client.callTool({
      name: "send_message",
      arguments: {
        workspace,
        recipient_id: q.metadata?.asker_id ?? q.sender_id,
        thread_id: q.thread_id,
        reply_to_message_id: q.id,
        body: `🔁 Continuation Task \`${name}\` spawned with the human's answer.`,
        metadata: { event_type: "continuation_spawned", question_id: q.id, task_name: name },
      },
    });
    applied.add(q.id);
  }
}

try {
  const total = once ? 1 : loops;
  for (let i = 0; i < total; i++) {
    try {
      await pollOnce();
    } catch (err) {
      console.error(`[watch ${i}] error:`, err?.message ?? err);
    }
    if (i < total - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
} finally {
  await client.close();
}
