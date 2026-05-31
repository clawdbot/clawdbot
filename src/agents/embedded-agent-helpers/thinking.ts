import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { normalizeThinkLevel, type ThinkLevel } from "../../auto-reply/thinking.js";
import { isReasoningConstraintErrorMessage } from "./errors.js";

function extractSupportedValues(raw: string): string[] {
  const match =
    raw.match(/supported values are:\s*([^\n.]+)/i) ?? raw.match(/supported values:\s*([^\n.]+)/i);
  if (!match?.[1]) {
    return [];
  }
  const fragment = match[1];
  const quoted = Array.from(fragment.matchAll(/['"]([^'"]+)['"]/g)).map((entry) =>
    entry[1]?.trim(),
  );
  if (quoted.length > 0) {
    return normalizeStringEntries(quoted.filter((entry): entry is string => Boolean(entry)));
  }
  return normalizeStringEntries(
    fragment.split(/,|\band\b/gi).map((entry) => entry.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, "")),
  );
}

export function pickFallbackThinkingLevel(params: {
  message?: string;
  attempted: Set<ThinkLevel>;
}): ThinkLevel | undefined {
  const raw = params.message?.trim();
  if (!raw) {
    return undefined;
  }
  // Some OpenRouter/MiniMax endpoints reject `off` entirely and require a
  // non-zero reasoning level, so our first safe retry is `minimal`.
  if (isReasoningConstraintErrorMessage(raw) && !params.attempted.has("minimal")) {
    return "minimal";
  }
  const supported = extractSupportedValues(raw);
  if (supported.length === 0) {
    // When the error clearly indicates the thinking level is unsupported but doesn't
    // list supported values (e.g. OpenAI's "think value \"low\" is not supported for
    // this model"), fall back to "off" to allow the request to succeed.
    // This commonly happens during model fallback when switching from Anthropic
    // (which supports thinking levels) to providers that don't.
    if (/not supported/i.test(raw) && !params.attempted.has("off")) {
      return "off";
    }
    return undefined;
  }
  for (const entry of supported) {
    const normalized = normalizeThinkLevel(entry);
    if (!normalized) {
      continue;
    }
    if (params.attempted.has(normalized)) {
      continue;
    }
    return normalized;
  }
  return undefined;
}
