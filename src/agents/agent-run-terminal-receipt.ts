import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { redactSensitiveText } from "../logging/redact.js";

type AgentRunTerminalModelRef = { provider: string; model: string };

const AGENT_RUN_ROUTE_CHANGE_MAX_CHARS = 320;

export type AgentRunTerminalReceipt = {
  runId: string;
  sessionId: string;
  turnId: string;
  requested: AgentRunTerminalModelRef;
  effective: AgentRunTerminalModelRef & { responseModel: string };
  successfulToolNames: string[];
  /** A final reply was delivered to the external source conversation. */
  sourceReplyDelivered?: true;
  rerouted: boolean;
  terminalDisposition: "visible" | "not-visible";
};

export function normalizeAgentRunTerminalReceipt(
  value: unknown,
): AgentRunTerminalReceipt | undefined {
  const receipt = value as AgentRunTerminalReceipt | undefined;
  return receipt &&
    typeof receipt.runId === "string" &&
    typeof receipt.sessionId === "string" &&
    typeof receipt.turnId === "string" &&
    receipt.requested &&
    receipt.effective &&
    Array.isArray(receipt.successfulToolNames)
    ? receipt
    : undefined;
}

function formatAgentRunModelRef(value: AgentRunTerminalModelRef): string | undefined {
  const route = redactSensitiveText(`${value.provider}/${value.model}`, { mode: "tools" })
    .replace(/\s+/gu, " ")
    .trim();
  return route ? truncateUtf16Safe(route, 128) : undefined;
}

/** Normalizes the producer-owned route fact before lifecycle or prompt use. */
export function normalizeAgentRunRouteChange(value: unknown): string | undefined {
  const normalized =
    typeof value === "string"
      ? redactSensitiveText(value, { mode: "tools" }).replace(/\s+/gu, " ").trim()
      : "";
  return normalized ? truncateUtf16Safe(normalized, AGENT_RUN_ROUTE_CHANGE_MAX_CHARS) : undefined;
}

/** Formats the bounded, secret-free route fact owned by a terminal receipt. */
export function formatAgentRunRouteChange(
  receipt: AgentRunTerminalReceipt | undefined,
  expectedRunId: string,
): string | undefined {
  if (
    receipt?.runId !== expectedRunId ||
    !receipt.rerouted ||
    receipt.terminalDisposition !== "visible"
  ) {
    return undefined;
  }
  const requested = formatAgentRunModelRef(receipt.requested);
  const effective = formatAgentRunModelRef({
    ...receipt.effective,
    model: receipt.effective.responseModel || receipt.effective.model,
  });
  return requested && effective ? `Model route changed: ${requested} → ${effective}.` : undefined;
}
