import type { AgentToolResult } from "../../../packages/agent-core/src/types.js";

export function textResult<TDetails>(text: string, details: TDetails): AgentToolResult<TDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function jsonResult<TDetails>(payload: TDetails): AgentToolResult<TDetails> {
  return textResult(JSON.stringify(payload, null, 2), payload);
}
