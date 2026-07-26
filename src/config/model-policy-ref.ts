import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

const MODEL_POLICY_COMPAT_SELECTORS = new Set(["openrouter:auto", "openrouter:free"]);

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Trim each segment of a wildcard prefix. The wildcard key is matched on segment
 * boundaries, so padding around a namespace is normalization; without this a
 * padded prefix would keep the padding in its canonical key and never match.
 */
function splitWildcardPrefixSegments(trimmed: string): string[] {
  return trimmed.split("/").map((segment) => segment.trim());
}

function isValidRefValue(value: string): boolean {
  return (
    value.length > 0 && !value.includes("*") && !/\s/u.test(value) && !hasControlCharacter(value)
  );
}

function hasValidSegments(
  segments: readonly string[],
  bounds: { min: number; max?: number },
): boolean {
  return (
    segments.length >= bounds.min &&
    (bounds.max === undefined || segments.length <= bounds.max) &&
    segments.every(isValidRefValue)
  );
}

type ModelPolicyWildcardRef = {
  key: string;
  provider: string;
};

/** Parse and canonicalize a segment-boundary model-policy prefix wildcard. */
export function parseModelPolicyWildcardRef(raw: string): ModelPolicyWildcardRef | null {
  const trimmed = raw.trim();
  if (!trimmed.endsWith("/*")) {
    return null;
  }
  const segments = splitWildcardPrefixSegments(trimmed);
  if (
    segments.at(-1) !== "*" ||
    !hasValidSegments(segments.slice(0, -1), {
      min: 1,
    })
  ) {
    return null;
  }
  const provider = normalizeProviderId(segments[0] ?? "");
  if (!provider) {
    return null;
  }
  return {
    key: [provider, ...segments.slice(1)].join("/"),
    provider,
  };
}

/** True for a syntactically valid exact provider/model policy reference. */
export function isValidExactModelPolicyRef(raw: string): boolean {
  const parsed = parseModelCatalogRef(raw.trim());
  if (!parsed) {
    return false;
  }
  // Validate the values the runtime actually resolves: it trims the provider and the
  // whole model remainder, not each nested segment. Trimming per segment here would
  // accept refs that resolve to a model id with embedded whitespace.
  return (
    isValidRefValue(parsed.provider) &&
    isValidRefValue(parsed.modelId) &&
    !parsed.modelId.split("/").includes("")
  );
}

/** True for a supported bare selector whose target is resolved from config. */
export function isModelPolicyCompatSelector(raw: string): boolean {
  return MODEL_POLICY_COMPAT_SELECTORS.has(normalizeLowercaseStringOrEmpty(raw));
}
