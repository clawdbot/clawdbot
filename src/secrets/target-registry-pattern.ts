/** Compiles, matches, and expands secret target registry path patterns. */
import type { ConcreteConfigPathSegment } from "../shared/dot-path.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { isRecord, parseDotPath } from "./shared.js";
import type { SecretTargetRegistryEntry } from "./target-registry-types.js";

/** Tokenized segment in a secret target path pattern. */
type PathPatternToken =
  | { kind: "literal"; value: string }
  | { kind: "wildcard" }
  | { kind: "array"; field: string };

/** Registry entry with compiled path/ref pattern tokens. */
export type CompiledTargetRegistryEntry = SecretTargetRegistryEntry & {
  pathTokens: PathPatternToken[];
  pathDynamicTokenCount: number;
  refPathTokens?: PathPatternToken[];
  refPathDynamicTokenCount: number;
};

/** Concrete config value matched by expanding a path pattern. */
type ExpandedPathMatch = {
  segments: ConcreteConfigPathSegment[];
  captures: ConcreteConfigPathSegment[];
  value: unknown;
};

function countDynamicPatternTokens(tokens: PathPatternToken[]): number {
  return tokens.filter((token) => token.kind === "wildcard" || token.kind === "array").length;
}

/**
 * Parses a dotted target pattern into literal, wildcard, and array traversal tokens.
 */
function parsePathPattern(pathPattern: string, pathSegments?: string[]): PathPatternToken[] {
  const segments = pathSegments ?? parseDotPath(pathPattern);
  return segments.map((segment) => {
    if (segment === "*") {
      return { kind: "wildcard" } as const;
    }
    if (segment.endsWith("[]")) {
      const field = segment.slice(0, -2).trim();
      if (!field) {
        throw new Error(`Invalid target path pattern: ${pathPattern}`);
      }
      return { kind: "array", field } as const;
    }
    return { kind: "literal", value: segment } as const;
  });
}

/**
 * Compiles a registry entry and verifies its value path/ref path wildcard shape matches.
 */
export function compileTargetRegistryEntry(
  entry: SecretTargetRegistryEntry,
): CompiledTargetRegistryEntry {
  const pathTokens = parsePathPattern(entry.pathPattern, entry.pathPatternSegments);
  const pathDynamicTokenCount = countDynamicPatternTokens(pathTokens);
  const refPathTokens = entry.refPathPattern ? parsePathPattern(entry.refPathPattern) : undefined;
  const refPathDynamicTokenCount = refPathTokens ? countDynamicPatternTokens(refPathTokens) : 0;
  const requiresSiblingRefPath = entry.secretShape === "sibling_ref"; // pragma: allowlist secret
  if (requiresSiblingRefPath && !refPathTokens) {
    throw new Error(`Missing refPathPattern for sibling_ref target: ${entry.id}`);
  }
  // Value and sibling-ref paths must capture the same wildcard/array values in the same order.
  if (refPathTokens && refPathDynamicTokenCount !== pathDynamicTokenCount) {
    throw new Error(`Mismatched wildcard shape for target ref path: ${entry.id}`);
  }
  return {
    ...entry,
    pathTokens,
    pathDynamicTokenCount,
    refPathTokens,
    refPathDynamicTokenCount,
  };
}

/**
 * Matches concrete path segments against compiled pattern tokens and returns dynamic captures.
 */
export function matchPathTokens(
  segments: readonly ConcreteConfigPathSegment[],
  tokens: PathPatternToken[],
  options?: { allowLegacyArrayString?: boolean },
): {
  captures: ConcreteConfigPathSegment[];
} | null {
  const captures: ConcreteConfigPathSegment[] = [];
  let index = 0;
  for (const token of tokens) {
    if (token.kind === "literal") {
      if (typeof segments[index] !== "string" || segments[index] !== token.value) {
        return null;
      }
      index += 1;
      continue;
    }
    if (token.kind === "wildcard") {
      const value = segments[index];
      if (value === undefined || value === "") {
        return null;
      }
      // Capture order must match materializePathTokens for sibling ref path reconstruction.
      captures.push(value);
      index += 1;
      continue;
    }
    if (segments[index] !== token.field) {
      return null;
    }
    const next = segments[index + 1];
    const arrayIndex =
      typeof next === "number"
        ? next
        : options?.allowLegacyArrayString && typeof next === "string"
          ? parseConfigPathArrayIndex(next)
          : undefined;
    if (arrayIndex === undefined || parseConfigPathArrayIndex(String(arrayIndex)) !== arrayIndex) {
      return null;
    }
    captures.push(arrayIndex);
    index += 2;
  }
  return index === segments.length ? { captures } : null;
}

/**
 * Rebuilds a concrete path from tokens and captures produced by matchPathTokens/expandPathTokens.
 */
export function materializePathTokens(
  tokens: PathPatternToken[],
  captures: ConcreteConfigPathSegment[],
): ConcreteConfigPathSegment[] | null {
  const out: ConcreteConfigPathSegment[] = [];
  let captureIndex = 0;
  for (const token of tokens) {
    if (token.kind === "literal") {
      out.push(token.value);
      continue;
    }
    if (token.kind === "wildcard") {
      const value = captures[captureIndex];
      if (value === undefined || value === "") {
        return null;
      }
      out.push(value);
      captureIndex += 1;
      continue;
    }
    const arrayIndex = captures[captureIndex];
    if (
      typeof arrayIndex !== "number" ||
      parseConfigPathArrayIndex(String(arrayIndex)) !== arrayIndex
    ) {
      return null;
    }
    out.push(token.field, arrayIndex);
    captureIndex += 1;
  }
  return captureIndex === captures.length ? out : null;
}

/**
 * Expands a pattern across a config object and returns every matching value with captures.
 */
export function expandPathTokens(root: unknown, tokens: PathPatternToken[]): ExpandedPathMatch[] {
  const out: ExpandedPathMatch[] = [];
  const walk = (
    node: unknown,
    tokenIndex: number,
    segments: ConcreteConfigPathSegment[],
    captures: ConcreteConfigPathSegment[],
  ): void => {
    const token = tokens[tokenIndex];
    if (!token) {
      out.push({ segments, captures, value: node });
      return;
    }
    const isLeaf = tokenIndex === tokens.length - 1;

    if (token.kind === "literal") {
      if (!isRecord(node)) {
        return;
      }
      if (isLeaf) {
        out.push({
          segments: [...segments, token.value],
          captures,
          value: node[token.value],
        });
        return;
      }
      if (!Object.hasOwn(node, token.value)) {
        return;
      }
      walk(node[token.value], tokenIndex + 1, [...segments, token.value], captures);
      return;
    }

    if (token.kind === "wildcard") {
      if (!Array.isArray(node) && !isRecord(node)) {
        return;
      }
      const entries: Iterable<[ConcreteConfigPathSegment, unknown]> = Array.isArray(node)
        ? node.entries()
        : Object.entries(node);
      for (const [key, value] of entries) {
        if (isLeaf) {
          out.push({
            segments: [...segments, key],
            captures: [...captures, key],
            value,
          });
          continue;
        }
        walk(value, tokenIndex + 1, [...segments, key], [...captures, key]);
      }
      return;
    }

    if (!isRecord(node)) {
      return;
    }
    const items = node[token.field];
    if (!Array.isArray(items)) {
      return;
    }
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (isLeaf) {
        out.push({
          segments: [...segments, token.field, index],
          captures: [...captures, index],
          value: item,
        });
        continue;
      }
      walk(item, tokenIndex + 1, [...segments, token.field, index], [...captures, index]);
    }
  };
  walk(root, 0, [], []);
  return out;
}
