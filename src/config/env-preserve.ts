// Normalizes preserved environment-variable config for subprocess launches.
import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { isPlainObject } from "../infra/plain-object.js";

/**
 * Preserves `${VAR}` environment variable references during config write-back.
 *
 * When config is read, `${VAR}` references are resolved to their values.
 * When writing back, callers pass the resolved config. This module detects
 * values that match what a `${VAR}` reference would resolve to and restores
 * the original reference, so env var references survive config round-trips.
 *
 * A value is restored only if:
 * 1. The pre-substitution value contained a `${VAR}` pattern
 * 2. Resolving that pattern with current env vars produces the incoming value
 *
 * If a caller intentionally set a new value (different from what the env var
 * resolves to), the new value is kept as-is.
 */

const ENV_VAR_PATTERN = /\$\{[A-Z_][A-Z0-9_]*\}/;
const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export class EnvRefArrayMutationError extends Error {
  constructor() {
    super("Config write would reorder or modify an array containing environment references.");
    this.name = "EnvRefArrayMutationError";
  }
}

/**
 * Check if a string contains any `${VAR}` env var references.
 */
function hasEnvVarRef(value: string): boolean {
  return ENV_VAR_PATTERN.test(value);
}

type AuthoredEnvRef = { kind: "escaped" | "unescaped"; name: string };

function collectAuthoredEnvRefs(value: string): AuthoredEnvRef[] {
  const refs: AuthoredEnvRef[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "$") {
      continue;
    }
    const isEscaped = value[index + 1] === "$" && value[index + 2] === "{";
    const nameStart = index + (isEscaped ? 3 : 2);
    if (!isEscaped && value[index + 1] !== "{") {
      continue;
    }
    const nameEnd = value.indexOf("}", nameStart);
    if (nameEnd === -1 || !ENV_VAR_NAME_PATTERN.test(value.slice(nameStart, nameEnd))) {
      continue;
    }
    refs.push({
      kind: isEscaped ? "escaped" : "unescaped",
      name: value.slice(nameStart, nameEnd),
    });
    index = nameEnd;
  }
  return refs;
}

function hasUnescapedEnvVarRef(value: string): boolean {
  return collectAuthoredEnvRefs(value).some((ref) => ref.kind === "unescaped");
}

function hasEscapedEnvVarRef(value: string): boolean {
  return collectAuthoredEnvRefs(value).some((ref) => ref.kind === "escaped");
}

function containsAuthoredUnescapedEnvTemplate(value: unknown): boolean {
  if (typeof value === "string") {
    return hasUnescapedEnvVarRef(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsAuthoredUnescapedEnvTemplate(item));
  }
  if (isPlainObject(value)) {
    return Object.values(value).some((item) => containsAuthoredUnescapedEnvTemplate(item));
  }
  return false;
}

function containsAuthoredEscapedEnvTemplate(value: unknown): boolean {
  if (typeof value === "string") {
    return hasEscapedEnvVarRef(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsAuthoredEscapedEnvTemplate(item));
  }
  if (isPlainObject(value)) {
    return Object.values(value).some((item) => containsAuthoredEscapedEnvTemplate(item));
  }
  return false;
}

function countAuthoredEnvRefsByPath(
  value: unknown,
  kind: AuthoredEnvRef["kind"],
): Map<string, Map<string, number>> {
  const countsByName = new Map<string, Map<string, number>>();
  const visit = (item: unknown, path: string[]) => {
    if (typeof item === "string") {
      for (const ref of collectAuthoredEnvRefs(item)) {
        if (ref.kind === kind) {
          const pathCounts = countsByName.get(ref.name) ?? new Map<string, number>();
          const pathKey = JSON.stringify(path);
          pathCounts.set(pathKey, (pathCounts.get(pathKey) ?? 0) + 1);
          countsByName.set(ref.name, pathCounts);
        }
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, [...path, String(index)]));
      return;
    }
    if (isPlainObject(item)) {
      Object.entries(item).forEach(([key, child]) => visit(child, [...path, key]));
    }
  };
  visit(value, []);
  return countsByName;
}

