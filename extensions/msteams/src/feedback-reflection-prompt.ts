import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Max chars of the thumbed-down response to include in the reflection prompt. */
const MAX_RESPONSE_CHARS = 500;

type ParsedReflectionResponse = {
  learning: string;
  followUp: boolean;
  userMessage?: string;
};

export function buildReflectionPrompt(params: {
  thumbedDownResponse?: string;
  userComment?: string;
}): string {
  const parts: string[] = ["A user indicated your previous response wasn't helpful."];

  if (params.thumbedDownResponse) {
    const truncated =
      params.thumbedDownResponse.length > MAX_RESPONSE_CHARS
        ? `${params.thumbedDownResponse.slice(0, MAX_RESPONSE_CHARS)}...`
        : params.thumbedDownResponse;
    parts.push(`\nYour response was:\n> ${truncated}`);
  }

  if (params.userComment) {
    parts.push(`\nUser's comment: "${params.userComment}"`);
  }

  parts.push(
    "\nBriefly reflect: what could you improve? Consider tone, length, " +
      "accuracy, relevance, and specificity. Reply with a single JSON object " +
      'only, no markdown or prose, using this exact shape:\n{"learning":"...",' +
      '"followUp":false,"userMessage":""}\n' +
      "- learning: a short internal adjustment note (1-2 sentences) for your " +
      "future behavior in this conversation.\n" +
      "- followUp: true only if the user needs a direct follow-up message.\n" +
      "- userMessage: only the exact user-facing message to send; empty string " +
      "when followUp is false.",
  );

  return parts.join("\n");
}

function parseBooleanLike(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = normalizeOptionalLowercaseString(value);
    if (normalized === "true" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "no") {
      return false;
    }
  }
  return undefined;
}

function parseStructuredReflectionValue(value: unknown): ParsedReflectionResponse | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as {
    learning?: unknown;
    followUp?: unknown;
    userMessage?: unknown;
  };
  const learning = typeof candidate.learning === "string" ? candidate.learning.trim() : undefined;
  if (!learning) {
    return null;
  }

  return {
    learning,
    followUp: parseBooleanLike(candidate.followUp) ?? false,
    userMessage:
      typeof candidate.userMessage === "string" && candidate.userMessage.trim()
        ? candidate.userMessage.trim()
        : undefined,
  };
}

export function parseReflectionResponse(text: string): ParsedReflectionResponse | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = [
    trimmed,
    ...(trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.slice(1, 2) ?? []),
  ];

  for (const candidateText of candidates) {
    const candidate = candidateText.trim();
    if (!candidate) {
      continue;
    }
    try {
      const parsed = parseStructuredReflectionValue(JSON.parse(candidate));
      if (parsed) {
        return parsed;
      }
    } catch {
      // Fall through to the next parse strategy.
    }
  }

  // Safe fallback: keep the internal learning, but never auto-message the user.
  return {
    learning: trimmed,
    followUp: false,
  };
}
