/**
 * Normalizes Codex/OpenAI biological-policy blocks into the shared provider_refusal
 * terminal contract so model fallback cannot advance another candidate.
 *
 * Keep the prefix aligned with src/agents/failover/request-error-facets.ts.
 */
import { formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const BIOLOGICAL_RISK_PROVIDER_PREFIX = "this content was flagged for possible biological risk.";

export const CODEX_BIOLOGICAL_RISK_REFUSAL_CATEGORY = "biological_risk";

/** True when provider text is the stable Codex/OpenAI biological-policy refusal prefix. */
export function isCodexBiologicalRiskPolicyMessage(message: string): boolean {
  return normalizeLowercaseStringOrEmpty(message).startsWith(BIOLOGICAL_RISK_PROVIDER_PREFIX);
}

/** Reads a biological-policy refusal message from a promptError-like value. */
export function readCodexBiologicalRiskPolicyMessage(error: unknown): string | null {
  if (error == null) {
    return null;
  }
  const message = typeof error === "string" ? error : formatErrorMessage(error);
  const trimmed = message.trim();
  return trimmed && isCodexBiologicalRiskPolicyMessage(trimmed) ? trimmed : null;
}

/** Attaches the shared provider_refusal diagnostic that marks the attempt terminal. */
export function applyCodexBiologicalRiskRefusal(
  message: AssistantMessage,
  params: { provider: string; rawMessage: string },
): AssistantMessage {
  return {
    ...message,
    stopReason: "error",
    errorMessage: params.rawMessage,
    diagnostics: [
      ...(message.diagnostics ?? []),
      {
        type: "provider_refusal",
        timestamp: Date.now(),
        details: {
          provider: params.provider,
          category: CODEX_BIOLOGICAL_RISK_REFUSAL_CATEGORY,
        },
      },
    ],
  };
}
