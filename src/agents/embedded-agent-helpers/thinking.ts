/**
 * Resolves fallback thinking levels for providers that require reasoning.
 */
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { normalizeThinkLevel, type ThinkLevel } from "../../auto-reply/thinking.js";
import { isReasoningConstraintErrorMessage } from "../failover/classify.js";

function extractSupportedValues(raw: string): string[] {
  const fragment = raw.match(/supported values(?: are)?:\s*([^\n.]+)/i)?.[1];
  if (!fragment) {
    return [];
  }
  const quoted = Array.from(fragment.matchAll(/['"]([^'"]+)['"]/g), ([, value]) => value);
  return normalizeStringEntries(
    quoted.length > 0
      ? quoted
      : fragment.split(/,|\band\b/gi).map((entry) => entry.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, "")),
  );
}

/** Pick a configured or provider-safe reasoning level for fallback attempts. */
export function pickFallbackThinkingLevel(params: {
  message?: string;
  attempted: Set<ThinkLevel>;
}): ThinkLevel | undefined {
  const raw = params.message?.trim() ?? "";
  const requiresReasoning = isReasoningConstraintErrorMessage(raw);
  // Model identifiers can contain these words; require a parameter or reasoning constraint.
  if (
    !requiresReasoning &&
    !/(?<![\w./-])(?:think(?:ing)?(?:[._]|\s+)(?:value|level|budget)|reasoning(?:[._]|\s+)(?:effort|level|budget))(?![\w/-]|\.[\w/-])/i.test(
      raw,
    )
  ) {
    return undefined;
  }
  // Mandatory-reasoning endpoints need the smallest enabled level, never off.
  if (requiresReasoning && !params.attempted.has("minimal")) {
    return "minimal";
  }
  const supported = extractSupportedValues(raw);
  if (supported.length === 0) {
    return /not supported/i.test(raw) && !params.attempted.has("off") ? "off" : undefined;
  }
  for (const entry of supported) {
    const normalized = normalizeThinkLevel(entry);
    if (normalized && !params.attempted.has(normalized)) {
      return normalized;
    }
  }
  return undefined;
}
