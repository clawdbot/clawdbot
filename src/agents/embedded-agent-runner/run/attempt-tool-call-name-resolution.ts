/** Resolves provider-emitted tool names against the live callable set. */
import { normalizeLowercaseStringOrEmpty } from "../../../../packages/normalization-core/src/string-coerce.js";
import { normalizeStringEntries } from "../../../../packages/normalization-core/src/string-normalization.js";
import { normalizeToolPolicyName } from "../../tool-policy.js";

function resolveCaseInsensitiveAllowedToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  const folded = normalizeLowercaseStringOrEmpty(rawName);
  let caseInsensitiveMatch: string | null = null;
  for (const name of allowedToolNames) {
    if (normalizeLowercaseStringOrEmpty(name) !== folded) {
      continue;
    }
    if (caseInsensitiveMatch && caseInsensitiveMatch !== name) {
      return null;
    }
    caseInsensitiveMatch = name;
  }
  return caseInsensitiveMatch;
}

function resolveExactAllowedToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  if (allowedToolNames.has(rawName)) {
    return rawName;
  }
  const normalized = normalizeToolPolicyName(rawName);
  if (allowedToolNames.has(normalized)) {
    return normalized;
  }
  return (
    resolveCaseInsensitiveAllowedToolName(rawName, allowedToolNames) ??
    resolveCaseInsensitiveAllowedToolName(normalized, allowedToolNames)
  );
}

function buildStructuredToolNameCandidates(rawName: string): string[] {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return [];
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (value: string) => {
    const candidate = value.trim();
    if (!candidate || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    candidates.push(candidate);
  };

  addCandidate(trimmed);
  addCandidate(normalizeToolPolicyName(trimmed));
  const structuredSeeds = [trimmed];

  const xmlFragmentOffset = ['"', "'", "<"]
    .map((separator) => trimmed.indexOf(separator))
    .filter((offset) => offset > 0)
    .reduce<number | undefined>(
      (earliest, offset) => (earliest === undefined || offset < earliest ? offset : earliest),
      undefined,
    );
  if (xmlFragmentOffset !== undefined) {
    const prefix = trimmed.slice(0, xmlFragmentOffset);
    addCandidate(prefix);
    addCandidate(normalizeToolPolicyName(prefix));
    structuredSeeds.push(prefix);
  }

  for (const seed of structuredSeeds) {
    const normalizedDelimiter = seed.replace(/\//g, ".");
    addCandidate(normalizedDelimiter);
    addCandidate(normalizeToolPolicyName(normalizedDelimiter));

    const segments = normalizeStringEntries(normalizedDelimiter.split("."));
    if (segments.length > 1) {
      for (let index = 1; index < segments.length; index += 1) {
        const suffix = segments.slice(index).join(".");
        addCandidate(suffix);
        addCandidate(normalizeToolPolicyName(suffix));
      }
    }
  }

  return candidates;
}

function resolveStructuredAllowedToolName(
  rawName: string,
  allowedToolNames?: Set<string>,
): string | null {
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }

  const candidateNames = buildStructuredToolNameCandidates(rawName);
  for (const candidate of candidateNames) {
    if (allowedToolNames.has(candidate)) {
      return candidate;
    }
  }

  for (const candidate of candidateNames) {
    const caseInsensitiveMatch = resolveCaseInsensitiveAllowedToolName(candidate, allowedToolNames);
    if (caseInsensitiveMatch) {
      return caseInsensitiveMatch;
    }
  }

  return null;
}

function inferToolNameFromToolCallId(
  rawId: string | undefined,
  allowedToolNames?: Set<string>,
): string | null {
  if (!rawId || !allowedToolNames || allowedToolNames.size === 0) {
    return null;
  }
  const id = rawId.trim();
  if (!id) {
    return null;
  }

  const candidateTokens = new Set<string>();
  const addToken = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    candidateTokens.add(trimmed);
    candidateTokens.add(trimmed.replace(/[:._/-]\d+$/, ""));
    candidateTokens.add(trimmed.replace(/\d+$/, ""));

    const normalizedDelimiter = trimmed.replace(/\//g, ".");
    candidateTokens.add(normalizedDelimiter);
    candidateTokens.add(normalizedDelimiter.replace(/[:._-]\d+$/, ""));
    candidateTokens.add(normalizedDelimiter.replace(/\d+$/, ""));

    for (const prefixPattern of [/^functions?[._-]?/i, /^tools?[._-]?/i]) {
      const stripped = normalizedDelimiter.replace(prefixPattern, "");
      if (stripped !== normalizedDelimiter) {
        candidateTokens.add(stripped);
        candidateTokens.add(stripped.replace(/[:._-]\d+$/, ""));
        candidateTokens.add(stripped.replace(/\d+$/, ""));
      }
    }
  };

  const preColon = id.split(":")[0] ?? id;
  for (const seed of [id, preColon]) {
    addToken(seed);
  }

  let singleMatch: string | null = null;
  for (const candidate of candidateTokens) {
    const matched = resolveStructuredAllowedToolName(candidate, allowedToolNames);
    if (!matched) {
      continue;
    }
    if (singleMatch && singleMatch !== matched) {
      return null;
    }
    singleMatch = matched;
  }

  return singleMatch;
}

function looksLikeMalformedToolNameCounter(rawName: string): boolean {
  const normalizedDelimiter = rawName.trim().replace(/\//g, ".");
  return (
    /^(?:functions?|tools?)[._-]?/i.test(normalizedDelimiter) &&
    /(?:[:._-]\d+|\d+)$/.test(normalizedDelimiter)
  );
}

export function resolveToolCallName(
  rawName: string,
  allowedToolNames?: Set<string>,
  rawToolCallId?: string,
  requireAllowed = false,
): string | null {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return (
      inferToolNameFromToolCallId(rawToolCallId, allowedToolNames) ??
      (requireAllowed ? null : rawName)
    );
  }
  if (!allowedToolNames || allowedToolNames.size === 0) {
    return trimmed;
  }

  const exact = resolveExactAllowedToolName(trimmed, allowedToolNames);
  if (exact) {
    return exact;
  }
  const inferredFromName = inferToolNameFromToolCallId(trimmed, allowedToolNames);
  if (inferredFromName) {
    return inferredFromName;
  }

  if (looksLikeMalformedToolNameCounter(trimmed)) {
    return requireAllowed ? null : trimmed;
  }

  return (
    resolveStructuredAllowedToolName(trimmed, allowedToolNames) ?? (requireAllowed ? null : trimmed)
  );
}
