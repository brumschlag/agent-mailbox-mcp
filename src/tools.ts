import { DynamicTool, JSONToolOutput, type AnyTool } from "beeai-framework/tools/base";
import { z } from "zod";
import {
  DisabledArtifactStorage,
  MAX_ARTIFACT_READ_BYTES,
  type ArtifactStorage,
} from "./artifact-storage";
import type { AgentConfig } from "./config";
import { currentMcpRequestContext } from "./request-context";
import {
  buildNextActions,
  buildSessionSummary,
  coordinationConventions,
  recommendedSessionSteps,
} from "./session";
import { LocalCommsStore, type MessageRecord, type TaskStatus } from "./store";

const metadataSchema = z.record(z.string(), z.unknown()).optional();
const workspaceSchema = z.string().min(1).optional();
const dateRangeFields = {
  since: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional ISO-8601 timestamp; only records at or after this instant are returned.",
    ),
  until: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional ISO-8601 timestamp; only records at or before this instant are returned.",
    ),
};
const taskStatusSchema = z.enum(["open", "claimed", "done", "blocked", "cancelled"]);
const artifactTypeSchema = z.enum(["file", "url", "diff", "screenshot", "log", "command", "other"]);
const artifactSchema = z.object({
  type: artifactTypeSchema,
  label: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  line: z.number().int().min(1).optional(),
  metadata: metadataSchema,
});
const artifactOwnerSchema = z.enum(["message", "task", "note"]);
const artifactEncodingSchema = z.enum(["text", "base64"]);

function communicationTool<Schema extends z.ZodTypeAny, Output>(fields: {
  name: string;
  description: string;
  inputSchema: Schema;
  handler: (input: z.output<Schema>) => Promise<JSONToolOutput<Output>>;
}): AnyTool {
  return new DynamicTool<JSONToolOutput<Output>, Schema>({
    name: fields.name,
    description: fields.description,
    inputSchema: fields.inputSchema,
    handler: (input) => fields.handler(input),
  });
}

