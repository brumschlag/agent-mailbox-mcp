import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AnyTool, JSONToolOutput } from "beeai-framework/tools/base";
import type { z } from "zod";
import type { ArtifactStorage } from "./artifact-storage";
import type { AgentConfig } from "./config";
import { mcpRequestContext, type ProgressNotification } from "./request-context";
import { LocalCommsStore } from "./store";
import { createCommunicationTools } from "./tools";

/**
 * The subset of the MCP SDK's `RequestHandlerExtra` that we forward to tool
 * handlers. Typed structurally so we don't couple to the SDK's generic shape.
 */
interface McpToolCallExtra {
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
  _meta?: { progressToken?: string | number };
  signal?: AbortSignal;
}

type BeeAiToolRegistrar = (
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: z.ZodTypeAny;
  },
  callback: (input: unknown, extra?: McpToolCallExtra) => Promise<CallToolResult>,
) => unknown;

export function createLocalCommsMcpServer(
  store: LocalCommsStore,
  agent: AgentConfig,
  artifactStorage?: ArtifactStorage,
): McpServer {
  const server = new McpServer(
    {
      name: "agent-mailbox",
      version: "0.1.0",
    },
    {
      instructions:
        [
          "Use Agent Mailbox tools to coordinate with local AI agents through a shared mailbox.",
          "At the start of each work session, call session_start before reading code, editing files, or claiming work; it refreshes presence and returns unread messages, tasks, advisory locks, pinned notes, and stale claims.",
          "This server is pull-based: agents only see changes when they call inbox, watch_updates, session_start, list_tasks, or related tools.",
          "Before editing a shared file or module, call acquire_lock for that resource; these locks are cooperative advisory leases, not filesystem locks, so respect active locks owned by other agents.",
          "Release locks with release_lock when finished and renew long work with heartbeat or acquire_lock.",
          "When handing off work, attach artifacts for the relevant files, URLs, diffs, screenshots, logs, commands, or uploaded S3-backed content.",
          "When finishing, blocking, or cancelling a task, call update_task with a specific note; creator notifications for done, blocked, and cancelled are sent automatically.",
          "Treat stale claimed tasks as reclaim candidates only after checking recent presence and message context.",
          "Use a distinct workspace per repository or project so unrelated agents do not share task, note, message, and lock state.",
        ].join(" "),
    },
  );

  registerBeeAiTools(server, createCommunicationTools(store, agent, artifactStorage));
  registerResources(server, store, agent);
  return server;
}

export function registerBeeAiTools(server: McpServer, tools: AnyTool[]): void {
  const registerTool = server.registerTool.bind(server) as BeeAiToolRegistrar;
  for (const tool of tools) {
    const inputSchema = tool.inputSchema() as z.ZodTypeAny;
    const callback = async (
      input: unknown,
      extra?: McpToolCallExtra,
    ): Promise<CallToolResult> => {
      // Expose per-request MCP capabilities (progress notifications, the client
      // progress token, and the abort signal) to the tool handler via
      // AsyncLocalStorage. beeai's DynamicTool handler signature does not
      // forward the MCP `extra`, so a blocking tool (ask_human) reads it from
      // this scope to emit keepalive bytes on the held-open response stream.
      return mcpRequestContext.run(
        {
          sendNotification: extra?.sendNotification
            ? (notification) => extra.sendNotification!(notification)
            : undefined,
          progressToken: extra?._meta?.progressToken,
          signal: extra?.signal,
        },
        async () => {
          try {
            const output = (await tool.run(input)) as JSONToolOutput<unknown>;
            return {
              structuredContent: output.result as Record<string, unknown>,
              content: [
                {
                  type: "text",
                  text: output.getTextContent(),
                },
              ],
            };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: errorMessage(error),
                },
              ],
            };
          }
        },
      );
    };
    registerTool(
      tool.name,
      {
        title: tool.name,
        description: tool.description,
        inputSchema,
      },
      callback,
    );
  }
}

function registerResources(server: McpServer, store: LocalCommsStore, agent: AgentConfig): void {
  const workspace = agent.workspace || "default";
  server.registerResource(
    "agents",
    "local-comms://agents",
    {
      title: "Local AI Agents",
      description: "Registered local AI agents for this mailbox.",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri.toString(), { agents: await store.listAgents(workspace) }),
  );

  server.registerResource(
    "open-tasks",
    "local-comms://tasks/open",
    {
      title: "Open Tasks",
      description: "Open handoff tasks visible to this agent.",
      mimeType: "application/json",
    },
    async (uri) =>
      jsonResource(uri.toString(), {
        tasks: await store.listTasks(agent.id, { workspace, status: "open", limit: 200 }),
      }),
  );

  server.registerResource(
    "active-locks",
    "local-comms://locks/active",
    {
      title: "Active Locks",
      description: "Active workspace-scoped locks.",
      mimeType: "application/json",
    },
    async (uri) => jsonResource(uri.toString(), { locks: await store.listLocks({ workspace }) }),
  );

  server.registerResource(
    "pinned-notes",
    "local-comms://notes/pinned",
    {
      title: "Pinned Notes",
      description: "Pinned scratchpad notes in this workspace.",
      mimeType: "application/json",
    },
    async (uri) =>
      jsonResource(uri.toString(), {
        notes: await store.readNotes({ workspace, pinnedOnly: true, limit: 200 }),
      }),
  );

  server.registerResource(
    "channel",
    new ResourceTemplate("local-comms://channels/{channel}", { list: undefined }),
    {
      title: "Channel Messages",
      description: "Recent messages for a workspace channel.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const channel = String((variables as Record<string, string>).channel);
      return jsonResource(uri.toString(), {
        messages: await store.inbox(agent.id, {
          workspace,
          channel,
          includeSent: true,
          limit: 100,
        }),
      });
    },
  );
}

function jsonResource(uri: string, value: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    // beeai-framework wraps tool handler errors in a generic ToolError
    // (FrameworkError extends AggregateError). Surface the root cause so
    // callers get the actionable message (e.g. "Invalid assignee_id ...")
    // instead of "Tool 'update_task' has occurred an error!".
    const cause = error.errors?.[0];
    if (cause instanceof Error && cause.message) {
      return errorMessage(cause);
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
