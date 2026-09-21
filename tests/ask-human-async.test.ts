import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpRequestContext } from "../src/request-context";
import { LocalCommsStore } from "../src/store";
import { createCommunicationTools } from "../src/tools";

// Architecture ② (escalate-and-resume): ask_human_async posts a question to a
// human and returns IMMEDIATELY (no blocking poll, no SSE keepalive, no 120s
// client cap). The kelos Task then exits; a watcher later spawns a continuation
// Task carrying the human's reply. These tests pin the contract the watcher and
// the continuation depend on: the question is posted + discoverable, it carries
// the continuation metadata, and a later reply is readable by the asker.

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-mailbox-ask-async-"));
  tempDirs.push(dir);
  return join(dir, "mailbox.sqlite");
}

interface AskAsyncResult {
  posted: boolean;
  question_id: string;
  thread_id: string;
  recipient_id: string;
}

async function runAskAsync(
  store: LocalCommsStore,
  askingAgentId: string,
  workspace: string,
  args: Record<string, unknown>,
): Promise<AskAsyncResult> {
  const tools = createCommunicationTools(store, {
    id: askingAgentId,
    name: askingAgentId,
    workspace,
  });
  const tool = tools.find((t) => t.name === "ask_human_async");
  if (!tool) {
    throw new Error("ask_human_async tool not registered");
  }
  return await mcpRequestContext.run({}, async () => {
    const result = await tool.run(args);
    return (result as { result: AskAsyncResult }).result;
  });
}

test("ask_human_async posts a question and returns immediately (no blocking)", async () => {
  const store = await LocalCommsStore.openSqlite(tempDb());
  try {
    const start = Date.now();
    const result = await runAskAsync(store, "kelos", "inpulse", {
      question: "Approve the release?",
    });
    const elapsed = Date.now() - start;

    // The whole point of ②: no poll loop, so the call returns essentially
    // instantly rather than waiting out any timeout.
    expect(elapsed).toBeLessThan(1_000);
    expect(result.posted).toBe(true);
    expect(result.question_id).toBeString();
    expect(result.thread_id).toBeString();
    expect(result.recipient_id).toBe("local-brian");

    // The question is discoverable in the human's inbox, tagged so both the
    // human answerer and the continuation watcher can find it.
    const inbox = await store.inbox("local-brian", {
      workspace: "inpulse",
      includeSent: false,
      limit: 10,
    });
    const question = inbox.find((m) => m.id === result.question_id);
    expect(question).toBeDefined();
    expect(question!.body).toBe("Approve the release?");
    const meta = question!.metadata as Record<string, unknown>;
    expect(meta.event_type).toBe("ask_human");
    expect(meta.mode).toBe("async");
  } finally {
    await store.close();
  }
});

test("ask_human_async persists resume_context + continuation_task for the watcher", async () => {
  const store = await LocalCommsStore.openSqlite(tempDb());
  try {
    const result = await runAskAsync(store, "kelos", "inpulse", {
      question: "Which environment should I deploy to?",
      resume_context: "PR #4663 review; awaiting deploy-target decision.",
      continuation_task: "inpulse-pr-reviewer",
    });

    const inbox = await store.inbox("local-brian", {
      workspace: "inpulse",
      includeSent: false,
      limit: 10,
    });
    const question = inbox.find((m) => m.id === result.question_id);
    expect(question).toBeDefined();
    const meta = question!.metadata as Record<string, unknown>;
    expect(meta.resume_context).toBe(
      "PR #4663 review; awaiting deploy-target decision.",
    );
    expect(meta.continuation_task).toBe("inpulse-pr-reviewer");
  } finally {
    await store.close();
  }
});

test("a later reply to an ask_human_async question is readable by the asker (continuation can fetch the answer)", async () => {
  const store = await LocalCommsStore.openSqlite(tempDb());
  try {
    const result = await runAskAsync(store, "kelos", "inpulse", {
      question: "PROBE: what is 2+2?",
    });

    // Human replies later, via the exact store call reply_message / mb-client
    // makes (message_id = questionId).
    const reply = await store.replyMessage({
      senderId: "local-brian",
      workspace: "inpulse",
      messageId: result.question_id,
      body: "4",
    });
    expect(reply.recipient_id).toBe("kelos");
    expect(reply.thread_id).toBe(result.thread_id);
    expect(reply.reply_to_message_id).toBe(result.question_id);

    // The watcher/continuation reads the thread AS THE ASKER and finds the
    // human's answer — the same visibility invariant the retired ① relied on.
    const thread = await store.getThread("kelos", result.thread_id, "inpulse", 200, 0);
    const humanReply = thread.find(
      (m) => m.sender_id !== "kelos" && m.recipient_id === "kelos",
    );
    expect(humanReply?.body).toBe("4");
  } finally {
    await store.close();
  }
});