function countResolvedActiveEnvRefsByPath(
  incoming: unknown,
  parsed: unknown,
  env: NodeJS.ProcessEnv,
): Map<string, Map<string, number>> {
  const countsByName = new Map<string, Map<string, number>>();
  const visit = (incomingItem: unknown, parsedItem: unknown, path: string[]) => {
    if (typeof incomingItem === "string" && typeof parsedItem === "string") {
      if (!isDeepStrictEqual(incomingItem, tryResolveString(parsedItem, env))) {
        return;
      }
      for (const ref of collectAuthoredEnvRefs(parsedItem)) {
        if (ref.kind === "unescaped") {
          const pathCounts = countsByName.get(ref.name) ?? new Map<string, number>();
          const pathKey = JSON.stringify(path);
          pathCounts.set(pathKey, (pathCounts.get(pathKey) ?? 0) + 1);
          countsByName.set(ref.name, pathCounts);
        }
      }
      return;
    }
    if (Array.isArray(incomingItem) && Array.isArray(parsedItem)) {
      parsedItem.forEach((child, index) =>
        visit(incomingItem[index], child, [...path, String(index)]),
      );
      return;
    }
    if (isPlainObject(incomingItem) && isPlainObject(parsedItem)) {
      Object.entries(parsedItem).forEach(([key, child]) =>
        visit(incomingItem[key], child, [...path, key]),
      );
    }
  };
  visit(incoming, parsed, []);
  return countsByName;
}

function containsUnaccountedActiveEscapedEnvRef(
  incoming: unknown,
  escapedParsed: unknown,
  matchedIncoming: unknown,
  matchedParsed: unknown,
  env: NodeJS.ProcessEnv,
): boolean {
  const escapedCounts = countAuthoredEnvRefsByPath(escapedParsed, "escaped");
  const incomingActiveCounts = countAuthoredEnvRefsByPath(incoming, "unescaped");
  const incomingEscapedCounts = countAuthoredEnvRefsByPath(incoming, "escaped");
  const matchedActiveCounts = countResolvedActiveEnvRefsByPath(matchedIncoming, matchedParsed, env);
  const matchedEscapedCounts = countAuthoredEnvRefsByPath(matchedParsed, "escaped");
  return [...escapedCounts].some(
    ([name, escapedPathCounts]) =>
      [...(incomingActiveCounts.get(name) ?? new Map())].some(
        ([path, count]) => count > (matchedActiveCounts.get(name)?.get(path) ?? 0),
      ) ||
      [...escapedPathCounts.keys()].some((path) => {
        const incomingActiveCount = incomingActiveCounts.get(name)?.get(path) ?? 0;
        return (
          incomingActiveCount > 0 &&
          (incomingEscapedCounts.get(name)?.get(path) ?? 0) <
            (matchedEscapedCounts.get(name)?.get(path) ?? 0)
        );
      }),
  );
}

function preservesAuthoredEscapedEnvRefs(incoming: unknown, parsed: unknown): boolean {
  const parsedEscapedCounts = countAuthoredEnvRefsByPath(parsed, "escaped");
  const incomingEscapedCounts = countAuthoredEnvRefsByPath(incoming, "escaped");
  return [...parsedEscapedCounts].every(([name, parsedPathCounts]) =>
    [...parsedPathCounts].every(
      ([path, count]) => (incomingEscapedCounts.get(name)?.get(path) ?? 0) >= count,
    ),
  );
}

type ArrayIdentityPath = string[];

