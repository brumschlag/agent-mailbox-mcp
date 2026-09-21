import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAgentMailboxHttpServer, type AgentMailboxHttpServer } from "../src/http";
import {
  mcpRequestContext,
  type ProgressNotification,
} from "../src/request-context";
import { LocalCommsStore } from "../src/store";
import { createCommunicationTools } from "../src/tools";

const tempDirs: string[] = [];
const servers: AgentMailboxHttpServer[] = [];
const adminToken = "test-admin-token";

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-mailbox-ask-human-"));
  tempDirs.push(dir);
  return join(dir, "mailbox.sqlite");
}

interface AskHumanResult {
  answered: boolean;
  question_id: string;
  keepalives_sent: number;
  reply?: { message_id: string; sender_id: string; body: string };
}

async function runAskHuman(
  store: LocalCommsStore,
  askingAgentId: string,
  workspace: string,
  args: Record<string, unknown>,
  context: {
    sendNotification?: (n: ProgressNotification) => Promise<void>;
    signal?: AbortSignal;
    progressToken?: string | number;
  } = {},
): Promise<AskHumanResult> {
  const tools = createCommunicationTools(store, {
    id: askingAgentId,
    name: askingAgentId,
    workspace,
  });
  const askHuman = tools.find((tool) => tool.name === "ask_human");
  if (!askHuman) {
    throw new Error("ask_human tool not registered");
  }
  const output = await mcpRequestContext.run(context, async () => {
    const result = await askHuman.run(args);
    return (result as { result: AskHumanResult }).result;
  });
  return output;
}

test(
  "ask_human blocks, emits keepalives, and resolves with a human reply",
  async () => {
    const store = await LocalCommsStore.openSqlite(tempDb());
    try {
      const keepalives: ProgressNotification[] = [];
      const sendNotification = async (n: ProgressNotification) => {
        keepalives.push(n);
      };

      // Drive the ask_human call and a delayed human reply concurrently.
      const askPromise = runAskHuman(
        store,
        "codex",
        "repo-a",
        {
          question: "Ship the release now?",
          recipient_id: "local-brian",
          timeout_ms: 5_000,
          poll_interval_ms: 100,
        },
        { sendNotification, progressToken: "tok-1" },
      );

      // Human replies after a short delay, in the question's thread.
      const inbox = await waitForQuestion(store, "local-brian", "repo-a");
      await store.sendMessage({
        senderId: "local-brian",
        workspace: "repo-a",
        recipientId: "codex",
        body: "Yes, ship it.",
        threadId: inbox.thread_id,
        replyToMessageId: inbox.id,
      });

      const result = await askPromise;
      expect(result.answered).toBe(true);
      expect(result.reply?.sender_id).toBe("local-brian");
      expect(result.reply?.body).toBe("Yes, ship it.");
      expect(result.question_id).toBe(inbox.id);
      // At least the initial keepalive fired during the wait, and it carried
      // the client's progress token so a real client would display it.
      expect(result.keepalives_sent).toBeGreaterThanOrEqual(1);
      expect(keepalives.length).toBeGreaterThanOrEqual(1);
      expect(keepalives[0]?.method).toBe("notifications/progress");
      expect(keepalives[0]?.params.progressToken).toBe("tok-1");
    } finally {
      await store.close();
    }
  },
  15_000,
);

test("ask_human returns answered=false when the timeout elapses", async () => {
  const store = await LocalCommsStore.openSqlite(tempDb());
  try {
    const result = await runAskHuman(store, "codex", "repo-a", {
      question: "Anyone there?",
      timeout_ms: 250,
      poll_interval_ms: 100,
    });
    expect(result.answered).toBe(false);
    expect(result.reply).toBeUndefined();
    expect(result.question_id).toBeString();
    // Even with no notification context wired, the call must not throw.
    expect(result.keepalives_sent).toBe(0);
  } finally {
    await store.close();
  }
});

test(
  "ask_human detects a reply created via reply_message from a different agent (real relay flow)",
  async () => {
    // Regression for the live incident: asker `kelos` (workspace `inpulse`)
    // posts a question via ask_human, and a DIFFERENT agent `local-brian`
    // answers with the exact store call the `reply_message` tool makes
    // (message_id = questionId). ask_human polls getThread as the ASKER, so
    // the reply — sender=local-brian, recipient=kelos, thread_id=questionId,
    // reply_to_message_id=questionId — must be surfaced by firstHumanReply.
    // The earlier unit test drives the reply through store.sendMessage with a
    // hand-built recipient/thread; this one goes through replyMessage's own
    // recipient-derivation + thread linkage, matching what the human's client
    // (scripts/mb-client.mjs) actually does.
    const store = await LocalCommsStore.openSqlite(tempDb());
    try {
      const askPromise = runAskHuman(
        store,
        "kelos",
        "inpulse",
        {
          question: "PROBE: what is 2+2?",
          recipient_id: "local-brian",
          timeout_ms: 5_000,
          poll_interval_ms: 100,
        },
      );

      const question = await waitForQuestion(store, "local-brian", "inpulse");
      const reply = await store.replyMessage({
        senderId: "local-brian",
        workspace: "inpulse",
        messageId: question.id,
        body: "4",
      });
      // Preconditions the fix depends on: the reply is addressed back to the
      // asker and threaded onto the question so getThread(asker, thread) sees it.
      expect(reply.recipient_id).toBe("kelos");
      expect(reply.thread_id).toBe(question.thread_id);
      expect(reply.reply_to_message_id).toBe(question.id);

      const result = await askPromise;
      expect(result.answered).toBe(true);
      expect(result.reply?.sender_id).toBe("local-brian");
      expect(result.reply?.body).toBe("4");
      expect(result.question_id).toBe(question.id);
    } finally {
      await store.close();
    }
  },
  15_000,
);

