// Defines Codex app-server extension contracts exposed through plugins.
import type { AgentToolResult } from "../agents/runtime/index.js";

/** Tool-result event emitted to Codex app-server plugin extensions. */
export type CodexAppServerToolResultEvent = {
  threadId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: AgentToolResult<unknown>;
};

/** Session context passed with Codex app-server extension events. */
export type CodexAppServerExtensionContext = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
};

/** Optional replacement result returned by a Codex app-server extension handler. */
export type CodexAppServerToolResultHandlerResult = {
  result: AgentToolResult<unknown>;
};

/** Runtime event surface exposed to Codex app-server extension factories. */
export type CodexAppServerExtensionRuntime = {
  on: (
    event: "tool_result",
    handler: (
      event: CodexAppServerToolResultEvent,
      ctx: CodexAppServerExtensionContext,
    ) =>
      | Promise<CodexAppServerToolResultHandlerResult | void>
      | CodexAppServerToolResultHandlerResult
      | void,
  ) => void;
};

/** Factory signature for Codex app-server plugin extensions. */
export type CodexAppServerExtensionFactory = (
  runtime: CodexAppServerExtensionRuntime,
) => Promise<void> | void;