function getArrayIdentityPathValue(value: unknown, path: ArrayIdentityPath): unknown {
  let current = value;
  for (const segment of path) {
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function collectStableArrayIdentityPaths(value: unknown): ArrayIdentityPath[] {
  if (!isPlainObject(value)) {
    return [];
  }
  for (const key of ["id", "agentId"]) {
    const child = value[key];
    if (typeof child === "string" && !hasEnvVarRef(child)) {
      return [[key]];
    }
  }
  return [];
}

function resolveStableArrayIdentityMatch(params: {
  incoming: unknown[];
  parsed: unknown[];
  parsedIndex: number;
}): { kind: "none" } | { kind: "invalid" } | { kind: "match"; incomingIndex: number } {
  const parsedItem = params.parsed[params.parsedIndex];
  const identityPaths = collectStableArrayIdentityPaths(parsedItem);
  if (identityPaths.length === 0) {
    return { kind: "none" };
  }

  let incomingIndex: number | undefined;
  let hasUniqueAuthoredIdentity = false;
  for (const identityPath of identityPaths) {
    const identityValue = getArrayIdentityPathValue(parsedItem, identityPath);
    const authoredCount = params.parsed.filter((item) =>
      isDeepStrictEqual(getArrayIdentityPathValue(item, identityPath), identityValue),
    ).length;
    if (authoredCount !== 1) {
      continue;
    }
    hasUniqueAuthoredIdentity = true;
    const incomingMatches = params.incoming.flatMap((item, index) =>
      isDeepStrictEqual(getArrayIdentityPathValue(item, identityPath), identityValue)
        ? [index]
        : [],
    );
    if (
      incomingMatches.length !== 1 ||
      (incomingIndex !== undefined && incomingIndex !== incomingMatches[0])
    ) {
      return { kind: "invalid" };
    }
    incomingIndex = incomingMatches[0];
  }
  if (incomingIndex !== undefined) {
    return { kind: "match", incomingIndex };
  }
  return hasUniqueAuthoredIdentity ? { kind: "invalid" } : { kind: "none" };
}

function collectLiteralArrayIdentityPaths(
  value: unknown,
  path: ArrayIdentityPath = [],
): ArrayIdentityPath[] {
  if (typeof value === "string") {
    return hasEnvVarRef(value) ? [] : [path];
  }
  if (!isPlainObject(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    collectLiteralArrayIdentityPaths(child, [...path, key]),
  );
}

function hasStableSameIndexLiteralShape(params: {
  incoming: unknown[];
  parsed: unknown[];
  parsedIndex: number;
}): boolean {
  if (params.incoming.length !== params.parsed.length) {
    return false;
  }
  const parsedItem = params.parsed[params.parsedIndex];
  const literalPaths = collectLiteralArrayIdentityPaths(parsedItem);
  if (
    literalPaths.length === 0 ||
    literalPaths.some((identityPath) => {
      const identityValue = getArrayIdentityPathValue(parsedItem, identityPath);
      return !isDeepStrictEqual(
        getArrayIdentityPathValue(params.incoming[params.parsedIndex], identityPath),
        identityValue,
      );
    })
  ) {
    return false;
  }
  return literalPaths.some((identityPath) => {
    const identityValue = getArrayIdentityPathValue(parsedItem, identityPath);
    const authoredCount = params.parsed.filter((item) =>
      isDeepStrictEqual(getArrayIdentityPathValue(item, identityPath), identityValue),
    ).length;
    const incomingCount = params.incoming.filter((item) =>
      isDeepStrictEqual(getArrayIdentityPathValue(item, identityPath), identityValue),
    ).length;
    return authoredCount === 1 && incomingCount === 1;
  });
}

function matchesArrayElementAtSameIndex(
  incoming: unknown,
  parsed: unknown,
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    isDeepStrictEqual(incoming, parsed) ||
    isDeepStrictEqual(incoming, resolveEnvVarRefsForComparison(parsed, env))
  );
}

function matchesRetainedArrayItem(params: {
  incoming: unknown[];
  incomingIndex: number;
  parsed: unknown[];
  parsedIndex: number;
  env: NodeJS.ProcessEnv;
}): boolean {
  if (
    matchesArrayElementAtSameIndex(
      params.incoming[params.incomingIndex],
      params.parsed[params.parsedIndex],
      params.env,
    )
  ) {
    return true;
  }
  const stableIdentity = resolveStableArrayIdentityMatch({
    incoming: params.incoming,
    parsed: params.parsed,
    parsedIndex: params.parsedIndex,
  });
  return stableIdentity.kind === "match" && stableIdentity.incomingIndex === params.incomingIndex;
}

function hasStableSameIndexNeighbors(params: {
  incoming: unknown[];
  parsed: unknown[];
  parsedIndex: number;
  env: NodeJS.ProcessEnv;
}): boolean {
  return (
    params.incoming.length === params.parsed.length &&
    params.parsed.every(
      (item, index) =>
        index === params.parsedIndex ||
        matchesArrayElementAtSameIndex(params.incoming[index], item, params.env),
    )
  );
}

function matchUniqueRetainedArrayItems(params: {
  incoming: unknown[];
  parsed: unknown[];
  env: NodeJS.ProcessEnv;
}): Map<number, number> | undefined {
  if (params.incoming.length >= params.parsed.length) {
    return undefined;
  }

  const earliestParsedIndexes: number[] = [];
  let nextParsedIndex = 0;
  for (let incomingIndex = 0; incomingIndex < params.incoming.length; incomingIndex += 1) {
    const parsedIndex = params.parsed.findIndex(
      (_parsedItem, index) =>
        index >= nextParsedIndex &&
        matchesRetainedArrayItem({
          ...params,
          incomingIndex,
          parsedIndex: index,
        }),
    );
    if (parsedIndex < 0) {
      return undefined;
    }
    earliestParsedIndexes.push(parsedIndex);
    nextParsedIndex = parsedIndex + 1;
  }

  const latestParsedIndexes = Array.from({ length: params.incoming.length }, () => 0);
  nextParsedIndex = params.parsed.length - 1;
  for (let incomingIndex = params.incoming.length - 1; incomingIndex >= 0; incomingIndex -= 1) {
    let parsedIndex = nextParsedIndex;
    while (
      parsedIndex >= 0 &&
      !matchesRetainedArrayItem({
        ...params,
        incomingIndex,
        parsedIndex,
      })
    ) {
      parsedIndex -= 1;
    }
    if (parsedIndex < 0) {
      return undefined;
    }
    latestParsedIndexes[incomingIndex] = parsedIndex;
    nextParsedIndex = parsedIndex - 1;
  }

  if (!isDeepStrictEqual(earliestParsedIndexes, latestParsedIndexes)) {
    return undefined;
  }
  return new Map(
    earliestParsedIndexes.map((parsedIndex, incomingIndex) => [parsedIndex, incomingIndex]),
  );
}

function matchAuthoredTemplateArrayItems(params: {
  incoming: unknown[];
  parsed: unknown[];
  env: NodeJS.ProcessEnv;
}): Map<number, number> {
  const templateIndexes = params.parsed.flatMap((item, index) =>
    containsAuthoredUnescapedEnvTemplate(item) ? [index] : [],
  );
  if (
    params.incoming.length === params.parsed.length &&
    params.incoming.every((item, index) =>
      matchesArrayElementAtSameIndex(item, params.parsed[index], params.env),
    )
  ) {
    return new Map(templateIndexes.map((index) => [index, index]));
  }
  const retainedDeletionMatches = matchUniqueRetainedArrayItems(params);
  if (retainedDeletionMatches) {
    return new Map(
      templateIndexes.flatMap((parsedIndex) => {
        const incomingIndex = retainedDeletionMatches.get(parsedIndex);
        return incomingIndex === undefined ? [] : [[parsedIndex, incomingIndex]];
      }),
    );
  }

  const matches = new Map<number, number>();
  const usedIncomingIndexes = new Set<number>();
  const addMatch = (parsedIndex: number, incomingIndex: number) => {
    if (usedIncomingIndexes.has(incomingIndex)) {
      throw new EnvRefArrayMutationError();
    }
    matches.set(parsedIndex, incomingIndex);
    usedIncomingIndexes.add(incomingIndex);
  };
  for (const parsedIndex of templateIndexes) {
    const parsedItem = params.parsed[parsedIndex];
    const stableIdentity = resolveStableArrayIdentityMatch({
      incoming: params.incoming,
      parsed: params.parsed,
      parsedIndex,
    });
    if (stableIdentity.kind !== "none") {
      if (stableIdentity.kind === "invalid") {
        throw new EnvRefArrayMutationError();
      }
      addMatch(parsedIndex, stableIdentity.incomingIndex);
      continue;
    }

    if (
      parsedIndex < params.incoming.length &&
      matchesArrayElementAtSameIndex(params.incoming[parsedIndex], parsedItem, params.env)
    ) {
      const precedingItemsRemainAligned = params.parsed
        .slice(0, parsedIndex)
        .every((item, index) =>
          matchesArrayElementAtSameIndex(params.incoming[index], item, params.env),
        );
      const duplicateAuthoredMatch = params.parsed.some(
        (item, index) =>
          index !== parsedIndex &&
          matchesArrayElementAtSameIndex(params.incoming[parsedIndex], item, params.env),
      );
      const duplicateIncomingMatch = params.incoming.some(
        (item, index) =>
          index !== parsedIndex && matchesArrayElementAtSameIndex(item, parsedItem, params.env),
      );
      const positionRemainsStable =
        params.incoming.length === params.parsed.length || precedingItemsRemainAligned;
      if (!positionRemainsStable || duplicateAuthoredMatch || duplicateIncomingMatch) {
        throw new EnvRefArrayMutationError();
      }
      addMatch(parsedIndex, parsedIndex);
      continue;
    }

    if (isPlainObject(parsedItem) || Array.isArray(parsedItem)) {
      const isSinglePositionEdit = params.incoming.length === 1 && params.parsed.length === 1;
      const hasSameIndexLiteralIdentity = hasStableSameIndexLiteralShape({
        incoming: params.incoming,
        parsed: params.parsed,
        parsedIndex,
      });
      const hasSameIndexNeighbors = hasStableSameIndexNeighbors({
        incoming: params.incoming,
        parsed: params.parsed,
        parsedIndex,
        env: params.env,
      });
      if (!isSinglePositionEdit && !hasSameIndexLiteralIdentity && !hasSameIndexNeighbors) {
        throw new EnvRefArrayMutationError();
      }
      addMatch(parsedIndex, parsedIndex);
      continue;
    }
    const crossIndexMatches = params.incoming.some(
      (item, incomingIndex) =>
        incomingIndex !== parsedIndex &&
        matchesArrayElementAtSameIndex(item, parsedItem, params.env),
    );
    if (crossIndexMatches) {
      throw new EnvRefArrayMutationError();
    }
    if (parsedIndex < params.incoming.length) {
      addMatch(parsedIndex, parsedIndex);
    }
  }
  return matches;
}

function matchAuthoredEscapedTemplateArrayItems(params: {
  incoming: unknown[];
  parsed: unknown[];
  env: NodeJS.ProcessEnv;
  usedIncomingIndexes: Set<number>;
}): Map<number, number> {
  const escapedTemplateIndexes = params.parsed.flatMap((item, index) =>
    containsAuthoredEscapedEnvTemplate(item) && !containsAuthoredUnescapedEnvTemplate(item)
      ? [index]
      : [],
  );
  if (
    params.incoming.length === params.parsed.length &&
    params.incoming.every((item, index) =>
      matchesArrayElementAtSameIndex(item, params.parsed[index], params.env),
    )
  ) {
    return new Map(escapedTemplateIndexes.map((index) => [index, index]));
  }
  const retainedDeletionMatches = matchUniqueRetainedArrayItems(params);
  if (retainedDeletionMatches) {
    return new Map(
      escapedTemplateIndexes.flatMap((parsedIndex) => {
        const incomingIndex = retainedDeletionMatches.get(parsedIndex);
        if (incomingIndex === undefined) {
          return [];
        }
        if (params.usedIncomingIndexes.has(incomingIndex)) {
          throw new EnvRefArrayMutationError();
        }
        return [[parsedIndex, incomingIndex]];
      }),
    );
  }
  const matches = new Map<number, number>();
  const usedIncomingIndexes = new Set(params.usedIncomingIndexes);
  const addMatch = (parsedIndex: number, incomingIndex: number) => {
    if (usedIncomingIndexes.has(incomingIndex)) {
      throw new EnvRefArrayMutationError();
    }
    matches.set(parsedIndex, incomingIndex);
    usedIncomingIndexes.add(incomingIndex);
  };

  for (const parsedIndex of escapedTemplateIndexes) {
    const parsedItem = params.parsed[parsedIndex];
    const stableIdentity = resolveStableArrayIdentityMatch({
      incoming: params.incoming,
      parsed: params.parsed,
      parsedIndex,
    });
    if (stableIdentity.kind !== "none") {
      if (stableIdentity.kind === "match") {
        addMatch(parsedIndex, stableIdentity.incomingIndex);
        continue;
      }
    }

    const resolvedItem = resolveEnvVarRefsForComparison(parsedItem, params.env);
    const incomingMatches = params.incoming.flatMap((item, incomingIndex) =>
      !usedIncomingIndexes.has(incomingIndex) && isDeepStrictEqual(item, resolvedItem)
        ? [incomingIndex]
        : [],
    );
    const authoredMatches = escapedTemplateIndexes.filter((index) =>
      isDeepStrictEqual(
        resolveEnvVarRefsForComparison(params.parsed[index], params.env),
        resolvedItem,
      ),
    );
    const authoredRepresentationsAreIdentical = authoredMatches.every((index) =>
      isDeepStrictEqual(params.parsed[index], parsedItem),
    );
    if (
      incomingMatches.length > 0 &&
      incomingMatches.length <= authoredMatches.length &&
      authoredRepresentationsAreIdentical
    ) {
      const sameIndexMatch = incomingMatches.includes(parsedIndex)
        ? parsedIndex
        : incomingMatches[0];
      addMatch(parsedIndex, expectDefined(sameIndexMatch, "env preserve same index match"));
      continue;
    }
    if (incomingMatches.length > 0) {
      throw new EnvRefArrayMutationError();
    }

    if (isPlainObject(parsedItem) || Array.isArray(parsedItem)) {
      const isSinglePositionEdit = params.incoming.length === 1 && params.parsed.length === 1;
      const hasSameIndexLiteralIdentity = hasStableSameIndexLiteralShape({
        incoming: params.incoming,
        parsed: params.parsed,
        parsedIndex,
      });
      const hasSameIndexNeighbors = hasStableSameIndexNeighbors({
        incoming: params.incoming,
        parsed: params.parsed,
        parsedIndex,
        env: params.env,
      });
      if (
        stableIdentity.kind === "none" &&
        parsedIndex < params.incoming.length &&
        !usedIncomingIndexes.has(parsedIndex) &&
        (isSinglePositionEdit || hasSameIndexLiteralIdentity || hasSameIndexNeighbors)
      ) {
        addMatch(parsedIndex, parsedIndex);
        continue;
      }
    }
  }
  return matches;
}

/**
 * Resolve `${VAR}` references in a single string using the given env.
 * Preserves missing references so matching remains aligned with config reads.
 *
 * Mirrors the substitution semantics of `substituteString` in env-substitution.ts:
 * - `${VAR}` → env value (returns null if missing)
 * - `$${VAR}` → literal `${VAR}` (escape sequence)
 */
function tryResolveString(template: string, env: NodeJS.ProcessEnv): string {
  const chunks: string[] = [];

  for (let i = 0; i < template.length; i++) {
    if (template[i] === "$") {
      // Escaped: $${VAR} -> literal ${VAR}
      if (template[i + 1] === "$" && template[i + 2] === "{") {
        const start = i + 3;
        const end = template.indexOf("}", start);
        if (end !== -1) {
          const name = template.slice(start, end);
          if (ENV_VAR_NAME_PATTERN.test(name)) {
            chunks.push(`\${${name}}`);
            i = end;
            continue;
          }
        }
      }

      // Substitution: ${VAR} -> env value
      if (template[i + 1] === "{") {
        const start = i + 2;
        const end = template.indexOf("}", start);
        if (end !== -1) {
          const name = template.slice(start, end);
          if (ENV_VAR_NAME_PATTERN.test(name)) {
            const val = env[name];
            if (val === undefined || val === "") {
              chunks.push(`\${${name}}`);
              i = end;
              continue;
            }
            chunks.push(val);
            i = end;
            continue;
          }
        }
      }
    }
    chunks.push(template.charAt(i));
  }

  return chunks.join("");
}

function resolveEnvVarRefsForComparison(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    return hasEnvVarRef(value) ? tryResolveString(value, env) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveEnvVarRefsForComparison(item, env));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveEnvVarRefsForComparison(item, env)]),
    );
  }
  return value;
}

