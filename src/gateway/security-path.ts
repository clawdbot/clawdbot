// Gateway path security canonicalizes repeatedly encoded paths and protects
// plugin HTTP routes even under malformed encoding.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

type SecurityPathCanonicalization = {
  canonicalPath: string;
  candidates: string[];
  decodePasses: number;
  decodePassLimitReached: boolean;
  malformedEncoding: boolean;
  rawNormalizedPath: string;
};

const MAX_PATH_DECODE_PASSES = 32;

function normalizePathSeparators(pathname: string): string {
  const collapsed = pathname.replace(/\/{2,}/g, "/");
  if (collapsed.length <= 1) {
    return collapsed;
  }
  return collapsed.replace(/\/+$/, "");
}

function resolveDotSegments(pathname: string): string {
  try {
    return new URL(pathname, "http://localhost").pathname;
  } catch {
    return pathname;
  }
}

function normalizePathForSecurity(pathname: string): string {
  return (
    normalizePathSeparators(normalizeLowercaseStringOrEmpty(resolveDotSegments(pathname))) || "/"
  );
}

function pushNormalizedCandidate(candidates: string[], seen: Set<string>, value: string): void {
  const normalized = normalizePathForSecurity(value);
  if (seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  candidates.push(normalized);
}

function buildCanonicalPathCandidates(
  pathname: string,
  maxDecodePasses = MAX_PATH_DECODE_PASSES,
): {
  candidates: string[];
  decodePasses: number;
  decodePassLimitReached: boolean;
  malformedEncoding: boolean;
} {
  const candidates: string[] = [];
  const seen = new Set<string>();
  pushNormalizedCandidate(candidates, seen, pathname);

  let decoded = pathname;
  let malformedEncoding = false;
  let decodePasses = 0;
  for (let pass = 0; pass < maxDecodePasses; pass++) {
    let nextDecoded;
    try {
      nextDecoded = decodeURIComponent(decoded);
    } catch {
      malformedEncoding = true;
      break;
    }
    if (nextDecoded === decoded) {
      break;
    }
    decodePasses += 1;
    decoded = nextDecoded;
    pushNormalizedCandidate(candidates, seen, decoded);
  }
  let decodePassLimitReached = false;
  if (!malformedEncoding) {
    try {
      decodePassLimitReached = decodeURIComponent(decoded) !== decoded;
    } catch {
      malformedEncoding = true;
    }
  }
  return {
    candidates,
    decodePasses,
    decodePassLimitReached,
    malformedEncoding,
  };
}

export function canonicalizePathVariant(pathname: string): string {
  const { candidates } = buildCanonicalPathCandidates(pathname);
  return candidates[candidates.length - 1] ?? "/";
}

export function canonicalizePathForSecurity(pathname: string): SecurityPathCanonicalization {
  const { candidates, decodePasses, decodePassLimitReached, malformedEncoding } =
    buildCanonicalPathCandidates(pathname);

  return {
    canonicalPath: candidates[candidates.length - 1] ?? "/",
    candidates,
    decodePasses,
    decodePassLimitReached,
    malformedEncoding,
    rawNormalizedPath: normalizePathSeparators(normalizeLowercaseStringOrEmpty(pathname)) || "/",
  };
}

export const PROTECTED_PLUGIN_ROUTE_PREFIXES = ["/api/channels"] as const;