test(
  "ask_human must poll the thread as the ASKER, not the recipient",
  async () => {
    // Root-cause guard. The human's reply is addressed to the asker
    // (recipient_id = asker), so only a getThread issued AS THE ASKER surfaces
    // it in a way firstHumanReply accepts. If ask_human ever polled as the
    // recipient instead, the reply's sender === the polling agent, so
    // firstHumanReply's `sender_id !== askingAgentId` guard would drop it and
    // the call would block until timeout — the exact live symptom. Pin the
    // store-level invariant that makes the fix correct.
    const store = await LocalCommsStore.openSqlite(tempDb());
    try {
      const question = await store.sendMessage({
        senderId: "kelos",
        workspace: "inpulse",
        recipientId: "local-brian",
        body: "Q",
        metadata: { event_type: "ask_human" },
      });
      await store.replyMessage({
        senderId: "local-brian",
        workspace: "inpulse",
        messageId: question.id,
        body: "4",
      });

      const asAsker = await store.getThread("kelos", question.thread_id, "inpulse", 200, 0);
      const reply = asAsker.find(
        (m) => m.sender_id !== "kelos" && m.recipient_id === "kelos",
      );
      expect(reply?.body).toBe("4");
    } finally {
      await store.close();
    }
  },
);

test(
  "ask_human over Streamable HTTP survives the wait and delivers progress to a real client",
  async () => {
    const server = await startTestServer();
    const askerKey = await createAccessKey(server, {
      name: "Asker",
      agent_id: "asker",
      agent_name: "Asker",
      workspace: "hil",
    });
    const humanKey = await createAccessKey(server, {
      name: "Human",
      agent_id: "local-brian",
      agent_name: "Human",
      workspace: "hil",
    });

    const asker = createHttpClient(server.url, askerKey.token, "asker-client");
    const human = createHttpClient(server.url, humanKey.token, "human-client");
    try {
      await asker.client.connect(asker.transport);
      await human.client.connect(human.transport);

      const progressUpdates: number[] = [];

      // Blocking call from the asker; opt into progress via onprogress so the
      // SDK injects a real progressToken end-to-end.
      const askPromise = asker.client.callTool(
        {
          name: "ask_human",
          arguments: {
            question: "Approve deploy?",
            recipient_id: "local-brian",
            timeout_ms: 8_000,
            poll_interval_ms: 200,
          },
        },
        undefined,
        {
          onprogress: (progress) => {
            progressUpdates.push(progress.progress);
          },
        },
      );

      // Human finds the question and replies ~1.5s into the wait.
      await sleep(1_500);
      const inbox = (await human.client.callTool({
        name: "inbox",
        arguments: { unread_only: true },
      })) as unknown as {
        structuredContent: { messages: Array<{ id: string; thread_id: string; body: string }> };
      };
      const question = inbox.structuredContent.messages.find((m) =>
        m.body.includes("Approve deploy?"),
      );
      expect(question).toBeDefined();

      await human.client.callTool({
        name: "reply_message",
        arguments: { message_id: question!.id, body: "Approved." },
      });

      const result = (await askPromise) as unknown as {
        isError?: boolean;
        structuredContent: AskHumanResult;
      };
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent.answered).toBe(true);
      expect(result.structuredContent.reply?.sender_id).toBe("local-brian");
      expect(result.structuredContent.reply?.body).toBe("Approved.");
      // The connection stayed open across the multi-second wait and the client
      // received at least one progress notification (keepalive) before the
      // final result — proving mid-handler bytes reached a real MCP client.
      expect(result.structuredContent.keepalives_sent).toBeGreaterThanOrEqual(1);
      expect(progressUpdates.length).toBeGreaterThanOrEqual(1);
    } finally {
      await asker.transport.close();
      await human.transport.close();
    }
  },
  20_000,
);

async function waitForQuestion(
  store: LocalCommsStore,
  recipientId: string,
  workspace: string,
): Promise<{ id: string; thread_id: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const messages = await store.inbox(recipientId, { workspace, includeSent: false, limit: 10 });
    const question = messages.find((m) => m.metadata && (m.metadata as Record<string, unknown>).event_type === "ask_human");
    if (question) {
      return { id: question.id, thread_id: question.thread_id };
    }
    await sleep(20);
  }
  throw new Error("Question was never posted to the recipient's inbox");
}

async function startTestServer(): Promise<AgentMailboxHttpServer> {
  const dir = mkdtempSync(join(tmpdir(), "agent-mailbox-ask-human-http-"));
  tempDirs.push(dir);
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const dbPath = join(dir, "mailbox.sqlite");
      const server = await startAgentMailboxHttpServer({
        adminToken,
        host: "127.0.0.1",
        port: 30000 + Math.floor(Math.random() * 20000),
        path: "/mcp",
        dbPath,
        database: { kind: "sqlite", path: dbPath },
        s3: null,
        tokens: [],
      });
      servers.push(server);
      return server;
    } catch (error) {
      lastError = error;
      if (!String(error).includes("Failed to start server")) {
        throw error;
      }
    }
  }
  throw lastError;
}

function createHttpClient(url: string, token: string, name: string) {
  const client = new Client({ name, version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  return { client, transport };
}

async function createAccessKey(
  server: AgentMailboxHttpServer,
  body: Record<string, unknown>,
): Promise<{ token: string }> {
  const response = await fetch(`http://${server.host}:${server.port}/api/access-keys`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 201) {
    throw new Error(`Failed to create access key: ${response.status}`);
  }
  return (await response.json()) as { token: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
