import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { isRecord, parseDotPath } from "./shared.js";
import type { SecretTargetRegistryEntry } from "./target-registry-types.js";

export type PathPatternToken =
  | { kind: "literal"; value: string }
  | { kind: "wildcard" }
  | { kind: "array"; field: string };

export type CompiledTargetRegistryEntry = SecretTargetRegistryEntry & {
  pathTokens: PathPatternToken[];
  pathDynamicTokenCount: number;
  refPathTokens?: PathPatternToken[];
  refPathDynamicTokenCount: number;
};

export type ExpandedPathMatch = {
  segments: string[];
  captures: string[];
  value: unknown;
};

function countDynamicPatternTokens(tokens: PathPatternToken[]): number {
  return tokens.filter((token) => token.kind === "wildcard" || token.kind === "array").length;
}

export function parsePathPattern(pathPattern: string): PathPatternToken[] {
  const segments = parseDotPath(pathPattern);
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

export function compileTargetRegistryEntry(
  entry: SecretTargetRegistryEntry,
): CompiledTargetRegistryEntry {
  const pathTokens = parsePathPattern(entry.pathPattern);
  const pathDynamicTokenCount = countDynamicPatternTokens(pathTokens);
  const refPathTokens = entry.refPathPattern ? parsePathPattern(entry.refPathPattern) : undefined;
  const refPathDynamicTokenCount = refPathTokens ? countDynamicPatternTokens(refPathTokens) : 0;
  const requiresSiblingRefPath = entry.secretShape === "sibling_ref"; // pragma: allowlist secret
  if (requiresSiblingRefPath && !refPathTokens) {
    throw new Error(`Missing refPathPattern for sibling_ref target: ${entry.id}`);
  }
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

export function matchPathTokens(
  segments: string[],
  tokens: PathPatternToken[],
): {
  captures: string[];
} | null {
  const captures: string[] = [];
  let index = 0;
  for (const token of tokens) {
    if (token.kind === "literal") {
      if (segments[index] !== token.value) {
        return null;
      }
      index += 1;
      continue;
    }
    if (token.kind === "wildcard") {
      const value = segments[index];
      if (!value) {
        return null;
      }
      captures.push(value);
      index += 1;
      continue;
    }
    if (segments[index] !== token.field) {
      return null;
    }
    const next = segments[index + 1];
    if (!next || parseConfigPathArrayIndex(next) === undefined) {
      return null;
    }
    captures.push(next);
    index += 2;
  }
  return index === segments.length ? { captures } : null;
}

export function materializePathTokens(
  tokens: PathPatternToken[],
  captures: string[],
): string[] | null {
  const out: string[] = [];
  let captureIndex = 0;
  for (const token of tokens) {
    if (token.kind === "literal") {
      out.push(token.value);
      continue;
    }
    if (token.kind === "wildcard") {
      const value = captures[captureIndex];
      if (!value) {
        return null;
      }
      out.push(value);
      captureIndex += 1;
      continue;
    }
    const arrayIndex = captures[captureIndex];
    if (!arrayIndex || parseConfigPathArrayIndex(arrayIndex) === undefined) {
      return null;
    }
    out.push(token.field, arrayIndex);
    captureIndex += 1;
  }
  return captureIndex === captures.length ? out : null;
}

export function expandPathTokens(root: unknown, tokens: PathPatternToken[]): ExpandedPathMatch[] {
  const out: ExpandedPathMatch[] = [];
  const walk = (
    node: unknown,
    tokenIndex: number,
    segments: string[],
    captures: string[],
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
      if (!isRecord(node)) {
        return;
      }
      for (const [key, value] of Object.entries(node)) {
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
      const indexString = String(index);
      if (isLeaf) {
        out.push({
          segments: [...segments, token.field, indexString],
          captures: [...captures, indexString],
          value: item,
        });
        continue;
      }
      walk(
        item,
        tokenIndex + 1,
        [...segments, token.field, indexString],
        [...captures, indexString],
      );
    }
  };
  walk(root, 0, [], []);
  return out;
}
