import type { AgentToolResult } from "@mariozechner/pi-agent-core";

export type CodexAppServerToolResultEvent = {
  threadId: string;
  turnId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: AgentToolResult<unknown>;
};

export type CodexAppServerExtensionContext = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
};

export type CodexAppServerToolResultHandlerResult = {
  result: AgentToolResult<unknown>;
};

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

export type CodexAppServerExtensionFactory = (
  runtime: CodexAppServerExtensionRuntime,
) => Promise<void> | void;
