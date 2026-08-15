import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

const ACP_TOOL_TERMINAL_OUTCOMES = {
  completed: "completed",
  done: "completed",
  failed: "failed",
  error: "failed",
  cancelled: "cancelled",
} as const;

type AcpToolTerminalOutcome =
  (typeof ACP_TOOL_TERMINAL_OUTCOMES)[keyof typeof ACP_TOOL_TERMINAL_OUTCOMES];

export function resolveAcpToolTerminalOutcome(status: unknown): AcpToolTerminalOutcome | undefined {
  const normalized = normalizeOptionalLowercaseString(status);
  if (!normalized || !Object.hasOwn(ACP_TOOL_TERMINAL_OUTCOMES, normalized)) {
    return undefined;
  }
  return ACP_TOOL_TERMINAL_OUTCOMES[normalized as keyof typeof ACP_TOOL_TERMINAL_OUTCOMES];
}
