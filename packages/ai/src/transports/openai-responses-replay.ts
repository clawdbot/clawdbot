import type { ReplayableResponseReasoningItem } from "./openai-responses-contracts.js";

/**
 * Parses a persisted thinkingSignature into a replayable Responses reasoning
 * item. Signatures are untrusted input: openai-completions plain-text
 * reasoning paths persist a provenance tag (e.g. "reasoning",
 * "reasoning_content") instead of a JSON-encoded reasoning item, and session
 * history or plugin providers can carry truncated or foreign JSON. Anything
 * that is not a JSON object is skipped (returns undefined) instead of
 * throwing, so one malformed history block cannot fail every later turn.
 */
export function parseResponsesReasoningSignature(
  signature: string | undefined,
): ReplayableResponseReasoningItem | undefined {
  if (!signature || !signature.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(signature);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ReplayableResponseReasoningItem;
    }
  } catch {
    // Fall through: malformed signatures skip the reasoning item.
  }
  return undefined;
}

/** Resolves the assistant message id that can be replayed to OpenAI Responses. */
export function resolveReplayableResponsesMessageId(params: {
  replayResponsesItemIds: boolean;
  textSignatureId?: string;
  fallbackId: string;
  fallbackOrdinal: number;
  previousReplayItemWasReasoning: boolean;
}): string | undefined {
  if (!params.replayResponsesItemIds) {
    return undefined;
  }
  if (!params.textSignatureId) {
    // Id-less text signatures get a deterministic synthetic id per fallback
    // ordinal; signed text can only replay when paired with preceding reasoning.
    return params.fallbackOrdinal === 0
      ? params.fallbackId
      : `${params.fallbackId}_${params.fallbackOrdinal}`;
  }
  return params.previousReplayItemWasReasoning ? params.textSignatureId : undefined;
}
