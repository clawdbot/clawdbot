import type { ActiveMemoryMode } from "./types.js";

const RECALL_INTENT_PATTERNS = [
  /\b(?:previously|earlier|last time|used to)\b/iu,
  /\b(?:do|can|could|would)\s+you\s+(?:remember|recall)\b/iu,
  /\b(?:remember|recall)\s+(?:when|what|which|who|where|why|how)\b/iu,
  /\b(?:we|you|i)\s+(?:discussed|decided|agreed|said|talked about|chose)\b/iu,
  /\b(?:previous|earlier|past)\s+(?:decision|conversation|chat|discussion)\b/iu,
  /\b(?:yesterday|the other day|last (?:week|month|year)|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?|months?|years?)\s+ago)\b/iu,
  /\bwhat did (?:we|you|i)\b/iu,
  /\bwhat (?:do|did) i usually\b/iu,
  /\b(?:what|which|when|where|why|how)\s+(?:did|have|had)\s+(?:we|you|i)\s+(?:decide|choose|discuss|agree|say|mention|talk|use|do)\b/iu,
  /\b(?:did|have|had)\s+(?:we|you|i)\s+(?:decide|choose|discuss|agree|say|mention|talk)\b/iu,
  /\b(?:conversation|chat|discussion)s?\s+(?:from|in|during)\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|\d{4})\b/iu,
  /\b(?:summarize|review|find|search)\s+(?:my|our|the)?\s*(?:past|previous|earlier)?\s*(?:conversation|chat|discussion)s?\b/iu,
  /(?:¿?qué\s+(?:decidimos|hablamos)|\b(?:recuerdas|recordar|anteriormente|ayer)\b|(?<![\p{L}\p{N}_])última vez(?![\p{L}\p{N}_]))/iu,
  /\bremind\s+(?:me|us)\s+(?:what|which|who|where|why|how)\b/iu,
];

export function hasRecallIntent(message: string): boolean {
  const normalized = message.replace(/\s+/g, " ").trim();
  return (
    normalized.length > 0 && RECALL_INTENT_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

export function shouldEscalateRecall(params: {
  mode: ActiveMemoryMode;
  message: string;
  hasStrongLaneOneHit: boolean;
}): boolean {
  if (params.mode === "off") {
    return false;
  }
  if (params.mode === "always") {
    return true;
  }
  return !params.hasStrongLaneOneHit && hasRecallIntent(params.message);
}
