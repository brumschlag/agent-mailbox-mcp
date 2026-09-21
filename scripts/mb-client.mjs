// Minimal local MCP client for the agent-mailbox relay (local-brian identity).
// Usage: MB_TOKEN=... MB_URL=http://127.0.0.1:8137/mcp bun mb-client.mjs <cmd> [args]
//   whoami            -> session_start + who_is_online
//   send <to> <text>  -> send_message to an agent id
//   inbox             -> list unread
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token = process.env.MB_TOKEN;
const url = new URL(process.env.MB_URL || "http://127.0.0.1:8137/mcp");
const [cmd, ...rest] = process.argv.slice(2);

const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "local-brian", version: "0.0.1" }, { capabilities: {} });
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content || []).map((c) => c.text ?? "").join("\n");
  console.log(`\n# ${name}(${JSON.stringify(args)})\n${text}`);
  return text;
};

try {
  if (cmd === "whoami") {
    const { tools } = await client.listTools();
    console.log("tools:", tools.map((t) => t.name).join(", "));
    await call("session_start", { workspace: "inpulse" });
    await call("who_is_online", { workspace: "inpulse" });
  } else if (cmd === "send") {
    const [to, ...msg] = rest;
    await call("send_message", { workspace: "inpulse", recipient_id: to, body: msg.join(" ") });
  } else if (cmd === "inbox") {
    await call("inbox", { workspace: "inpulse" });
  } else if (cmd === "reply") {
    const [mid, ...msg] = rest;
    await call("reply_message", { workspace: "inpulse", message_id: mid, body: msg.join(" ") });
  } else if (cmd === "watch") {
    let since = new Date(Date.now() - 120000).toISOString();
    const loops = parseInt(rest[0] || "20", 10);
    for (let i = 0; i < loops; i++) {
      const r = await client.callTool({
        name: "watch_updates",
        arguments: { workspace: "inpulse", since, timeout_ms: 30000, interval_ms: 1000 },
      });
      const text = (r.content || []).map((c) => c.text ?? "").join("\n");
      if (text && text.replace(/\s/g, "") !== "{}") console.log(`[watch ${i}] ${text}`);
      since = new Date().toISOString();
    }
  } else if (cmd === "answer") {
    const r = await client.callTool({ name: "inbox", arguments: { workspace: "inpulse" } });
    const data = JSON.parse((r.content || []).map((c) => c.text ?? "").join(""));
    const msgs = data.messages || [];
    const q =
      msgs.find((m) => m.unread && m.metadata && m.metadata.event_type === "ask_human") ||
      msgs.find((m) => m.unread);
    if (!q) {
      console.log("no unread question to answer");
      process.exitCode = 3;
    } else {
      console.log(`answering ${q.sender_id} (msg ${q.id}): "${q.body}"`);
      await call("reply_message", { workspace: "inpulse", message_id: q.id, body: rest.join(" ") });
    }
  } else if (cmd === "getthread") {
    await call("get_thread", { workspace: "inpulse", thread_id: rest[0], limit: 50 });
  } else {
    console.error("unknown cmd:", cmd);
    process.exitCode = 2;
  }
} finally {
  await client.close();
}
