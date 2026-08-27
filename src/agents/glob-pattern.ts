/**
 * Compiles and matches lightweight glob patterns used by agent policies.
 */
type CompiledGlobPattern =
  | { kind: "all" }
  | { kind: "exact"; value: string }
  | { kind: "regex"; value: RegExp };

function escapeRegex(value: string) {
  // Standard "escape string for regex literal" pattern.
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileGlobPattern(params: {
  raw: string;
  normalize: (value: string) => string;
}): CompiledGlobPattern {
  const normalized = params.normalize(params.raw);
  if (!normalized) {
    return { kind: "exact", value: "" };
  }
  if (normalized === "*") {
    return { kind: "all" };
  }
  if (!normalized.includes("*")) {
    return { kind: "exact", value: normalized };
  }
  return {
    kind: "regex",
    value: new RegExp(`^${escapeRegex(normalized).replaceAll("\\*", ".*")}$`),
  };
}

export function compileGlobPatterns(params: {
  raw?: string[] | undefined;
  normalize: (value: string) => string;
}): CompiledGlobPattern[] {
  if (!Array.isArray(params.raw)) {
    return [];
  }
  return params.raw
    .map((raw) => compileGlobPattern({ raw, normalize: params.normalize }))
    .filter((pattern) => pattern.kind !== "exact" || pattern.value);
}

export function matchesAnyGlobPattern(value: string, patterns: CompiledGlobPattern[]): boolean {
  for (const pattern of patterns) {
    if (pattern.kind === "all") {
      return true;
    }
    if (pattern.kind === "exact" && value === pattern.value) {
      return true;
    }
    if (pattern.kind === "regex" && pattern.value.test(value)) {
      return true;
    }
  }
  return false;
}

/** Conservative discovery hint; concrete values still need the full glob matcher. */
export function mayMatchGlobWithPrefix(pattern: string, prefix: string): boolean {
  const wildcard = pattern.indexOf("*");
  if (wildcard < 0) {
    return false;
  }
  const literalHead = pattern.slice(0, wildcard);
  return prefix.startsWith(literalHead) || literalHead.startsWith(prefix);
}
