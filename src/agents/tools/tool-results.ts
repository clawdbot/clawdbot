import type { AgentToolResult } from "../runtime/index.js";

export function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function jsonResult<TDetails>(payload: TDetails): AgentToolResult<TDetails> {
  return textResult(JSON.stringify(payload, null, 2), payload);
}

/** Build a turn-handoff result for a tool declared with `executionMode: "sequential"`. */
export function yieldToolResult<TDetails>(params: {
  message: string;
  details: TDetails;
  text?: string;
}): AgentToolResult<TDetails> {
  return {
    ...textResult(params.text ?? JSON.stringify(params.details, null, 2), params.details),
    control: { type: "yield", message: params.message },
  };
}