/**
 * Deep-walk the incoming config and restore `${VAR}` references from the
 * pre-substitution parsed config wherever the resolved value matches.
 *
 * @param incoming - The resolved config about to be written
 * @param parsed - The pre-substitution parsed config (from the current file on disk)
 * @param env - Environment variables for verification
 * @returns A new config object with env var references restored where appropriate
 */
export function restoreEnvVarRefs(
  incoming: unknown,
  parsed: unknown,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  // If parsed has no env var refs at this level, return incoming as-is
  if (parsed === null || parsed === undefined) {
    return incoming;
  }

  // String leaf: check if parsed was a ${VAR} template that resolves to incoming
  if (typeof incoming === "string" && typeof parsed === "string") {
    if (hasEnvVarRef(parsed)) {
      const resolved = tryResolveString(parsed, env);
      if (resolved === incoming) {
        // The incoming value matches what the env var resolves to — restore the reference
        return parsed;
      }
    }
    return incoming;
  }

  // Array template entries must retain a unique identity before authored refs
  // can be restored; ambiguous moves would attach secrets or activate escaped
  // literals on the wrong entry.
  if (Array.isArray(incoming) && Array.isArray(parsed)) {
    if (
      !containsAuthoredUnescapedEnvTemplate(parsed) &&
      !containsAuthoredEscapedEnvTemplate(parsed)
    ) {
      return incoming.map((item, index) =>
        index < parsed.length ? restoreEnvVarRefs(item, parsed[index], env) : item,
      );
    }
    // Keep same-name real/escaped scalar reorders fail-closed: a raw `${VAR}`
    // is indistinguishable from a moved escaped literal or a newly active ref.
    const unescapedMatches = matchAuthoredTemplateArrayItems({ incoming, parsed, env });
    const escapedMatches = matchAuthoredEscapedTemplateArrayItems({
      incoming,
      parsed,
      env,
      usedIncomingIndexes: new Set(unescapedMatches.values()),
    });
    const matches = new Map([...unescapedMatches, ...escapedMatches]);
    const next = [...incoming];
    const matchedIncomingIndexes = new Set(matches.values());
    for (const [parsedIndex, incomingIndex] of matches) {
      next[incomingIndex] = restoreEnvVarRefs(incoming[incomingIndex], parsed[parsedIndex], env);
    }
    for (let index = 0; index < incoming.length && index < parsed.length; index += 1) {
      if (
        !matchedIncomingIndexes.has(index) &&
        !containsAuthoredUnescapedEnvTemplate(parsed[index]) &&
        !containsAuthoredEscapedEnvTemplate(parsed[index])
      ) {
        next[index] = restoreEnvVarRefs(incoming[index], parsed[index], env);
      }
    }
    const matchedParsedIndexByIncoming = new Map(
      [...matches].map(([parsedIndex, incomingIndex]) => [incomingIndex, parsedIndex]),
    );
    for (const [escapedParsedIndex, escapedParsedItem] of parsed.entries()) {
      if (!containsAuthoredEscapedEnvTemplate(escapedParsedItem)) {
        continue;
      }
      const matchedIncomingIndex = matches.get(escapedParsedIndex);
      if (
        matchedIncomingIndex !== undefined &&
        preservesAuthoredEscapedEnvRefs(next[matchedIncomingIndex], escapedParsedItem)
      ) {
        continue;
      }
      const hasUnaccountedActiveReference = next.some((item, incomingIndex) => {
        const matchedParsedIndex = matchedParsedIndexByIncoming.get(incomingIndex);
        return containsUnaccountedActiveEscapedEnvRef(
          item,
          escapedParsedItem,
          incoming[incomingIndex],
          matchedParsedIndex === undefined ? undefined : parsed[matchedParsedIndex],
          env,
        );
      });
      if (hasUnaccountedActiveReference) {
        throw new EnvRefArrayMutationError();
      }
    }
    return next;
  }

  // Objects: walk key by key
  if (isPlainObject(incoming) && isPlainObject(parsed)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (key in parsed) {
        result[key] = restoreEnvVarRefs(value, parsed[key], env);
      } else {
        // New key added by caller — keep as-is
        result[key] = value;
      }
    }
    return result;
  }

  // Mismatched types or primitives — keep incoming
  return incoming;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
