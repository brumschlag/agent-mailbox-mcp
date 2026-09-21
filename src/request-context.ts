import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A `notifications/progress` message. The MCP server permits progress
 * notifications unconditionally (no capability gate), and the SDK routes a
 * notification sent from a tool handler onto that request's held-open POST SSE
 * stream (via `relatedRequestId`). Emitting one mid-handler therefore writes
 * bytes to the wire, which is what keeps a long-blocking tool call from being
 * reset by idle proxies / clients.
 */
export interface ProgressNotification {
  method: "notifications/progress";
  params: {
    progressToken: string | number;
    progress: number;
    total?: number;
    message?: string;
  };
}

/**
 * Per-request MCP capabilities that the tool layer (beeai `DynamicTool`
 * handlers) cannot otherwise reach, because beeai's handler signature does not
 * forward the MCP `RequestHandlerExtra`. `registerBeeAiTools` populates this in
 * an `AsyncLocalStorage` scope around each tool invocation; a handler reads it
 * with {@link currentMcpRequestContext}.
 */
export interface McpRequestContext {
  /**
   * Sends a notification scoped to the in-flight request (the SDK attaches
   * `relatedRequestId` automatically). Undefined when the tool is invoked
   * outside an MCP request (e.g. direct unit tests that do not set a context).
   */
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
  /** The client-supplied progress token, when the caller opted into progress. */
  progressToken?: string | number;
  /** Aborts when the underlying HTTP connection/request goes away. */
  signal?: AbortSignal;
}

export const mcpRequestContext = new AsyncLocalStorage<McpRequestContext>();

export function currentMcpRequestContext(): McpRequestContext | undefined {
  return mcpRequestContext.getStore();
}
