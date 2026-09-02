import type { StopReason } from "../types.js";

export type OpenAIStopReasonResult = {
  stopReason: StopReason;
  errorMessage?: string;
};

export function mapOpenAIStopReason(
  reason: string | null,
  options?: { allowSingularToolCall?: boolean },
): OpenAIStopReasonResult {
  if (reason === null) {
    return { stopReason: "stop" };
  }

  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "tool_call":
      if (options?.allowSingularToolCall) {
        return { stopReason: "toolUse" };
      }
      break;
    case "content_filter":
      return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
    case "network_error":
      return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
  }

  return {
    stopReason: "error",
    errorMessage: `Provider finish_reason: ${reason}`,
  };
}
