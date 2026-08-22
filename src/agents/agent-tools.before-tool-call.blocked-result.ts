import { recordPreExecutionBlockedToolCall } from "./agent-tools.before-tool-call.state.js";
import type { HookBlockedReason } from "./agent-tools.before-tool-call.types.js";

const preExecutionBlockedToolResults = new WeakSet<object>();

export function isPreExecutionBlockedToolResult(result: unknown): boolean {
  return (
    result !== null && typeof result === "object" && preExecutionBlockedToolResults.has(result)
  );
}

/** Build the standard terminal result for vetoed tool calls. */
export function buildBlockedToolResult(params: {
  reason: string;
  deniedReason?: HookBlockedReason;
  toolCallId?: string;
  runId?: string;
}) {
  recordPreExecutionBlockedToolCall(params.toolCallId, params.runId);
  const result = {
    content: [{ type: "text" as const, text: params.reason }],
    details: {
      status: "blocked",
      deniedReason: params.deniedReason ?? "plugin-before-tool-call",
      reason: params.reason,
    },
  };
  preExecutionBlockedToolResults.add(result);
  return result;
}