export function createCommunicationTools(
  store: LocalCommsStore,
  agent: AgentConfig,
  artifactStorage?: ArtifactStorage,
): AnyTool[] {
  const storage = artifactStorage ?? new DisabledArtifactStorage();
  return [
    communicationTool({
      name: "session_start",
      description:
        "First tool to call at the start of a work session. It refreshes presence and returns unread messages, open tasks, stale claimed tasks, active advisory locks, pinned notes, online agents, and recommended next steps before code reading, editing, or task claiming begins.",
      inputSchema: z.object({
        name: z.string().min(1).optional(),
        workspace: workspaceSchema,
        status: z.string().min(1).optional(),
        current_task_id: z.string().min(1).optional(),
        metadata: metadataSchema,
        channel: z.string().min(1).optional(),
        stale_after_seconds: z.number().int().min(60).max(2_592_000).optional(),
        active_within_seconds: z.number().int().min(1).max(86_400).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      handler: async (input) => {
        const workspace = input.workspace ?? agent.workspace;
        const normalizedWorkspace = workspaceName(workspace);
        const channel = input.channel;
        const limit = input.limit;
        const currentAgent = await store.registerAgent({
          id: agent.id,
          name: input.name ?? agent.name,
          workspace,
          status: input.status,
          currentTaskId: input.current_task_id,
          metadata: input.metadata,
        });
        const [
          unreadMessages,
          openTasks,
          claimedTasks,
          staleClaimedTasks,
          activeLocks,
          pinnedNotes,
          onlineAgents,
        ] = await Promise.all([
          store.inbox(agent.id, {
            workspace,
            channel,
            unreadOnly: true,
            includeSent: false,
            limit,
          }),
          store.listTasks(agent.id, {
            workspace,
            channel,
            status: "open",
            limit,
          }),
          store.listTasks(agent.id, {
            workspace,
            channel,
            status: "claimed",
            assigneeId: agent.id,
            limit,
          }),
          store.listTasks(agent.id, {
            workspace,
            channel,
            staleAfterSeconds: input.stale_after_seconds ?? 3_600,
            limit,
          }),
          store.listLocks({ workspace }),
          store.readNotes({
            workspace,
            channel,
            pinnedOnly: true,
            limit,
          }),
          store.whoIsOnline(
            workspace,
            input.active_within_seconds,
          ),
        ]);
        const collections = {
          unreadMessages,
          openTasks,
          claimedTasks,
          staleClaimedTasks,
          activeLocks,
          pinnedNotes,
          onlineAgents,
        };

        return json({
          agent: currentAgent,
          workspace: normalizedWorkspace,
          checked_at: new Date().toISOString(),
          session_summary: buildSessionSummary(collections),
          next_actions: buildNextActions({
            agentId: agent.id,
            workspace: normalizedWorkspace,
            channel,
            collections,
          }),
          unread_messages: unreadMessages,
          open_tasks: openTasks,
          claimed_tasks: claimedTasks,
          stale_claimed_tasks: staleClaimedTasks,
          active_locks: activeLocks,
          pinned_notes: pinnedNotes,
          online_agents: onlineAgents,
          conventions: coordinationConventions,
          recommended_next_steps: recommendedSessionSteps,
        });
      },
    }),
    communicationTool({
      name: "register_agent",
      description:
        "Register or refresh the current local AI agent identity. Prefer session_start at the beginning of a work session because it also returns inbox, task, lock, and convention context.",
      inputSchema: z.object({
        name: z.string().min(1).optional(),
        workspace: workspaceSchema,
        status: z.string().min(1).optional(),
        current_task_id: z.string().min(1).optional(),
        metadata: metadataSchema,
      }),
      handler: async (input) =>
        json({
          agent: await store.registerAgent({
            id: agent.id,
            name: input.name ?? agent.name,
            workspace: input.workspace ?? agent.workspace,
            status: input.status,
            currentTaskId: input.current_task_id,
            metadata: input.metadata,
          }),
        }),
    }),
    communicationTool({
      name: "heartbeat",
      description:
        "Update current agent presence, status, current task, and last-seen timestamp during long work so claimed tasks do not look abandoned.",
      inputSchema: z.object({
        status: z.string().min(1).optional(),
        current_task_id: z.string().min(1).optional(),
        workspace: workspaceSchema,
        metadata: metadataSchema,
      }),
      handler: async (input) =>
        json({
          agent: await store.heartbeat({
            id: agent.id,
            name: agent.name,
            workspace: input.workspace ?? agent.workspace,
            status: input.status,
            currentTaskId: input.current_task_id,
            metadata: input.metadata,
          }),
        }),
    }),
    communicationTool({
      name: "agent_status",
      description: "Get the current registered status for this local agent.",
      inputSchema: z.object({}),
      handler: async () => json({ agent: await store.getAgent(agent.id, workspaceName(agent.workspace)) }),
    }),
    communicationTool({
      name: "list_agents",
      description:
        "List known local AI agents that have registered with this mailbox, optionally scoped to one workspace. Use offset and limit to page through large workspaces; total and has_more describe the full result set.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      handler: async (input) => {
        // Default limit at the tool layer: the store *Page methods keep "return
        // all when limit omitted" for internal callers (session_start, admin
        // API, MCP resources), but the MCP tool contract defaults to 50 like
        // the other 6 list tools.
        const page = await store.listAgentsPage(input.workspace, input.limit ?? 50, input.offset);
        return json({ agents: page.results, total: page.total, has_more: page.has_more });
      },
    }),
    communicationTool({
      name: "who_is_online",
      description:
        "List agents with a recent heartbeat in the current or requested workspace. Use this before reclaiming stale claimed tasks.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        active_within_seconds: z.number().int().min(1).max(86_400).optional(),
      }),
      handler: async (input) =>
        json({
          agents: await store.whoIsOnline(
            input.workspace ?? agent.workspace,
            input.active_within_seconds,
          ),
        }),
    }),
    communicationTool({
      name: "send_message",
      description:
        "Send a direct message to one agent or post a message to a local channel. Include artifacts for files, URLs, diffs, screenshots, logs, or commands that another agent should inspect.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        recipient_id: z.string().min(1).optional(),
        channel: z.string().min(1).optional(),
        thread_id: z.string().min(1).optional(),
        reply_to_message_id: z.string().min(1).optional(),
        body: z.string().min(1),
        metadata: metadataSchema,
        artifacts: z.array(artifactSchema).optional(),
      }),
      handler: async (input) =>
        json({
          message: await store.sendMessage({
            senderId: agent.id,
            workspace: input.workspace ?? agent.workspace,
            recipientId: input.recipient_id,
            channel: input.channel,
            threadId: input.thread_id,
            replyToMessageId: input.reply_to_message_id,
            body: input.body,
            metadata: input.metadata,
            artifacts: input.artifacts,
          }),
        }),
    }),
    communicationTool({
      name: "reply_message",
      description:
        "Reply to a visible direct or channel message while preserving its thread. Use this for handoff acknowledgements and completion notes tied to a message.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        message_id: z.string().min(1),
        body: z.string().min(1),
        metadata: metadataSchema,
        artifacts: z.array(artifactSchema).optional(),
      }),
      handler: async (input) =>
        json({
          message: await store.replyMessage({
            senderId: agent.id,
            workspace: input.workspace ?? agent.workspace,
            messageId: input.message_id,
            body: input.body,
            metadata: input.metadata,
            artifacts: input.artifacts,
          }),
        }),
    }),
    communicationTool({
      name: "inbox",
      description:
        "List unread or recent direct and channel messages visible to the current agent. Use unread_only for triage, then read_message after handling each item. Pass since/until (ISO-8601) to limit results to a date range without scanning the full inbox. Use offset and limit to page through a large inbox; total and has_more describe the full result set.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        unread_only: z.boolean().optional(),
        include_sent: z.boolean().optional(),
        channel: z.string().min(1).optional(),
        thread_id: z.string().min(1).optional(),
        ...dateRangeFields,
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      handler: async (input) => {
        const page = await store.inboxPage(agent.id, {
          workspace: input.workspace ?? agent.workspace,
          unreadOnly: input.unread_only,
          includeSent: input.include_sent,
          channel: input.channel,
          threadId: input.thread_id,
          since: input.since,
          until: input.until,
          limit: input.limit,
          offset: input.offset,
        });
        return json({ messages: page.results, total: page.total, has_more: page.has_more });
      },
    }),
    communicationTool({
      name: "read_message",
      description:
        "Fetch one visible message and mark it read for the current agent. Mark messages read only after the handoff or request has been handled or converted into a task.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        message_id: z.string().min(1),
      }),
      handler: async (input) =>
        json({
          message: await store.readMessage(agent.id, input.message_id, input.workspace ?? agent.workspace),
        }),
    }),
    communicationTool({
      name: "search_messages",
      description:
        "Search visible direct and channel message bodies when recovering old decisions, handoffs, or context. Use offset and limit to page through a large result set; total and has_more describe the full match set.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        query: z.string().min(1),
        channel: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      handler: async (input) => {
        const page = await store.searchMessagesPage(agent.id, {
          workspace: input.workspace ?? agent.workspace,
          query: input.query,
          channel: input.channel,
          limit: input.limit,
          offset: input.offset,
        });
        return json({ messages: page.results, total: page.total, has_more: page.has_more });
      },
    }),
    communicationTool({
      name: "list_threads",
      description:
        "List visible message threads in the current or requested workspace, ordered by recent activity. Pass since/until (ISO-8601) to limit threads to those containing messages within a date range. Use offset and limit to page through a large workspace; total and has_more describe the full result set.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        ...dateRangeFields,
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      handler: async (input) => {
        const page = await store.listThreadsPage(
          agent.id,
          input.workspace ?? agent.workspace,
          input.limit,
          input.offset,
          input.since,
          input.until,
        );
        return json({ threads: page.results, total: page.total, has_more: page.has_more });
      },
    }),
    communicationTool({
      name: "get_thread",
      description:
        "Return visible messages for one thread in chronological order so an agent can reconstruct a handoff conversation before acting. Use offset and limit to page through long threads; total and has_more describe the full message set for the thread.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        thread_id: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      handler: async (input) => {
        const page = await store.getThreadPage(
          agent.id,
          input.thread_id,
          input.workspace ?? agent.workspace,
          input.limit,
          input.offset,
        );
        return json({ messages: page.results, total: page.total, has_more: page.has_more });
      },
    }),
    communicationTool({
      name: "watch_updates",
      description:
        "Poll for new messages, tasks, task events, notes, or locks since a timestamp. This is pull-based long polling; it does not wake sleeping agents by itself.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        since: z.string().min(1).optional(),
        timeout_ms: z.number().int().min(0).max(60_000).optional(),
        interval_ms: z.number().int().min(100).max(5_000).optional(),
      }),
      handler: async (input) => {
        const timeoutMs = input.timeout_ms ?? 0;
        const intervalMs = input.interval_ms ?? 500;
        const deadline = Date.now() + timeoutMs;
        let updates = await store.updatesSince(agent.id, input.workspace ?? agent.workspace, input.since);
        while (!hasUpdates(updates) && Date.now() < deadline) {
          await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
          updates = await store.updatesSince(agent.id, input.workspace ?? agent.workspace, input.since);
        }
        return json({ updates });
      },
    }),
    communicationTool({
      name: "ask_human",
      description:
        "Ask a human a question and BLOCK until they reply, then return the reply. Posts the question as a direct message to a human recipient (default 'local-brian'), then long-polls the mailbox for the human's reply in the same thread, up to timeout_ms (default 5 minutes, max 10 minutes). The call keeps its connection alive during the wait by emitting periodic progress notifications, so a multi-minute wait does not drop. Returns answered=false with no reply if the timeout elapses first; the human can still reply later and you can re-check the thread. Use this for human-in-the-loop approvals, clarifying questions, or decisions only a human can make.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        question: z.string().min(1),
        recipient_id: z.string().min(1).optional(),
        timeout_ms: z.number().int().min(0).max(600_000).optional(),
        poll_interval_ms: z.number().int().min(100).max(60_000).optional(),
      }),
      handler: async (input) => {
        const workspace = input.workspace ?? agent.workspace;
        const recipientId = input.recipient_id ?? "local-brian";
        const timeoutMs = input.timeout_ms ?? 300_000;
        const pollIntervalMs = input.poll_interval_ms ?? 2_000;
        const keepaliveIntervalMs = 10_000;

        // Post the question as a direct message. Its own id seeds the thread,
        // so a human reply (reply_message / send_message with reply_to or
        // thread_id) lands in the same thread addressed back to this agent.
        const question = await store.sendMessage({
          senderId: agent.id,
          workspace,
          recipientId,
          body: input.question,
          metadata: { event_type: "ask_human", recipient_id: recipientId },
        });
        const questionId = question.id;
        const threadId = question.thread_id;

        const ctx = currentMcpRequestContext();
        let keepaliveCount = 0;
        const emitKeepalive = async (): Promise<void> => {
          if (!ctx?.sendNotification || ctx.signal?.aborted) {
            return;
          }
          keepaliveCount += 1;
          try {
            await ctx.sendNotification({
              method: "notifications/progress",
              params: {
                // Prefer the client's own progress token so the client
                // associates and displays the update; fall back to a synthetic
                // token purely so the notification (and thus keepalive bytes)
                // still flows when the caller did not request progress.
                progressToken: ctx.progressToken ?? `ask_human:${questionId}`,
                progress: keepaliveCount,
                message: `Waiting for ${recipientId} to reply to ask_human…`,
              },
            });
          } catch {
            // A keepalive failure (e.g. connection already gone) must not fail
            // the tool; the poll loop will observe the aborted signal / timeout.
          }
        };

        const findReply = async (): Promise<MessageRecord | null> =>
          firstHumanReply(
            await store.getThread(agent.id, threadId, workspace, 200, 0),
            agent.id,
            questionId,
          );

        // Emit an initial keepalive immediately so the first byte reaches the
        // client well before any idle-timeout window, then poll.
        await emitKeepalive();
        let lastKeepalive = Date.now();
        const deadline = Date.now() + timeoutMs;

        let reply = await findReply();
        while (!reply && Date.now() < deadline) {
          if (ctx?.signal?.aborted) {
            break;
          }
          if (Date.now() - lastKeepalive >= keepaliveIntervalMs) {
            await emitKeepalive();
            lastKeepalive = Date.now();
          }
          const untilKeepalive = lastKeepalive + keepaliveIntervalMs - Date.now();
          const untilDeadline = deadline - Date.now();
          const waitMs = Math.max(0, Math.min(pollIntervalMs, untilKeepalive, untilDeadline));
          await sleep(waitMs);
          reply = await findReply();
        }

        return json({
          answered: Boolean(reply),
          question_id: questionId,
          keepalives_sent: keepaliveCount,
          reply: reply
            ? { message_id: reply.id, sender_id: reply.sender_id, body: reply.body }
            : undefined,
        });
      },
    }),
    communicationTool({
      name: "ask_human_async",
      description:
        "Ask a human a question WITHOUT blocking, then finish your run. Posts the question as a direct message to a human recipient (default 'local-brian') and returns IMMEDIATELY with question_id + thread_id — it does NOT wait for a reply. This is the escalate-and-resume pattern (architecture ②): post the question, exit your run, and a watcher spawns a continuation run carrying the human's answer once they reply. Prefer this over any long blocking wait — a single MCP tool call cannot be held open past ~120s in a headless run, so blocking for a human is unreliable. Pass resume_context to describe where you were, and continuation_task to name the kelos resource the watcher should resume.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        question: z.string().min(1),
        recipient_id: z.string().min(1).optional(),
        resume_context: z.string().min(1).optional(),
        continuation_task: z.string().min(1).optional(),
      }),
      handler: async (input) => {
        const workspace = input.workspace ?? agent.workspace;
        const recipientId = input.recipient_id ?? "local-brian";
        // Post the question as a direct message. Its own id seeds the thread so
        // a later human reply (reply_message / send_message with reply_to or
        // thread_id) lands in the same thread addressed back to this agent, and
        // the asker — or a continuation run acting as the asker — can read it
        // via get_thread. No poll loop: the call returns at once and the run
        // exits; a watcher resumes work when the reply arrives (architecture ②).
        const question = await store.sendMessage({
          senderId: agent.id,
          workspace,
          recipientId,
          body: input.question,
          metadata: {
            event_type: "ask_human",
            mode: "async",
            recipient_id: recipientId,
            asker_id: agent.id,
            ...(input.resume_context ? { resume_context: input.resume_context } : {}),
            ...(input.continuation_task ? { continuation_task: input.continuation_task } : {}),
          },
        });
        return json({
          posted: true,
          question_id: question.id,
          thread_id: question.thread_id,
          recipient_id: recipientId,
        });
      },
    }),
    communicationTool({
      name: "create_task",
      description:
        "Create a claimable handoff task for local AI coordination. Provide clear acceptance criteria and attach relevant artifacts so another agent can resume without guessing.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        title: z.string().min(1),
        description: z.string().optional(),
        assignee_id: z.string().min(1).optional(),
        channel: z.string().min(1).optional(),
        priority: z.number().int().min(-100).max(100).optional(),
        due_at: z.string().min(1).optional(),
        parent_task_id: z.string().min(1).optional(),
        blocked_reason: z.string().min(1).optional(),
        dependencies: z.array(z.string().min(1)).optional(),
        metadata: metadataSchema,
        artifacts: z.array(artifactSchema).optional(),
      }),
      handler: async (input) =>
        json({
          task: await store.createTask({
            creatorId: agent.id,
            workspace: input.workspace ?? agent.workspace,
            title: input.title,
            description: input.description,
            assigneeId: input.assignee_id,
            channel: input.channel,
            priority: input.priority,
            dueAt: input.due_at,
            parentTaskId: input.parent_task_id,
            blockedReason: input.blocked_reason,
            dependencies: input.dependencies,
            metadata: input.metadata,
            artifacts: input.artifacts,
          }),
        }),
    }),
    communicationTool({
      name: "create_handoff",
      description:
        "Create a claimable task and, when requested, send a notification message in one workflow call. Use this for complete handoffs with acceptance criteria and artifacts.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        title: z.string().min(1),
        description: z.string().optional(),
        assignee_id: z.string().min(1).optional(),
        channel: z.string().min(1).optional(),
        priority: z.number().int().min(-100).max(100).optional(),
        due_at: z.string().min(1).optional(),
        parent_task_id: z.string().min(1).optional(),
        blocked_reason: z.string().min(1).optional(),
        dependencies: z.array(z.string().min(1)).optional(),
        metadata: metadataSchema,
        artifacts: z.array(artifactSchema).optional(),
        notification_recipient_id: z.string().min(1).optional(),
        notification_channel: z.string().min(1).optional(),
        notification_body: z.string().min(1).optional(),
        notification_metadata: metadataSchema,
        notification_artifacts: z.array(artifactSchema).optional(),
      }),
      handler: async (input) => {
        const notificationRequested = Boolean(
          input.notification_recipient_id ||
            input.notification_channel ||
            input.notification_body,
        );
        const notificationRecipientId =
          input.notification_recipient_id ??
          (notificationRequested && !input.notification_channel ? input.assignee_id : undefined);
        const notificationChannel =
          input.notification_channel ??
          (notificationRequested && !notificationRecipientId ? input.channel : undefined);
        if (
          notificationRequested &&
          Boolean(notificationRecipientId) === Boolean(notificationChannel)
        ) {
          throw new Error(
            "create_handoff notification requires exactly one destination: notification_recipient_id, notification_channel, assignee_id, or channel.",
          );
        }

        const task = await store.createTask({
          creatorId: agent.id,
          workspace: input.workspace ?? agent.workspace,
          title: input.title,
          description: input.description,
          assigneeId: input.assignee_id,
          channel: input.channel,
          priority: input.priority,
          dueAt: input.due_at,
          parentTaskId: input.parent_task_id,
          blockedReason: input.blocked_reason,
          dependencies: input.dependencies,
          metadata: input.metadata,
          artifacts: input.artifacts,
        });
        const notificationMessage = notificationRequested
          ? await store.sendMessage({
              senderId: agent.id,
              workspace: input.workspace ?? agent.workspace,
              recipientId: notificationRecipientId,
              channel: notificationChannel,
              body: input.notification_body ?? `Handoff created: ${task.title} (${task.id})`,
              metadata: {
                ...(input.notification_metadata ?? {}),
                event_type: "handoff_created",
                task_id: task.id,
              },
              artifacts: input.notification_artifacts ?? input.artifacts,
            })
          : null;

        return json({
          task,
          notification_message: notificationMessage,
        });
      },
    }),
    communicationTool({
      name: "list_tasks",
      description:
        "List visible tasks by status, assignee, creator, channel, parent, recency, or stale claim age. Pass since/until (ISO-8601) to limit tasks to those last updated within a date range. Use stale_after_seconds to find claimed tasks, then check recent presence and message context before reclaiming or reassigning. Use offset and limit to page through a large task list; total and has_more describe the full result set.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        status: taskStatusSchema.optional(),
        assignee_id: z.string().min(1).optional(),
        creator_id: z.string().min(1).optional(),
        channel: z.string().min(1).optional(),
        parent_task_id: z.string().min(1).optional(),
        stale_after_seconds: z.number().int().min(60).max(2_592_000).optional(),
        ...dateRangeFields,
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      handler: async (input) => {
        const page = await store.listTasksPage(agent.id, {
          workspace: input.workspace ?? agent.workspace,
          status: input.status as TaskStatus | undefined,
          assigneeId: input.assignee_id,
          creatorId: input.creator_id,
          channel: input.channel,
          parentTaskId: input.parent_task_id,
          staleAfterSeconds: input.stale_after_seconds,
          since: input.since,
          until: input.until,
          limit: input.limit,
          offset: input.offset,
        });
        return json({ tasks: page.results, total: page.total, has_more: page.has_more });
      },
    }),
    communicationTool({
      name: "get_task",
      description:
        "Fetch a single visible task by ID with its artifacts, dependency IDs, and recent audit events in one read-only call. Returns the same { task, events } shape as update_task and finish_work, so a known task ID can be inspected without list_tasks round trips. Visibility follows the workspace scoping of the caller's access token: a task is returned only when the caller is its creator, its assignee, an assignee-less open task, or a member of the task's channel, all within the caller's workspace. If the task does not exist or is not visible to the caller, a not-found error is returned and no task data leaks across workspaces. No audit or progress events are written; this is a pure read.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        task_id: z.string().min(1),
      }),
      handler: async (input) => {
        const workspace = input.workspace ?? agent.workspace;
        const task = await store.getVisibleTask(agent.id, input.task_id, workspace);
        if (!task) {
          throw new Error(
            `Task '${input.task_id}' is not visible to agent '${agent.id}'.`,
          );
        }
        return json({
          task,
          events: await store.listVisibleTaskEvents(agent.id, input.task_id, workspace),
        });
      },
    }),
    communicationTool({
      name: "claim_task",
      description:
        "Atomically claim an open task for the current agent. Claim only work you intend to start now, and follow with heartbeat during long-running work.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        task_id: z.string().min(1),
        note: z.string().optional(),
      }),
      handler: async (input) =>
        json({
          task: await store.claimTask(agent.id, input.task_id, input.note, input.workspace ?? agent.workspace),
        }),
    }),
    communicationTool({
      name: "update_task",
      description:
        "Update a task's status and editable fields with partial-update semantics: omitted fields are left unchanged. Editable fields are title, description, assignee_id, channel, parent_task_id, dependencies (array of task IDs), priority, due_at, blocked_reason, status, and artifacts. Use assignee_id to directly assign or reassign a task to a specific agent (an alternative to claim_task). Pass dependencies as the full replacement set: [] clears dependencies, omitting leaves them unchanged; each dependency id must reference an existing task in the same workspace. Pass null for assignee_id, channel, parent_task_id, due_at, or blocked_reason to clear them. Invalid assignee_id or parent_task_id references return an error; channel is freeform text (empty/whitespace clears to null). Done, blocked, and cancelled updates from another agent automatically notify the task creator, so include a concrete completion or blocking note.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        task_id: z.string().min(1),
        status: taskStatusSchema.optional(),
        note: z.string().optional(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        assignee_id: z.string().min(1).nullable().optional(),
        channel: z.string().min(1).nullable().optional(),
        parent_task_id: z.string().min(1).nullable().optional(),
        dependencies: z.array(z.string().min(1)).optional(),
        priority: z.number().int().min(-100).max(100).optional(),
        due_at: z.string().min(1).nullable().optional(),
        blocked_reason: z.string().min(1).nullable().optional(),
        artifacts: z.array(artifactSchema).optional(),
      }),
      handler: async (input) =>
        json({
          task: await store.updateTask({
            agentId: agent.id,
            workspace: input.workspace ?? agent.workspace,
            taskId: input.task_id,
            status: input.status as TaskStatus | undefined,
            note: input.note,
            title: input.title,
            description: input.description,
            assigneeId: input.assignee_id,
            channel: input.channel,
            parentTaskId: input.parent_task_id,
            dependencies: input.dependencies,
            priority: input.priority,
            dueAt: input.due_at,
            blockedReason: input.blocked_reason,
            artifacts: input.artifacts,
          }),
          events: await store.listVisibleTaskEvents(
            agent.id,
            input.task_id,
            input.workspace ?? agent.workspace,
          ),
        }),
    }),
    communicationTool({
      name: "finish_work",
      description:
        "Finish or block a task, attach completion evidence, optionally send a handoff note, and release selected locks in one cleanup workflow.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        task_id: z.string().min(1),
        status: taskStatusSchema.optional(),
        note: z.string().optional(),
        priority: z.number().int().min(-100).max(100).optional(),
        due_at: z.string().min(1).nullable().optional(),
        blocked_reason: z.string().min(1).nullable().optional(),
        artifacts: z.array(artifactSchema).optional(),
        release_locks: z.array(z.string().min(1)).optional(),
        handoff_recipient_id: z.string().min(1).optional(),
        handoff_channel: z.string().min(1).optional(),
        handoff_body: z.string().min(1).optional(),
        handoff_metadata: metadataSchema,
        handoff_artifacts: z.array(artifactSchema).optional(),
      }),
      handler: async (input) => {
        const handoffRequested = Boolean(
          input.handoff_recipient_id ||
            input.handoff_channel ||
            input.handoff_body,
        );
        if (
          input.handoff_recipient_id &&
          input.handoff_channel
        ) {
          throw new Error(
            "finish_work handoff requires at most one destination: handoff_recipient_id or handoff_channel.",
          );
        }

        const status = input.status ?? "done";
        const task = await store.updateTask({
          agentId: agent.id,
          workspace: input.workspace ?? agent.workspace,
          taskId: input.task_id,
          status: status as TaskStatus,
          note: input.note,
          priority: input.priority,
          dueAt: input.due_at,
          blockedReason: input.blocked_reason,
          artifacts: input.artifacts,
        });
        const events = await store.listVisibleTaskEvents(
          agent.id,
          input.task_id,
          input.workspace ?? agent.workspace,
        );
        const releasedLocks = [];
        const releaseErrors = [];
        for (const resource of input.release_locks ?? []) {
          try {
            releasedLocks.push(
              await store.releaseLock(agent.id, resource, input.workspace ?? agent.workspace),
            );
          } catch (error) {
            releaseErrors.push({
              resource,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        const handoffRecipientId =
          input.handoff_recipient_id ??
          (!input.handoff_channel && task.creator_id !== agent.id ? task.creator_id : undefined);
        const handoffChannel =
          input.handoff_channel ??
          (!handoffRecipientId ? task.channel ?? undefined : undefined);
        const handoffMessage =
          handoffRequested && (handoffRecipientId || handoffChannel)
            ? await store.sendMessage({
                senderId: agent.id,
                workspace: input.workspace ?? agent.workspace,
                recipientId: handoffRecipientId,
                channel: handoffChannel,
                body: input.handoff_body ?? `Task ${status}: ${task.title} (${task.id})`,
                metadata: {
                  ...(input.handoff_metadata ?? {}),
                  event_type: "finish_work_handoff",
                  task_id: task.id,
                  status,
                },
                artifacts: input.handoff_artifacts ?? input.artifacts,
              })
            : null;

        return json({
          task,
          events,
          released_locks: releasedLocks,
          release_errors: releaseErrors,
          handoff_message: handoffMessage,
          handoff_skipped_reason:
            handoffRequested && !handoffMessage
              ? "No handoff destination was available."
              : undefined,
        });
      },
    }),
    communicationTool({
      name: "list_task_events",
      description:
        "Read a task's audit event log (creation, claims, status changes, and field updates) without mutating the task. Use this to reason about a task's history and progress instead of relying on update_task or finish_work side effects. Events are ordered oldest-first (created_at ascending); use offset and limit to page through long histories; total and has_more describe the full event set for the task. Only events for tasks visible to the current agent are returned; a non-existent or invisible task returns an error.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        task_id: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      handler: async (input) => {
        const page = await store.listVisibleTaskEventsPage(agent.id, input.task_id, {
          workspace: input.workspace ?? agent.workspace,
          limit: input.limit,
          offset: input.offset,
        });
        return json({ events: page.results, total: page.total, has_more: page.has_more });
      },
    }),
    communicationTool({
      name: "write_note",
      description:
        "Write or update a shared scratchpad note in a workspace or channel. Pin durable conventions, ownership rules, and project context that every agent should see. When updating an existing note, artifacts default to APPEND: newly passed artifacts are added to the note's existing ones, and existing attachments are preserved unless you set replace_artifacts=true. Re-passing an artifact that is already attached is a no-op. Gotcha: if you want your `artifacts` argument to fully overwrite the note's attachments on update, you must pass replace_artifacts=true; otherwise anything you omit is kept.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        note_id: z.string().min(1).optional(),
        channel: z.string().min(1).optional(),
        title: z.string().min(1),
        body: z.string().min(1),
        pinned: z.boolean().optional(),
        metadata: metadataSchema,
        artifacts: z.array(artifactSchema).optional(),
        replace_artifacts: z
          .boolean()
          .optional()
          .describe(
            "Only affects updates of an existing note. Default false (append): passed artifacts are added to existing ones and existing attachments are kept. Set true to fully replace the note's artifact set with the passed `artifacts`. Ignored when creating a new note.",
          ),
      }),
      handler: async (input) =>
        json({
          note: await store.writeNote({
            agentId: agent.id,
            workspace: input.workspace ?? agent.workspace,
            noteId: input.note_id,
            channel: input.channel,
            title: input.title,
            body: input.body,
            pinned: input.pinned,
            metadata: input.metadata,
            artifacts: input.artifacts,
            replaceArtifacts: input.replace_artifacts,
          }),
        }),
    }),
    communicationTool({
      name: "read_notes",
      description:
        "Read shared scratchpad notes by workspace, channel, pin state, or search query. Pass since/until (ISO-8601) to limit notes to those last updated within a date range. Check pinned notes before starting work in an unfamiliar workspace. Use offset and limit to page through a large note set; total and has_more describe the full result set.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        channel: z.string().min(1).optional(),
        pinned_only: z.boolean().optional(),
        query: z.string().min(1).optional(),
        ...dateRangeFields,
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      handler: async (input) => {
        const page = await store.readNotesPage({
          workspace: input.workspace ?? agent.workspace,
          channel: input.channel,
          pinnedOnly: input.pinned_only,
          query: input.query,
          since: input.since,
          until: input.until,
          limit: input.limit,
          offset: input.offset,
        });
        return json({ notes: page.results, total: page.total, has_more: page.has_more });
      },
    }),
    communicationTool({
      name: "pin_note",
      description:
        "Pin or unpin a shared scratchpad note. Pinned notes should hold durable workspace conventions rather than transient status.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        note_id: z.string().min(1),
        pinned: z.boolean(),
      }),
      handler: async (input) =>
        json({
          note: await store.pinNote(input.note_id, input.pinned, input.workspace ?? agent.workspace),
        }),
    }),
    communicationTool({
      name: "summarize_channel",
      description:
        "Return a compact structured digest of recent channel messages, tasks, and notes for quick orientation in a project channel.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        channel: z.string().min(1).optional(),
      }),
      handler: async (input) =>
        json({
          summary: await store.summarizeChannel(agent.id, input.workspace ?? agent.workspace, input.channel),
        }),
    }),
    communicationTool({
      name: "upload_artifact",
      description:
        "Upload artifact content to configured S3 storage, attach it to a visible message, task, or note, and return the created artifact reference.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        owner_type: artifactOwnerSchema,
        owner_id: z.string().min(1),
        type: artifactTypeSchema.optional(),
        label: z.string().min(1).optional(),
        filename: z.string().min(1).optional(),
        content_type: z.string().min(1).optional(),
        content_text: z.string().optional(),
        content_base64: z.string().optional(),
        url: z.string().min(1).optional(),
        metadata: metadataSchema,
      }),
      handler: async (input) => {
        const workspace = workspaceName(input.workspace ?? agent.workspace);
        await store.listVisibleArtifacts(agent.id, workspace, input.owner_type, input.owner_id);
        const artifactId = crypto.randomUUID();
        const artifactInput = await storage.artifactInputForUpload({
          artifactId,
          contentBase64: input.content_base64,
          contentText: input.content_text,
          contentType: input.content_type,
          filename: input.filename,
          label: input.label,
          metadata: input.metadata,
          ownerId: input.owner_id,
          ownerType: input.owner_type,
          permanentUrl: input.url,
          type: input.type ?? "file",
          workspace,
        });
        const artifact = await store.addVisibleArtifact(
          agent.id,
          workspace,
          input.owner_type,
          input.owner_id,
          artifactInput,
          artifactId,
        );
        return json({ artifact });
      },
    }),
    communicationTool({
      name: "read_artifact_content",
      description:
        "Read S3-backed artifact content for a visible message, task, or note. Text is returned by default; binary content can be returned as base64.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        owner_type: artifactOwnerSchema,
        owner_id: z.string().min(1),
        artifact_id: z.string().min(1),
        encoding: artifactEncodingSchema.optional(),
        max_bytes: z.number().int().min(1).max(MAX_ARTIFACT_READ_BYTES).optional(),
      }),
      handler: async (input) => {
        const artifact = await store.getVisibleArtifact(
          agent.id,
          input.workspace ?? agent.workspace,
          input.owner_type,
          input.owner_id,
          input.artifact_id,
        );
        return json({
          artifact_content: await storage.read(artifact, {
            encoding: input.encoding,
            maxBytes: input.max_bytes,
          }),
        });
      },
    }),
    communicationTool({
      name: "presign_artifact",
      description:
        "Return a short-lived presigned download URL for S3-backed artifact content attached to a visible message, task, or note.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        owner_type: artifactOwnerSchema,
        owner_id: z.string().min(1),
        artifact_id: z.string().min(1),
        expires_in_seconds: z.number().int().min(60).max(86_400).optional(),
      }),
      handler: async (input) => {
        const artifact = await store.getVisibleArtifact(
          agent.id,
          input.workspace ?? agent.workspace,
          input.owner_type,
          input.owner_id,
          input.artifact_id,
        );
        const expiresIn = input.expires_in_seconds ?? 900;
        return json({
          artifact,
          expires_in_seconds: expiresIn,
          url: storage.presign(artifact, expiresIn),
        });
      },
    }),
    communicationTool({
      name: "list_artifacts",
      description:
        "List structured artifact references attached to a message, task, or note so files, URLs, diffs, screenshots, logs, and commands are easy to resume from.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        owner_type: z.enum(["message", "task", "note"]),
        owner_id: z.string().min(1),
      }),
      handler: async (input) =>
        json({
          artifacts: await store.listVisibleArtifacts(
            agent.id,
            input.workspace ?? agent.workspace,
            input.owner_type,
            input.owner_id,
          ),
        }),
    }),
    communicationTool({
      name: "acquire_lock",
      description:
        "Acquire or renew a cooperative advisory workspace-scoped lease for a file, module, task, or other resource before editing. This does not lock the filesystem; if another agent owns an active lock, coordinate instead of overwriting.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        resource: z.string().min(1),
        purpose: z.string().min(1).optional(),
        ttl_seconds: z.number().int().min(1).max(86_400).optional(),
      }),
      handler: async (input) =>
        json({
          lock: await store.acquireLock({
            agentId: agent.id,
            workspace: input.workspace ?? agent.workspace,
            resource: input.resource,
            purpose: input.purpose,
            ttlSeconds: input.ttl_seconds,
          }),
        }),
    }),
    communicationTool({
      name: "release_lock",
      description:
        "Release a lock owned by the current agent after the edit or task is complete. Keep locks short-lived and renew them for long work.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        resource: z.string().min(1),
      }),
      handler: async (input) =>
        json({
          lock: await store.releaseLock(agent.id, input.resource, input.workspace ?? agent.workspace),
        }),
    }),
    communicationTool({
      name: "list_locks",
      description:
        "List active or expired workspace-scoped locks. Check this before editing shared files and include expired locks when auditing stale coordination state. Pass since/until (ISO-8601) to limit locks to those last updated within a date range. Use offset and limit to page through a large lock set; total and has_more describe the full result set.",
      inputSchema: z.object({
        workspace: workspaceSchema,
        resource: z.string().min(1).optional(),
        include_expired: z.boolean().optional(),
        ...dateRangeFields,
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      handler: async (input) => {
        const page = await store.listLocksPage({
          workspace: input.workspace ?? agent.workspace,
          resource: input.resource,
          includeExpired: input.include_expired,
          since: input.since,
          until: input.until,
          // Default limit at the tool layer: the store *Page methods keep
          // "return all when limit omitted" for internal callers, but the MCP
          // tool contract defaults to 50 like the other 6 list tools.
          limit: input.limit ?? 50,
          offset: input.offset,
        });
        return json({ locks: page.results, total: page.total, has_more: page.has_more });
      },
    }),
  ];
}

function json<T>(value: T): JSONToolOutput<T> {
  return new JSONToolOutput(value);
}

function hasUpdates(updates: {
  messages: unknown[];
  tasks: unknown[];
  task_events: unknown[];
  notes: unknown[];
  locks: unknown[];
}): boolean {
  return (
    updates.messages.length > 0 ||
    updates.tasks.length > 0 ||
    updates.task_events.length > 0 ||
    updates.notes.length > 0 ||
    updates.locks.length > 0
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Given the messages of an ask_human thread (chronological, oldest-first),
 * return the earliest message that qualifies as the human's reply: authored by
 * someone other than the asking agent, and either addressed back to the asking
 * agent or an explicit reply to the question message. Returns null when only the
 * question itself (or unrelated traffic) is present.
 */
function firstHumanReply(
  threadMessages: MessageRecord[],
  askingAgentId: string,
  questionId: string,
): MessageRecord | null {
  return (
    threadMessages.find(
      (message) =>
        message.id !== questionId &&
        message.sender_id !== askingAgentId &&
        (message.recipient_id === askingAgentId ||
          message.reply_to_message_id === questionId),
    ) ?? null
  );
}

function workspaceName(workspace: string | undefined): string {
  return workspace?.trim() || "default";
}
