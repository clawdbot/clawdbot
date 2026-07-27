// Copilot plugin module implements usage bridge behavior.
import type { AgentMessage, NormalizedUsage } from "openclaw/plugin-sdk/agent-harness-runtime";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type AssistantUsage = NonNullable<AssistantMessage["usage"]>;

type CopilotUsageSource = {
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
};

export type CopilotUsageSnapshot = NormalizedUsage;

function isCopilotUsageSource(data: unknown): data is CopilotUsageSource {
  return typeof data === "object" && data !== null;
}

function buildZeroCost(): AssistantUsage["cost"] {
  return {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
    total: 0,
  };
}

function coerceTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : undefined;
}

export function normalizeCopilotUsage(data: unknown): NormalizedUsage | undefined {
  if (!isCopilotUsageSource(data)) {
    return undefined;
  }

  // SDK usage events only expose these four fields. Keep coercion identical to
  // the prior event-bridge implementation so invalid object-shaped events still
  // overwrite state with the legacy all-zero snapshot.
  const input = coerceTokenCount(data.inputTokens);
  const output = coerceTokenCount(data.outputTokens);
  const cacheRead = coerceTokenCount(data.cacheReadTokens);
  const cacheWrite = coerceTokenCount(data.cacheWriteTokens);
  const total = (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);

  return {
    cacheRead,
    cacheWrite,
    input,
    output,
    total,
  };
}

export function buildCopilotAssistantUsage(params: {
  usage?: NormalizedUsage;
  fallbackOutputTokens?: unknown;
}): AssistantMessage["usage"] {
  const usage =
    params.usage ?? normalizeCopilotUsage({ outputTokens: params.fallbackOutputTokens });

  return {
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    cost: buildZeroCost(),
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    totalTokens: usage?.total ?? 0,
  };
}
