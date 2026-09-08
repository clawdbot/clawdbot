// Prepares config writes by diffing current state and preserving metadata.
import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import {
  hasAgentRosterProperty,
  listAgentEntries,
  listAgentEntriesWithSource,
  readAgentRosterProperty,
  toAgentEntriesRecord,
} from "../agents/agent-scope-config.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { isRecord } from "../utils.js";
import { configIncludeOwnsAgentRosterValues } from "./agent-roster-provenance.js";
import { containsEnvVarReference } from "./env-substitution.js";
import { coerceConfig } from "./io.read-helpers.js";
import type { ConfigWriteInputBasis } from "./io.types.js";
import { createConfigIncludeOwnershipError } from "./io.write-errors.js";
import { parseLegacyAgentRoster, projectLegacyAgentRosterEntries } from "./legacy.roster.js";
import { createMergePatch } from "./merge-patch.js";
import { normalizeAgentModelMapForConfig, normalizeAgentModelRefForConfig } from "./model-input.js";
import { isSecretRefShape } from "./redact-snapshot.secret-ref.js";
import {
  getConfigResolutionFacts,
  hasUnresolvedConfigPath,
  hasUnresolvedConfigPathInSubtree,
} from "./resolution-facts.js";
import { projectRuntimeChangesOntoSource } from "./source-value-projection.js";
import type { OpenClawConfig } from "./types.js";

const AGENT_ROSTER_PATHS = [
  ["agents", "entries"],
  ["agents", "list"],
] as const;

class DuplicateAgentRosterIdError extends Error {
  constructor(agentId: string) {
    super(`Config write cannot canonicalize duplicate normalized agent id "${agentId}".`);
    this.name = "DuplicateAgentRosterIdError";
  }
}

function assertUniqueNormalizedLegacyRosterIds(value: readonly unknown[]): void {
  const normalizedIds = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      continue;
    }
    const agentId = normalizeAgentId(entry.id);
    if (normalizedIds.has(agentId)) {
      throw new DuplicateAgentRosterIdError(agentId);
    }
    normalizedIds.add(agentId);
  }
}

function hasOwnValidIncludeDirective(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !Object.hasOwn(value, "$include")) {
    return false;
  }
  const includeValue = value.$include;
  return (
    typeof includeValue === "string" ||
    (Array.isArray(includeValue) && includeValue.every((entry) => typeof entry === "string"))
  );
}

function collectConfigPaths(
  value: unknown,
  path: string[],
  matches: (value: unknown) => boolean,
  skip?: (path: string[]) => boolean,
): string[][] {
  if (skip?.(path)) {
    return [];
  }
  if (matches(value)) {
    return [path];
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    collectConfigPaths(child, [...path, key], matches, skip),
  );
}

function collectIncludeOwnedPaths(value: unknown, path: string[] = []): string[][] {
  return collectConfigPaths(value, path, hasOwnValidIncludeDirective);
}

function collectMutableSiblingPathsAtInclude(rootAuthoredConfig: unknown, includePath: string[]) {
  const includeValue = getPathValue(rootAuthoredConfig, includePath);
  if (!hasOwnValidIncludeDirective(includeValue)) {
    return [];
  }
  return Object.keys(includeValue).flatMap((key) =>
    key === "$include" || isBlockedObjectKey(key) ? [] : [[...includePath, key]],
  );
}

function isMutableSiblingPathAtInclude(
  rootAuthoredConfig: unknown,
  includePath: string[],
  path: string[],
): boolean {
  return collectMutableSiblingPathsAtInclude(rootAuthoredConfig, includePath).some(
    (siblingPath) => {
      if (!pathStartsWith(path, siblingPath)) {
        return false;
      }
      const nestedIncludePaths = collectIncludeOwnedPaths(
        getPathValue(rootAuthoredConfig, siblingPath),
        siblingPath,
      );
      return !nestedIncludePaths.some(
        (nestedIncludePath) =>
          pathStartsWith(path, nestedIncludePath) || pathStartsWith(nestedIncludePath, path),
      );
    },
  );
}

function findContainingArrayPath(root: unknown, path: string[]): string[] | undefined {
  let current = root;
  const currentPath: string[] = [];
  for (const segment of path) {
    if (Array.isArray(current)) {
      return currentPath;
    }
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
    currentPath.push(segment);
  }
  return undefined;
}

function hasChangedEquivalentArraySibling(
  value: unknown,
  nextValue: unknown,
  index: number,
): boolean {
  if (!Array.isArray(value) || !Array.isArray(nextValue) || index >= value.length) {
    return false;
  }
  return value.some(
    (item, itemIndex) =>
      itemIndex !== index &&
      isDeepStrictEqual(item, value[index]) &&
      !isDeepStrictEqual(nextValue[itemIndex], item),
  );
}

function hasNewEquivalentArraySibling(value: unknown, nextValue: unknown, index: number): boolean {
  if (!Array.isArray(value) || !Array.isArray(nextValue) || index >= value.length) {
    return false;
  }
  const includedValue = value[index];
  if (!isDeepStrictEqual(nextValue[index], includedValue)) {
    return false;
  }
  return nextValue.some(
    (item, itemIndex) =>
      itemIndex !== index &&
      isDeepStrictEqual(item, includedValue) &&
      !isDeepStrictEqual(value[itemIndex], includedValue),
  );
}

function getPathValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = parseConfigPathArrayIndex(segment);
      if (index === undefined || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function setPathValue(value: unknown, path: string[], nextValue: unknown): unknown {
  if (path.length === 0) {
    return structuredClone(nextValue);
  }
  const head = expectDefined(path[0], "config path head");
  const tail = path.slice(1);
  if (Array.isArray(value)) {
    const index = parseConfigPathArrayIndex(head);
    if (index === undefined || index >= value.length) {
      return value;
    }
    const next = [...value];
    next[index] = setPathValue(value[index], tail, nextValue);
    return next;
  }
  if (!isRecord(value)) {
    return value;
  }
  return {
    ...value,
    [head]: setPathValue(value[head], tail, nextValue),
  };
}

function pathStartsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

function pathOverlapsAny(path: string[], candidates: readonly string[][] | undefined): boolean {
  return Boolean(
    candidates?.some(
      (candidate) => pathStartsWith(path, candidate) || pathStartsWith(candidate, path),
    ),
  );
}

function findOverlappingIncludeOwnedPath(
  rootAuthoredConfig: unknown,
  path: string[],
): string[] | undefined {
  return collectIncludeOwnedPaths(rootAuthoredConfig).find((includePath) => {
    const overlapsInclude = pathStartsWith(path, includePath) || pathStartsWith(includePath, path);
    if (!overlapsInclude) {
      return false;
    }
    return !isMutableSiblingPathAtInclude(rootAuthoredConfig, includePath, path);
  });
}

function setPathValueCreatingParents(value: unknown, path: string[], nextValue: unknown): unknown {
  if (path.length === 0) {
    return structuredClone(nextValue);
  }
  const head = expectDefined(path[0], "config path head");
  const tail = path.slice(1);
  const index = parseConfigPathArrayIndex(head);
  if (Array.isArray(value) || index !== undefined) {
    if (index === undefined) {
      return value;
    }
    const next = Array.isArray(value) ? [...value] : [];
    next[index] = setPathValueCreatingParents(next[index], tail, nextValue);
    return next;
  }
  const record = isRecord(value) ? value : {};
  return {
    ...record,
    [head]: setPathValueCreatingParents(record[head], tail, nextValue),
  };
}

function deletePathValue(value: unknown, path: string[]): unknown {
  if (path.length === 0) {
    return value;
  }
  const head = expectDefined(path[0], "config path head");
  const tail = path.slice(1);
  if (Array.isArray(value)) {
    const index = parseConfigPathArrayIndex(head);
    if (index === undefined || index >= value.length || tail.length === 0) {
      return value;
    }
    const next = [...value];
    next[index] = deletePathValue(value[index], tail);
    return next;
  }
  if (!isRecord(value) || !Object.hasOwn(value, head)) {
    return value;
  }
  const next: Record<string, unknown> = { ...value };
  if (tail.length === 0) {
    delete next[head];
    return next;
  }
  next[head] = deletePathValue(value[head], tail);
  return next;
}

function normalizeTouchedAgentModelMapEntries(params: {
  projectedSource: unknown;
  patch: unknown;
  touchedPaths?: readonly (readonly string[])[];
  explicitSetValueSource: unknown;
}): unknown {
  const touchedMaps = new Map<string, { path: string[]; canonicalKeys: Set<string> }>();
  const addKey = (path: string[], modelId: string) => {
    const serialized = path.join("\0");
    const target = touchedMaps.get(serialized) ?? { path, canonicalKeys: new Set<string>() };
    target.canonicalKeys.add(normalizeAgentModelRefForConfig(modelId));
    touchedMaps.set(serialized, target);
  };

  const defaultsModelsPatch = getPathValue(params.patch, ["agents", "defaults", "models"]);
  if (isRecord(defaultsModelsPatch)) {
    for (const modelId of Object.keys(defaultsModelsPatch)) {
      addKey(["agents", "defaults", "models"], modelId);
    }
  }
  const entriesPatch = getPathValue(params.patch, ["agents", "entries"]);
  if (isRecord(entriesPatch)) {
    for (const [agentId, entryPatch] of Object.entries(entriesPatch)) {
      if (isRecord(entryPatch) && isRecord(entryPatch.models)) {
        for (const modelId of Object.keys(entryPatch.models)) {
          addKey(["agents", "entries", agentId, "models"], modelId);
        }
      }
    }
  }
  const explicitModelMaps: string[][] = [["agents", "defaults", "models"]];
  const explicitEntries = getPathValue(params.explicitSetValueSource, ["agents", "entries"]);
  if (isRecord(explicitEntries)) {
    for (const agentId of Object.keys(explicitEntries)) {
      explicitModelMaps.push(["agents", "entries", agentId, "models"]);
    }
  }
  for (const modelMapPath of explicitModelMaps) {
    for (const explicitPath of params.touchedPaths ?? []) {
      if (pathStartsWith(explicitPath, modelMapPath) && explicitPath.length > modelMapPath.length) {
        const modelId = explicitPath[modelMapPath.length];
        if (modelId) {
          addKey(modelMapPath, modelId);
        }
        continue;
      }
      if (
        !pathStartsWith(explicitPath, modelMapPath) &&
        !pathStartsWith(modelMapPath, explicitPath)
      ) {
        continue;
      }
      const explicitModels = getPathValue(params.explicitSetValueSource, modelMapPath);
      if (!isRecord(explicitModels)) {
        continue;
      }
      for (const modelId of Object.keys(explicitModels)) {
        addKey(modelMapPath, modelId);
      }
    }
  }

  let next = params.projectedSource;
  for (const { path, canonicalKeys } of touchedMaps.values()) {
    const models = getPathValue(next, path);
    if (!isRecord(models)) {
      continue;
    }
    const touchedEntries: Array<[string, unknown]> = [];
    const untouchedEntries: Array<[string, unknown]> = [];
    let hasRetiredTouchedKey = false;
    for (const [modelId, entry] of Object.entries(models)) {
      const normalizedModelId = normalizeAgentModelRefForConfig(modelId);
      if (!canonicalKeys.has(normalizedModelId)) {
        untouchedEntries.push([modelId, entry]);
        continue;
      }
      touchedEntries.push([modelId, entry]);
      hasRetiredTouchedKey ||= normalizedModelId !== modelId;
    }
    if (hasRetiredTouchedKey) {
      const normalizedTouchedEntries = normalizeAgentModelMapForConfig(
        Object.fromEntries(touchedEntries),
      );
      next = setPathValue(
        next,
        path,
        Object.fromEntries([...untouchedEntries, ...Object.entries(normalizedTouchedEntries)]),
      );
    }
  }
  return next;
}

function preserveSourceValueAtPath(params: {
  persistedCandidate: unknown;
  sourceConfig: unknown;
  nextConfig: unknown;
  rootAuthoredConfig: unknown;
  unsetPaths?: readonly string[][];
  path: string[];
  sourceValue?: unknown;
}): unknown {
  if (pathOverlapsAny(params.path, params.unsetPaths)) {
    return params.persistedCandidate;
  }
  if (findOverlappingIncludeOwnedPath(params.rootAuthoredConfig, params.path)) {
    return params.persistedCandidate;
  }
  if (getPathValue(params.nextConfig, params.path) !== undefined) {
    return params.persistedCandidate;
  }
  const sourceValue = params.sourceValue ?? getPathValue(params.sourceConfig, params.path);
  if (
    sourceValue === undefined ||
    getPathValue(params.persistedCandidate, params.path) !== undefined
  ) {
    return params.persistedCandidate;
  }
  return setPathValueCreatingParents(params.persistedCandidate, params.path, sourceValue);
}

function preserveAuthoredAgentParams(params: {
  persistedCandidate: unknown;
  sourceConfig: unknown;
  nextConfig: unknown;
  rootAuthoredConfig: unknown;
  unsetPaths?: readonly string[][];
}): unknown {
  const defaults = getPathValue(params.sourceConfig, ["agents", "defaults"]);
  if (!isRecord(defaults)) {
    return params.persistedCandidate;
  }

  let next = params.persistedCandidate;
  if (Object.hasOwn(defaults, "params")) {
    next = preserveSourceValueAtPath({
      ...params,
      persistedCandidate: next,
      path: ["agents", "defaults", "params"],
      sourceValue: defaults.params,
    });
  }

  const models = defaults.models;
  if (!isRecord(models)) {
    return next;
  }
  const nextModels = getPathValue(params.nextConfig, ["agents", "defaults", "models"]);
  for (const [modelId, modelEntry] of Object.entries(models)) {
    if (!isRecord(modelEntry) || !Object.hasOwn(modelEntry, "params")) {
      continue;
    }
    const modelPath = [
      "agents",
      "defaults",
      "models",
      normalizeAgentModelRefForConfig(modelId) || modelId,
    ];
    const normalizedModelId = modelPath.at(-1);
    if (
      isRecord(nextModels) &&
      normalizedModelId &&
      !Object.hasOwn(nextModels, normalizedModelId)
    ) {
      continue;
    }
    const preserveModel = getPathValue(next, modelPath) === undefined;
    next = preserveSourceValueAtPath({
      ...params,
      persistedCandidate: next,
      path: preserveModel ? modelPath : [...modelPath, "params"],
      sourceValue: preserveModel ? modelEntry : modelEntry.params,
    });
  }
  return next;
}

type IncludeSiblingProjection =
  | { ok: true; present: false }
  | { ok: true; present: true; value: unknown }
  | { ok: false };

function isRootOwnedArray(authored: unknown, baseline: unknown, sourceBeforeMigrations: unknown) {
  // Includes concatenate; env resolution preserves slots. Only the pre-migration
  // length can prove sole root ownership when authored and resolved bytes differ.
  return (
    (authored === undefined || Array.isArray(authored)) &&
    collectIncludeOwnedPaths(authored).length === 0 &&
    (Array.isArray(sourceBeforeMigrations)
      ? (authored?.length ?? 0) === sourceBeforeMigrations.length
      : Array.isArray(authored) && isDeepStrictEqual(authored, baseline))
  );
}

function projectRootAuthoredIncludeSibling(params: {
  authored: unknown;
  baseline: unknown;
  sourceBeforeMigrations: unknown;
  next: unknown;
  baselinePresent: boolean;
  nextPresent: boolean;
}): IncludeSiblingProjection {
  if (
    params.nextPresent &&
    params.baselinePresent &&
    isDeepStrictEqual(params.next, params.baseline)
  ) {
    return { ok: true, present: true, value: structuredClone(params.authored) };
  }
  if (!params.nextPresent) {
    return collectIncludeOwnedPaths(params.authored).length > 0
      ? { ok: false }
      : { ok: true, present: false };
  }
  if (!params.baselinePresent) {
    return { ok: true, present: true, value: structuredClone(params.next) };
  }
  if (hasOwnValidIncludeDirective(params.authored)) {
    return { ok: false };
  }
  if (Array.isArray(params.authored)) {
    return (
      Array.isArray(params.next)
        ? isRootOwnedArray(params.authored, params.baseline, params.sourceBeforeMigrations)
        : collectIncludeOwnedPaths(params.authored).length === 0
    )
      ? { ok: true, present: true, value: structuredClone(params.next) }
      : { ok: false };
  }
  if (!isRecord(params.authored)) {
    return { ok: true, present: true, value: structuredClone(params.next) };
  }
  if (!isRecord(params.next)) {
    return collectIncludeOwnedPaths(params.authored).length > 0
      ? { ok: false }
      : { ok: true, present: true, value: structuredClone(params.next) };
  }
  if (!isRecord(params.baseline)) {
    return { ok: true, present: true, value: structuredClone(params.next) };
  }

  const value: Record<string, unknown> = structuredClone(params.authored);
  const keys = new Set([
    ...Object.keys(params.authored),
    ...Object.keys(params.baseline),
    ...Object.keys(params.next),
  ]);
  for (const key of keys) {
    if (isBlockedObjectKey(key)) {
      continue;
    }
    const authoredPresent = Object.hasOwn(params.authored, key);
    const baselinePresent = Object.hasOwn(params.baseline, key);
    const nextPresent = Object.hasOwn(params.next, key);
    if (!authoredPresent) {
      if (
        baselinePresent &&
        nextPresent &&
        isDeepStrictEqual(params.baseline[key], params.next[key])
      ) {
        continue;
      }
      if (!nextPresent) {
        return { ok: false };
      }
      if (
        baselinePresent &&
        Array.isArray(params.baseline[key]) &&
        Array.isArray(params.next[key])
      ) {
        return { ok: false };
      }
    }
    const projected = projectRootAuthoredIncludeSibling({
      authored: authoredPresent ? params.authored[key] : {},
      baseline: params.baseline[key],
      sourceBeforeMigrations: getPathValue(params.sourceBeforeMigrations, [key]),
      next: params.next[key],
      baselinePresent,
      nextPresent,
    });
    if (!projected.ok) {
      return projected;
    }
    if (projected.present) {
      value[key] = projected.value;
    } else {
      delete value[key];
    }
  }
  return { ok: true, present: true, value };
}

function includeOwnershipError(rootAuthoredConfig: unknown, includePath: string[]): Error {
  const directive = getPathValue(rootAuthoredConfig, [...includePath, "$include"]);
  const includeTargets = (Array.isArray(directive) ? directive : [directive]).filter(
    (entry): entry is string => typeof entry === "string",
  );
  return createConfigIncludeOwnershipError({
    ownedConfigPath: includePath.length > 0 ? includePath.join(".") : "<root>",
    ...(includeTargets.length > 0 ? { includeTargets } : {}),
  });
}

function preserveUntouchedIncludes(params: {
  runtimeConfig: unknown;
  sourceConfig: unknown;
  sourceConfigBeforeMigrations?: unknown;
  nextConfig: unknown;
  rootAuthoredConfig: unknown;
  persistedCandidate: unknown;
}): unknown {
  let next = params.persistedCandidate;
  for (const includePath of collectIncludeOwnedPaths(params.rootAuthoredConfig)) {
    const containingArrayPath = findContainingArrayPath(params.rootAuthoredConfig, includePath);
    const includeIsArrayEntry =
      containingArrayPath !== undefined && includePath.length === containingArrayPath.length + 1;
    // Whole-entry array includes keep their positional ownership while allowing
    // unrelated sibling edits. Nested array includes require the array unchanged.
    const comparisonPath = includeIsArrayEntry ? includePath : (containingArrayPath ?? includePath);
    const mutableSiblingPaths = collectMutableSiblingPathsAtInclude(
      params.rootAuthoredConfig,
      includePath,
    );
    const relativeMutableSiblingPaths = mutableSiblingPaths.map((path) =>
      path.slice(comparisonPath.length),
    );
    const omitMutableSiblingValues = (value: unknown) =>
      relativeMutableSiblingPaths.reduce((current, path) => deletePathValue(current, path), value);
    const nextValue = omitMutableSiblingValues(getPathValue(params.nextConfig, comparisonPath));
    const sourceValue = omitMutableSiblingValues(getPathValue(params.sourceConfig, comparisonPath));
    const runtimeValue = omitMutableSiblingValues(
      getPathValue(params.runtimeConfig, comparisonPath),
    );
    if (!isDeepStrictEqual(nextValue, sourceValue) && !isDeepStrictEqual(nextValue, runtimeValue)) {
      throw includeOwnershipError(params.rootAuthoredConfig, includePath);
    }
    if (includeIsArrayEntry) {
      const index = parseConfigPathArrayIndex(includePath.at(-1) ?? "");
      const nextArray = getPathValue(params.nextConfig, containingArrayPath);
      const sourceArray = getPathValue(params.sourceConfig, containingArrayPath);
      const runtimeArray = getPathValue(params.runtimeConfig, containingArrayPath);
      if (
        index !== undefined &&
        (hasChangedEquivalentArraySibling(sourceArray, nextArray, index) ||
          hasChangedEquivalentArraySibling(runtimeArray, nextArray, index) ||
          hasNewEquivalentArraySibling(sourceArray, nextArray, index) ||
          hasNewEquivalentArraySibling(runtimeArray, nextArray, index))
      ) {
        throw includeOwnershipError(params.rootAuthoredConfig, includePath);
      }
    }
    let authoredIncludeValue = getPathValue(params.rootAuthoredConfig, includePath);
    for (const siblingPath of mutableSiblingPaths) {
      const relativeSiblingPath = siblingPath.slice(includePath.length);
      // Reuse the source projection so unchanged runtime defaults never become authored siblings.
      const nextPresent = hasPathValue(params.persistedCandidate, siblingPath);
      const projectAgainst = (baselineConfig: unknown) =>
        projectRootAuthoredIncludeSibling({
          authored: getPathValue(params.rootAuthoredConfig, siblingPath),
          baseline: getPathValue(baselineConfig, siblingPath),
          sourceBeforeMigrations: getPathValue(params.sourceConfigBeforeMigrations, siblingPath),
          next: getPathValue(params.persistedCandidate, siblingPath),
          baselinePresent: hasPathValue(baselineConfig, siblingPath),
          nextPresent,
        });
      const sourceProjection = projectAgainst(params.sourceConfig);
      const projection = sourceProjection.ok
        ? sourceProjection
        : projectAgainst(params.runtimeConfig);
      if (!projection.ok) {
        throw includeOwnershipError(params.rootAuthoredConfig, includePath);
      }
      authoredIncludeValue = projection.present
        ? setPathValue(authoredIncludeValue, relativeSiblingPath, projection.value)
        : deletePathValue(authoredIncludeValue, relativeSiblingPath);
    }
    next = setPathValue(next, includePath, authoredIncludeValue);
  }
  return next;
}

function hasPathValue(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) {
    return true;
  }
  const head = expectDefined(path[0], "config path head");
  const tail = path.slice(1);
  if (Array.isArray(value)) {
    const index = parseConfigPathArrayIndex(head);
    if (index === undefined || index >= value.length) {
      return false;
    }
    return tail.length === 0 || hasPathValue(value[index], tail);
  }
  if (!isRecord(value)) {
    return false;
  }
  if (isBlockedObjectKey(head) || !Object.hasOwn(value, head)) {
    return false;
  }
  return tail.length === 0 || hasPathValue(value[head], tail);
}

function mergeMissingExplicitValues(
  currentValue: unknown,
  explicitValue: unknown,
): {
  changed: boolean;
  value: unknown;
} {
  // Explicit ancestor writes must not copy resolved descendants back into preserved includes.
  if (hasOwnValidIncludeDirective(currentValue)) {
    return { changed: false, value: currentValue };
  }
  if (!isRecord(currentValue) || !isRecord(explicitValue)) {
    if (!Array.isArray(currentValue) || !Array.isArray(explicitValue)) {
      return { changed: false, value: currentValue };
    }
    let changed = false;
    const next = [...currentValue];
    for (const [key, childExplicitValue] of Object.entries(explicitValue)) {
      const index = parseConfigPathArrayIndex(key);
      if (index === undefined) {
        continue;
      }
      if (index >= next.length || next[index] === undefined) {
        next[index] = structuredClone(childExplicitValue);
        changed = true;
        continue;
      }
      const childMerged = mergeMissingExplicitValues(next[index], childExplicitValue);
      if (childMerged.changed) {
        next[index] = childMerged.value;
        changed = true;
      }
    }
    return { changed, value: changed ? next : currentValue };
  }
  let changed = false;
  const next: Record<string, unknown> = { ...currentValue };
  for (const [key, childExplicitValue] of Object.entries(explicitValue)) {
    if (isBlockedObjectKey(key)) {
      continue;
    }
    if (!Object.hasOwn(next, key)) {
      next[key] = structuredClone(childExplicitValue);
      changed = true;
      continue;
    }
    const childMerged = mergeMissingExplicitValues(next[key], childExplicitValue);
    if (childMerged.changed) {
      next[key] = childMerged.value;
      changed = true;
    }
  }
  return { changed, value: changed ? next : currentValue };
}

export function injectExplicitlySetPaths(params: {
  valueSource: unknown;
  persistedCandidate: unknown;
  runtimeConfig: unknown;
  sourceConfig: unknown;
  sourceConfigBeforeMigrations?: unknown;
  explicitSetPaths?: readonly (readonly string[])[];
  rootAuthoredConfig?: unknown;
  preserveDescendantIncludes?: boolean;
  allowIncludeAncestorExplicitSetPaths?: boolean;
}): unknown {
  if (!params.explicitSetPaths || params.explicitSetPaths.length === 0) {
    return params.persistedCandidate;
  }

  const includePaths = collectIncludeOwnedPaths(params.rootAuthoredConfig);
  let next = params.persistedCandidate;
  explicitPath: for (const path of params.explicitSetPaths) {
    if (path.length === 0 || path.some(isBlockedObjectKey)) {
      continue;
    }
    const includeOwnedPath = params.rootAuthoredConfig
      ? findOverlappingIncludeOwnedPath(params.rootAuthoredConfig, [...path])
      : undefined;
    const preserveDescendantInclude =
      includeOwnedPath &&
      params.preserveDescendantIncludes === true &&
      includeOwnedPath.length > path.length &&
      pathStartsWith(includeOwnedPath, path);
    const allowIncludeAncestorOverride =
      includeOwnedPath !== undefined &&
      includeOwnedPath.length < path.length &&
      pathStartsWith(path, includeOwnedPath) &&
      params.allowIncludeAncestorExplicitSetPaths === true;
    if (includeOwnedPath && !preserveDescendantInclude && !allowIncludeAncestorOverride) {
      throw includeOwnershipError(params.rootAuthoredConfig, includeOwnedPath);
    }
    let nextValue = getPathValue(params.valueSource, [...path]);
    if (nextValue === undefined) {
      continue;
    }
    const arrayPaths =
      includePaths.length > 0
        ? [
            ...path.flatMap((_, index) => {
              const parent = path.slice(0, index);
              return Array.isArray(getPathValue(params.valueSource, parent)) ? [parent] : [];
            }),
            ...collectConfigPaths(nextValue, [...path], Array.isArray, (candidatePath) =>
              hasOwnValidIncludeDirective(getPathValue(next, candidatePath)),
            ),
          ]
        : [];
    for (const arrayPath of arrayPaths) {
      const owner = includePaths.find((includePath) => pathStartsWith(arrayPath, includePath));
      if (
        owner &&
        !isRootOwnedArray(
          getPathValue(params.rootAuthoredConfig, arrayPath),
          getPathValue(params.sourceConfig, arrayPath),
          getPathValue(params.sourceConfigBeforeMigrations, arrayPath),
        )
      ) {
        const valuePath = arrayPath.length < path.length ? [...path] : arrayPath;
        const requested = getPathValue(params.valueSource, valuePath);
        if (
          !isDeepStrictEqual(requested, getPathValue(params.sourceConfig, valuePath)) &&
          !isDeepStrictEqual(requested, getPathValue(params.runtimeConfig, valuePath))
        ) {
          throw includeOwnershipError(params.rootAuthoredConfig, owner);
        }
        // An already-satisfied write retains the authored contribution; copying the
        // composed array (or its index) would concatenate included entries again.
        if (arrayPath.length <= path.length) {
          continue explicitPath;
        }
        const retained = getPathValue(next, arrayPath);
        const relativePath = arrayPath.slice(path.length);
        nextValue =
          retained === undefined
            ? deletePathValue(nextValue, relativePath)
            : setPathValue(nextValue, relativePath, retained);
      }
    }
    if (!hasPathValue(next, path)) {
      next = setPathValueCreatingParents(next, [...path], nextValue);
      continue;
    }
    const merged = mergeMissingExplicitValues(getPathValue(next, [...path]), nextValue);
    if (merged.changed) {
      next = setPathValue(next, [...path], merged.value);
    }
  }
  return next;
}

function pathTouchesAgentRoster(path: readonly string[]): boolean {
  return AGENT_ROSTER_PATHS.some(
    (rosterPath) => pathStartsWith(path, rosterPath) || pathStartsWith(rosterPath, path),
  );
}

function pathTargetsAgentRoster(path: readonly string[]): boolean {
  return AGENT_ROSTER_PATHS.some((rosterPath) => pathStartsWith(path, rosterPath));
}

function hasOnlyPreparedKeyedAgentEntryRosterIncludes(
  rootAuthoredConfig: unknown,
  preparedIncludePaths: readonly (readonly string[])[] | undefined,
): boolean {
  const authoredEntries = getPathValue(rootAuthoredConfig, ["agents", "entries"]);
  if (!isRecord(authoredEntries) || !preparedIncludePaths || preparedIncludePaths.length === 0) {
    return false;
  }
  const rosterIncludePaths = collectIncludeOwnedPaths(rootAuthoredConfig).filter((path) =>
    pathTouchesAgentRoster(path),
  );
  // Whole-entry includes can be restored independently while their containing map accepts siblings.
  // Broader or nested include paths still own the roster boundary and must fail closed.
  return (
    rosterIncludePaths.length > 0 &&
    rosterIncludePaths.every(
      (path) =>
        path.length === 3 &&
        path[0] === "agents" &&
        path[1] === "entries" &&
        preparedIncludePaths.some(
          (prepared) =>
            prepared.length === path.length &&
            path.every((segment, index) => segment === prepared[index]),
        ),
    ) &&
    preparedIncludePaths.length === rosterIncludePaths.length
  );
}

function canCanonicalizeAgentRoster(value: unknown): boolean {
  const roster = readAgentRosterProperty(value);
  if (!roster) {
    return false;
  }
  if (roster.kind === "list") {
    if (
      !Array.isArray(roster.value) ||
      !roster.value.every((entry) => isRecord(entry) && typeof entry.id === "string")
    ) {
      return false;
    }
    assertUniqueNormalizedLegacyRosterIds(roster.value);
    return true;
  }
  return isRecord(roster.value) && Object.values(roster.value).every(isRecord);
}

function shouldPersistCanonicalAgentRoster(params: {
  runtimeConfig: unknown;
  sourceConfig: unknown;
  nextConfig: unknown;
  persistCanonicalAgentRoster?: boolean;
  explicitSetPaths?: readonly (readonly string[])[];
  unsetPaths?: readonly (readonly string[])[];
}): boolean {
  if (!canCanonicalizeAgentRoster(params.nextConfig)) {
    return false;
  }
  if (
    params.persistCanonicalAgentRoster === true ||
    params.explicitSetPaths?.some(pathTouchesAgentRoster) ||
    params.unsetPaths?.some(pathTouchesAgentRoster)
  ) {
    return true;
  }
  const runtimeRoster = toAgentEntriesRecord(
    listAgentEntries(params.runtimeConfig as OpenClawConfig),
  );
  const sourceRoster = toAgentEntriesRecord(
    listAgentEntries(params.sourceConfig as OpenClawConfig),
  );
  const nextRoster = toAgentEntriesRecord(listAgentEntries(params.nextConfig as OpenClawConfig));
  return (
    !isDeepStrictEqual(runtimeRoster, nextRoster) && !isDeepStrictEqual(sourceRoster, nextRoster)
  );
}

function assertCanonicalAgentRosterRetainsEntries(params: {
  currentConfig: unknown;
  canonicalConfig: unknown;
  allowedRemovals?: readonly string[];
}): void {
  const allowedRemovals = new Set(
    (params.allowedRemovals ?? []).map((agentId) => normalizeAgentId(agentId)),
  );
  const canonicalIds = new Set(
    listAgentEntries(params.canonicalConfig as OpenClawConfig).map((entry) =>
      normalizeAgentId(entry.id),
    ),
  );
  // Legacy rows can share or omit ids; retain the identities Doctor assigns to each occurrence.
  const currentRoster = readAgentRosterProperty(params.currentConfig);
  const currentEntries =
    currentRoster?.kind === "list" && Array.isArray(currentRoster.value)
      ? projectLegacyAgentRosterEntries(currentRoster.value).entries
      : listAgentEntries(params.currentConfig as OpenClawConfig);
  const droppedIds = currentEntries
    .filter((entry) => {
      const agentId = normalizeAgentId(entry.id);
      return !canonicalIds.has(agentId) && !allowedRemovals.has(agentId);
    })
    .map((entry) => entry.id)
    .toSorted();
  if (droppedIds.length === 0) {
    return;
  }
  throw new Error(
    `Config write would drop agent roster entries without an explicit deletion: ${droppedIds.join(", ")}.`,
  );
}

type ProjectedRosterValue = { present: false } | { present: true; value: unknown };

function containsAuthoredRosterReference(value: unknown, includeEnvStrings: boolean): boolean {
  if (typeof value === "string") {
    return includeEnvStrings && containsEnvVarReference(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsAuthoredRosterReference(entry, includeEnvStrings));
  }
  if (!isRecord(value)) {
    return false;
  }
  return (
    isSecretRefShape(value) ||
    Object.values(value).some((entry) => containsAuthoredRosterReference(entry, includeEnvStrings))
  );
}

function indexAgentRosterSourcePaths(
  config: OpenClawConfig,
  legacyIdsByIndex: ReadonlyMap<number, string>,
): Map<string, string> {
  return new Map(
    listAgentEntriesWithSource(config).flatMap(({ entry, source }): [string, string][] => {
      const id = source.kind === "list" ? legacyIdsByIndex.get(source.index) : entry.id;
      return id === undefined
        ? []
        : [
            [
              normalizeAgentId(id),
              source.kind === "list"
                ? `agents.list[${source.index}]`
                : `agents.entries.${source.key}`,
            ],
          ];
    }),
  );
}

function projectAuthoredRosterValue(params: {
  authored: unknown;
  authoredPresent: boolean;
  explicit: unknown;
  explicitPresent: boolean;
  explicitPaths: readonly (readonly string[])[];
  path: readonly string[];
  runtime: unknown;
  runtimePresent: boolean;
  source: unknown;
  sourcePresent: boolean;
  next: unknown;
  nextPresent: boolean;
}): ProjectedRosterValue {
  if (!params.nextPresent) {
    return { present: false };
  }
  const explicitlySet = params.explicitPaths.some((path) => pathStartsWith(params.path, path));
  if (isRecord(params.next)) {
    const authored = isRecord(params.authored) ? params.authored : {};
    const explicit = isRecord(params.explicit) ? params.explicit : {};
    const runtime = isRecord(params.runtime) ? params.runtime : {};
    const source = isRecord(params.source) ? params.source : {};
    const value: Record<string, unknown> = {};
    for (const [key, nextValue] of Object.entries(params.next)) {
      if (isBlockedObjectKey(key)) {
        continue;
      }
      const projected = projectAuthoredRosterValue({
        authored: authored[key],
        authoredPresent: Object.hasOwn(authored, key),
        explicit: explicit[key],
        explicitPresent: Object.hasOwn(explicit, key),
        explicitPaths: params.explicitPaths,
        path: [...params.path, key],
        runtime: runtime[key],
        runtimePresent: Object.hasOwn(runtime, key),
        source: source[key],
        sourcePresent: Object.hasOwn(source, key),
        next: nextValue,
        nextPresent: true,
      });
      if (projected.present) {
        value[key] = projected.value;
      }
    }
    return { present: true, value };
  }
  if (Array.isArray(params.next)) {
    if (explicitlySet && params.explicitPresent && Array.isArray(params.explicit)) {
      return { present: true, value: structuredClone(params.explicit) };
    }
    const authored = Array.isArray(params.authored) ? params.authored : [];
    const explicit = Array.isArray(params.explicit) ? params.explicit : [];
    const runtime = Array.isArray(params.runtime) ? params.runtime : [];
    const source = Array.isArray(params.source) ? params.source : [];
    const usedRuntimeIndexes = new Set<number>();
    const usedSourceIndexes = new Set<number>();
    const findMatchingIndex = (
      values: unknown[],
      used: Set<number>,
      nextValue: unknown,
      preferredIndex: number,
    ): number | undefined => {
      if (
        preferredIndex < values.length &&
        !used.has(preferredIndex) &&
        isDeepStrictEqual(values[preferredIndex], nextValue)
      ) {
        return preferredIndex;
      }
      const index = values.findIndex(
        (value, candidate) => !used.has(candidate) && isDeepStrictEqual(value, nextValue),
      );
      return index >= 0 ? index : undefined;
    };
    return {
      present: true,
      value: params.next.map((nextValue, index) => {
        const runtimeIndex = findMatchingIndex(runtime, usedRuntimeIndexes, nextValue, index);
        if (runtimeIndex !== undefined) {
          usedRuntimeIndexes.add(runtimeIndex);
        }
        const sourceIndex = findMatchingIndex(source, usedSourceIndexes, nextValue, index);
        if (sourceIndex !== undefined) {
          usedSourceIndexes.add(sourceIndex);
        }
        const fallbackIndexAvailable =
          !usedRuntimeIndexes.has(index) && !usedSourceIndexes.has(index);
        const authoredIndex =
          runtimeIndex ?? sourceIndex ?? (fallbackIndexAvailable ? index : undefined);
        const projected = projectAuthoredRosterValue({
          authored: authoredIndex === undefined ? undefined : authored[authoredIndex],
          authoredPresent: authoredIndex !== undefined && authoredIndex < authored.length,
          explicit: explicit[index],
          explicitPresent: index < explicit.length,
          explicitPaths: params.explicitPaths,
          path: [...params.path, String(index)],
          runtime:
            runtimeIndex === undefined
              ? fallbackIndexAvailable
                ? runtime[index]
                : undefined
              : runtime[runtimeIndex],
          runtimePresent:
            runtimeIndex !== undefined || (fallbackIndexAvailable && index < runtime.length),
          source:
            sourceIndex === undefined
              ? fallbackIndexAvailable
                ? source[index]
                : undefined
              : source[sourceIndex],
          sourcePresent:
            sourceIndex !== undefined || (fallbackIndexAvailable && index < source.length),
          next: nextValue,
          nextPresent: true,
        });
        return projected.present ? projected.value : nextValue;
      }),
    };
  }
  if (explicitlySet && params.explicitPresent) {
    return { present: true, value: structuredClone(params.explicit) };
  }
  const unchangedFromRuntime =
    params.runtimePresent && isDeepStrictEqual(params.runtime, params.next);
  const unchangedFromSource = params.sourcePresent && isDeepStrictEqual(params.source, params.next);
  return {
    present: true,
    value:
      params.authoredPresent && (unchangedFromRuntime || unchangedFromSource)
        ? structuredClone(params.authored)
        : structuredClone(params.next),
  };
}

function indexAgentRosterForWrite(config: unknown, legacyIdsByIndex: ReadonlyMap<number, string>) {
  const roster = readAgentRosterProperty(config);
  if (roster?.kind !== "list" || !Array.isArray(roster.value)) {
    return toAgentEntriesRecord(listAgentEntries(config as OpenClawConfig)) as Record<
      string,
      unknown
    >;
  }
  return Object.fromEntries(
    roster.value.flatMap((entry, index): [string, Record<string, unknown>][] => {
      const id = legacyIdsByIndex.get(index);
      if (!isRecord(entry) || id === undefined) {
        return [];
      }
      const { id: _legacyId, ...value } = entry;
      return [[id, value]];
    }),
  );
}

function canonicalizeAgentRosterForExplicitWrite(params: {
  valueSource: unknown;
  rootAuthoredConfig: unknown;
  runtimeConfig: unknown;
  sourceConfig: unknown;
  sourceConfigBeforeMigrations?: unknown;
  nextConfig: unknown;
  explicitSetPaths?: readonly (readonly string[])[];
  unsetPaths?: readonly (readonly string[])[];
}): unknown {
  const authoredRoster = readAgentRosterProperty(params.rootAuthoredConfig);
  const preMigrationRoster = readAgentRosterProperty(params.sourceConfigBeforeMigrations);
  const resolvedLegacyList =
    preMigrationRoster?.kind === "list" && Array.isArray(preMigrationRoster.value)
      ? preMigrationRoster.value
      : undefined;
  // Use Doctor's original occurrences before any map can collapse duplicate or unnamed ids.
  // Reindex the three prior views without applying migrations to their field values.
  const legacyIdsByIndex = new Map(
    projectLegacyAgentRosterEntries(
      resolvedLegacyList ??
        (authoredRoster?.kind === "list" && Array.isArray(authoredRoster.value)
          ? authoredRoster.value
          : []),
    ).entries.map(({ sourceIndex, id }) => [sourceIndex, id]),
  );
  const authoredEntries = indexAgentRosterForWrite(params.rootAuthoredConfig, legacyIdsByIndex);
  const runtimeEntries = indexAgentRosterForWrite(params.runtimeConfig, legacyIdsByIndex);
  const sourceEntries = indexAgentRosterForWrite(params.sourceConfig, legacyIdsByIndex);
  const nextEntries = toAgentEntriesRecord(
    listAgentEntries(params.nextConfig as OpenClawConfig),
  ) as Record<string, unknown>;
  const explicitRoster = readAgentRosterProperty(params.valueSource);
  const rosterFactOwner = coerceConfig(
    params.sourceConfigBeforeMigrations ?? params.rootAuthoredConfig,
  );
  const sourcePathsByAgentId = indexAgentRosterSourcePaths(rosterFactOwner, legacyIdsByIndex);
  const resolutionEvaluated = getConfigResolutionFacts(rosterFactOwner) !== null;
  const renamedLegacyIndexes = new Set(
    (params.explicitSetPaths ?? []).flatMap((path) => {
      if (path[0] !== "agents" || path[1] !== "list" || path.length !== 4 || path[3] !== "id") {
        return [];
      }
      const index = parseConfigPathArrayIndex(path[2] ?? "");
      return index === undefined ? [] : [index];
    }),
  );
  const structurallyExplicitLegacyIndexes = new Set(renamedLegacyIndexes);
  for (const path of params.explicitSetPaths ?? []) {
    if (path[0] !== "agents" || path[1] !== "list") {
      continue;
    }
    if (
      path.length === 2 &&
      explicitRoster?.kind === "list" &&
      Array.isArray(explicitRoster.value)
    ) {
      explicitRoster.value.forEach((_entry, index) => structurallyExplicitLegacyIndexes.add(index));
      continue;
    }
    if (path.length === 3) {
      const index = parseConfigPathArrayIndex(path[2] ?? "");
      if (index !== undefined) {
        structurallyExplicitLegacyIndexes.add(index);
      }
    }
  }
  for (const index of renamedLegacyIndexes) {
    const entry =
      explicitRoster?.kind === "list" && Array.isArray(explicitRoster.value)
        ? explicitRoster.value[index]
        : undefined;
    if (
      isRecord(entry) &&
      typeof entry.id === "string" &&
      (hasUnresolvedConfigPath(rosterFactOwner, `agents.list[${index}].id`) ||
        (!resolutionEvaluated && containsEnvVarReference(entry.id)))
    ) {
      throw new Error(
        "Config write cannot safely resolve an env-backed renamed agent id; set the resolved literal id or rename the authored entry directly.",
      );
    }
  }
  const resolveExplicitLegacyEntryId = (entry: Record<string, unknown>, index: number) => {
    const explicitId = entry.id;
    if (typeof explicitId !== "string") {
      return undefined;
    }
    if (renamedLegacyIndexes.has(index) || Object.hasOwn(nextEntries, explicitId)) {
      return explicitId;
    }
    if (authoredRoster?.kind === "list" && Array.isArray(authoredRoster.value)) {
      const authoredIndex = authoredRoster.value.findIndex(
        (authoredEntry) => isRecord(authoredEntry) && authoredEntry.id === explicitId,
      );
      const resolvedEntry = authoredIndex < 0 ? undefined : resolvedLegacyList?.[authoredIndex];
      if (isRecord(resolvedEntry) && typeof resolvedEntry.id === "string") {
        return resolvedEntry.id;
      }
    }
    return hasUnresolvedConfigPath(rosterFactOwner, `agents.list[${index}].id`) ||
      containsEnvVarReference(explicitId)
      ? undefined
      : explicitId;
  };
  if (explicitRoster?.kind === "list" && Array.isArray(explicitRoster.value)) {
    const normalizedIds = new Set<string>();
    for (const [index, entry] of explicitRoster.value.entries()) {
      if (!isRecord(entry)) {
        continue;
      }
      const resolvedId = resolveExplicitLegacyEntryId(entry, index);
      if (resolvedId === undefined) {
        continue;
      }
      const agentId = normalizeAgentId(resolvedId);
      if (normalizedIds.has(agentId)) {
        throw new DuplicateAgentRosterIdError(agentId);
      }
      normalizedIds.add(agentId);
    }
  }
  const explicitEntries =
    explicitRoster?.kind === "list" && Array.isArray(explicitRoster.value)
      ? Object.fromEntries(
          explicitRoster.value.flatMap((entry, index) => {
            if (!isRecord(entry)) {
              return [];
            }
            const id = structurallyExplicitLegacyIndexes.has(index)
              ? resolveExplicitLegacyEntryId(entry, index)
              : (legacyIdsByIndex.get(index) ?? entry.id);
            if (typeof id !== "string") {
              if (structurallyExplicitLegacyIndexes.has(index) && typeof entry.id === "string") {
                throw new Error(
                  `Config write cannot safely resolve an explicitly replaced agent list slot for id "${entry.id}"; use a resolved literal id before writing the roster.`,
                );
              }
              return [];
            }
            const { id: _explicitId, ...config } = entry;
            return [[id, config]];
          }),
        )
      : (toAgentEntriesRecord(listAgentEntries(params.valueSource as OpenClawConfig)) as Record<
          string,
          unknown
        >);
  const explicitPaths = (params.explicitSetPaths ?? []).flatMap((path) => {
    if (path[0] !== "agents") {
      return [];
    }
    if (path.length === 1) {
      return [[]];
    }
    if (path[1] === "entries") {
      return [path.slice(2)];
    }
    if (path[1] !== "list") {
      return [];
    }
    if (path.length === 2) {
      return [[]];
    }
    const index = parseConfigPathArrayIndex(path[2] ?? "");
    const explicitEntry =
      explicitRoster?.kind === "list" && Array.isArray(explicitRoster.value) && index !== undefined
        ? explicitRoster.value[index]
        : undefined;
    const usesExplicitId =
      index !== undefined &&
      (renamedLegacyIndexes.has(index) ||
        (path.length === 3 && structurallyExplicitLegacyIndexes.has(index)));
    const id =
      usesExplicitId && isRecord(explicitEntry)
        ? explicitEntry.id
        : index === undefined
          ? undefined
          : legacyIdsByIndex.get(index);
    return typeof id === "string" ? [[id, ...path.slice(3)]] : [];
  });
  const entryIdentityByNextId = new Map<string, string>();
  for (const id of Object.keys(nextEntries)) {
    if (Object.hasOwn(runtimeEntries, id) || Object.hasOwn(sourceEntries, id)) {
      entryIdentityByNextId.set(id, id);
    }
  }
  if (
    authoredRoster?.kind === "list" &&
    Array.isArray(authoredRoster.value) &&
    explicitRoster?.kind === "list" &&
    Array.isArray(explicitRoster.value)
  ) {
    for (const path of params.explicitSetPaths ?? []) {
      if (path[0] !== "agents" || path[1] !== "list" || path.length !== 4 || path[3] !== "id") {
        continue;
      }
      const index = parseConfigPathArrayIndex(path[2] ?? "");
      const explicitEntry = index === undefined ? undefined : explicitRoster.value[index];
      const oldId = index === undefined ? undefined : legacyIdsByIndex.get(index);
      const nextId = isRecord(explicitEntry) ? explicitEntry.id : undefined;
      if (typeof oldId === "string" && typeof nextId === "string") {
        entryIdentityByNextId.set(nextId, oldId);
      }
    }
  }
  const priorIds = new Set([...Object.keys(runtimeEntries), ...Object.keys(sourceEntries)]);
  const removedIds = [...priorIds].filter((id) => !Object.hasOwn(nextEntries, id));
  const addedIds = Object.keys(nextEntries).filter((id) => !priorIds.has(id));
  const claimedPriorIds = new Set(entryIdentityByNextId.values());
  for (const nextId of addedIds) {
    if (entryIdentityByNextId.has(nextId)) {
      continue;
    }
    const candidates = removedIds.filter(
      (oldId) =>
        !claimedPriorIds.has(oldId) &&
        (isDeepStrictEqual(nextEntries[nextId], runtimeEntries[oldId]) ||
          isDeepStrictEqual(nextEntries[nextId], sourceEntries[oldId])),
    );
    if (candidates.length === 1) {
      const oldId = candidates[0]!;
      entryIdentityByNextId.set(nextId, oldId);
      claimedPriorIds.add(oldId);
    }
  }
  const ambiguousAddedIds = addedIds.filter((id) => !entryIdentityByNextId.has(id));
  const ambiguousRemovedIds = removedIds.filter((id) => !claimedPriorIds.has(id));
  if (
    ambiguousAddedIds.length > 0 &&
    ambiguousRemovedIds.some((id) => {
      const sourcePath = sourcePathsByAgentId.get(normalizeAgentId(id));
      return (
        containsAuthoredRosterReference(authoredEntries[id], !resolutionEvaluated) ||
        Boolean(sourcePath && hasUnresolvedConfigPathInSubtree(rosterFactOwner, sourcePath))
      );
    })
  ) {
    throw new Error(
      "Config write cannot safely match renamed agent entries with authored references; rename agents one at a time.",
    );
  }
  let entries: unknown = Object.fromEntries(
    Object.entries(nextEntries).map(([id, nextEntry]) => {
      const priorId = entryIdentityByNextId.get(id) ?? id;
      const projected = projectAuthoredRosterValue({
        authored: authoredEntries[priorId],
        authoredPresent: Object.hasOwn(authoredEntries, priorId),
        explicit: explicitEntries[id],
        explicitPresent: Object.hasOwn(explicitEntries, id),
        explicitPaths,
        path: [id],
        runtime: runtimeEntries[priorId],
        runtimePresent: Object.hasOwn(runtimeEntries, priorId),
        source: sourceEntries[priorId],
        sourcePresent: Object.hasOwn(sourceEntries, priorId),
        next: nextEntry,
        nextPresent: true,
      });
      const value = projected.present ? projected.value : nextEntry;
      if (isRecord(value) && isRecord(nextEntry)) {
        if (Object.hasOwn(nextEntry, "default")) {
          const sourcePath = sourcePathsByAgentId.get(normalizeAgentId(priorId));
          const preservesAuthoredReference =
            Object.hasOwn(value, "default") &&
            (containsAuthoredRosterReference(value.default, !resolutionEvaluated) ||
              Boolean(
                sourcePath &&
                hasUnresolvedConfigPathInSubtree(rosterFactOwner, `${sourcePath}.default`),
              )) &&
            ((Object.hasOwn(runtimeEntries, priorId) &&
              isRecord(runtimeEntries[priorId]) &&
              isDeepStrictEqual(runtimeEntries[priorId].default, nextEntry.default)) ||
              (Object.hasOwn(sourceEntries, priorId) &&
                isRecord(sourceEntries[priorId]) &&
                isDeepStrictEqual(sourceEntries[priorId].default, nextEntry.default)));
          if (!preservesAuthoredReference) {
            value.default = structuredClone(nextEntry.default);
          }
        } else {
          delete value.default;
        }
      }
      return [id, value];
    }),
  );
  if (authoredRoster?.kind === "list" && Array.isArray(authoredRoster.value)) {
    const nextIdByPriorId = new Map(
      [...entryIdentityByNextId].map(([nextId, priorId]) => [priorId, nextId]),
    );
    const resolveExplicitLegacyIdCandidate = (index: number): string | undefined => {
      if (explicitRoster?.kind !== "list" || !Array.isArray(explicitRoster.value)) {
        return undefined;
      }
      const explicitEntry = explicitRoster.value[index];
      if (!isRecord(explicitEntry)) {
        return undefined;
      }
      const id = resolveExplicitLegacyEntryId(explicitEntry, index);
      return id === undefined ? undefined : normalizeAgentId(id);
    };
    const resolveExplicitLegacyId = (index: number): string => {
      const resolvedId = resolveExplicitLegacyIdCandidate(index);
      if (!resolvedId || explicitRoster?.kind !== "list" || !Array.isArray(explicitRoster.value)) {
        throw new Error(
          "Config write cannot safely resolve an explicitly replaced agent list slot for unset.",
        );
      }
      for (const [candidateIndex] of explicitRoster.value.entries()) {
        if (candidateIndex === index) {
          continue;
        }
        const candidateId = resolveExplicitLegacyIdCandidate(candidateIndex);
        if (!candidateId) {
          throw new Error(
            "Config write cannot safely resolve every explicit agent id across an indexed list unset.",
          );
        }
        if (candidateId === resolvedId) {
          throw new Error(
            "Config write cannot safely resolve duplicate agent ids across an indexed list unset.",
          );
        }
      }
      return resolvedId;
    };
    for (const unsetPath of params.unsetPaths ?? []) {
      if (unsetPath[0] !== "agents" || unsetPath[1] !== "list") {
        continue;
      }
      if (unsetPath.length === 2) {
        entries = undefined;
        break;
      }
      if (unsetPath.length === 4 && unsetPath[3] === "id") {
        throw new Error(
          "Config write cannot unset an agent id; delete the complete roster entry instead.",
        );
      }
      const index = parseConfigPathArrayIndex(unsetPath[2] ?? "");
      const usesExplicitIdentity =
        index !== undefined && structurallyExplicitLegacyIndexes.has(index);
      const explicitResolvedId =
        usesExplicitIdentity && index !== undefined ? resolveExplicitLegacyId(index) : undefined;
      const id =
        explicitResolvedId !== undefined
          ? explicitResolvedId
          : index === undefined
            ? undefined
            : legacyIdsByIndex.get(index);
      if (typeof id !== "string") {
        continue;
      }
      const targetId = explicitResolvedId !== undefined ? id : (nextIdByPriorId.get(id) ?? id);
      entries = deletePathValue(entries, [targetId, ...unsetPath.slice(3)]);
    }
  }
  const withoutLegacyList = deletePathValue(params.valueSource, ["agents", "list"]);
  return entries === undefined
    ? deletePathValue(withoutLegacyList, ["agents", "entries"])
    : setPathValueCreatingParents(withoutLegacyList, ["agents", "entries"], entries);
}

function restoreAuthoredAgentRoster(value: unknown, rootAuthoredConfig: unknown): unknown {
  let next = deletePathValue(value, ["agents", "entries"]);
  next = deletePathValue(next, ["agents", "list"]);
  const authoredRoster = readAgentRosterProperty(rootAuthoredConfig);
  if (authoredRoster) {
    return setPathValueCreatingParents(next, ["agents", authoredRoster.kind], authoredRoster.value);
  }
  // Roster injection must not leave an unauthored parent, but empty authored sections are intent.
  return !hasPathValue(rootAuthoredConfig, ["agents"]) &&
    isDeepStrictEqual(getPathValue(next, ["agents"]), {})
    ? deletePathValue(next, ["agents"])
    : next;
}

export function projectAuthoredAgentRosterForWrite(params: {
  rootAuthoredConfig: unknown;
  sourceConfigBeforeMigrations?: unknown;
}): unknown {
  const authoredRoster = readAgentRosterProperty(params.rootAuthoredConfig);
  if (authoredRoster?.kind !== "list" || !Array.isArray(authoredRoster.value)) {
    return params.rootAuthoredConfig;
  }
  const preMigrationRoster = readAgentRosterProperty(params.sourceConfigBeforeMigrations);
  const resolvedLegacyList =
    preMigrationRoster?.kind === "list" && Array.isArray(preMigrationRoster.value)
      ? preMigrationRoster.value
      : undefined;
  // Doctor may rename malformed or duplicate ids; includes must keep an unambiguous owner.
  if (
    collectIncludeOwnedPaths(authoredRoster.value).length > 0 &&
    !parseLegacyAgentRoster(resolvedLegacyList ?? authoredRoster.value)
  ) {
    throw new Error(
      "Config write cannot safely match $include-owned legacy agent entries; repair their ids in the authored config first.",
    );
  }
  const legacyIdsByIndex = new Map(
    projectLegacyAgentRosterEntries(resolvedLegacyList ?? authoredRoster.value).entries.map(
      ({ sourceIndex, id }) => [sourceIndex, id],
    ),
  );
  const entries = indexAgentRosterForWrite(params.rootAuthoredConfig, legacyIdsByIndex);
  const withoutLegacyRoster = deletePathValue(
    deletePathValue(params.rootAuthoredConfig, ["agents", "list"]),
    ["agents", "entries"],
  );
  return setPathValueCreatingParents(withoutLegacyRoster, ["agents", "entries"], entries);
}

type ConfigWriteSourceProjectionParams = {
  inputBasis?: ConfigWriteInputBasis;
  runtimeConfig: unknown;
  sourceConfig: unknown;
  nextConfig: unknown;
  unsetPaths?: readonly string[][];
  explicitSetPaths?: readonly (readonly string[])[];
  explicitSetValueSource?: unknown;
};

export function projectConfigWriteSource(params: ConfigWriteSourceProjectionParams): unknown {
  const inputBasis = params.inputBasis ?? { kind: "runtime", config: params.runtimeConfig };
  // Source candidates own every value, including null; merge-patch null means deletion.
  if (inputBasis.kind === "source") {
    return structuredClone(params.nextConfig);
  }
  const patch = createMergePatch(inputBasis.config, params.nextConfig);
  const projectedSource = normalizeTouchedAgentModelMapEntries({
    projectedSource: params.sourceConfig,
    patch,
    touchedPaths: [...(params.explicitSetPaths ?? []), ...(params.unsetPaths ?? [])],
    explicitSetValueSource: params.explicitSetValueSource ?? params.nextConfig,
  });
  return projectRuntimeChangesOntoSource(projectedSource, inputBasis.config, params.nextConfig);
}

export function resolvePersistCandidateForWrite(
  params: ConfigWriteSourceProjectionParams & {
    sourceConfigValid?: boolean;
    sourceConfigBeforeMigrations?: unknown;
    rootAuthoredConfig?: unknown;
    agentRosterIncludeOwned?: boolean;
    keyedAgentEntryIncludePaths?: readonly (readonly string[])[];
    persistCanonicalAgentRoster?: boolean;
    allowedAgentRosterRemovals?: readonly string[];
    allowIncludeAncestorExplicitSetPaths?: boolean;
    preserveLegacyAgentRoster?: boolean;
  },
): unknown {
  const inputBasis = params.inputBasis ?? { kind: "runtime", config: params.runtimeConfig };
  const rootAuthoredConfig = params.rootAuthoredConfig ?? params.sourceConfig;
  const wantsCanonicalRoster = shouldPersistCanonicalAgentRoster(params);
  const includeOwnsRoster =
    wantsCanonicalRoster &&
    configIncludeOwnsAgentRosterValues({
      parsed: rootAuthoredConfig,
      sourceConfigBeforeMigrations: params.sourceConfigBeforeMigrations ?? params.sourceConfig,
      includeContributesRoster: params.agentRosterIncludeOwned,
    });
  const preserveKeyedEntryIncludes =
    includeOwnsRoster &&
    hasOnlyPreparedKeyedAgentEntryRosterIncludes(
      rootAuthoredConfig,
      params.keyedAgentEntryIncludePaths,
    );
  if (includeOwnsRoster && !preserveKeyedEntryIncludes) {
    // Canonical roster writes replace the whole roster atomically. Any included contribution
    // therefore owns this boundary; flattening only its root-authored siblings is not safe.
    // The owning directive may sit at agents, agents.entries, agents.list, or an entry, so
    // the refusal names the boundary without guessing which included file owns it.
    throw createConfigIncludeOwnershipError({ ownedConfigPath: "agents" });
  }
  const persistCanonicalRoster = wantsCanonicalRoster && !preserveKeyedEntryIncludes;
  const projectedAuthoredRoster = persistCanonicalRoster
    ? projectAuthoredAgentRosterForWrite({
        rootAuthoredConfig,
        sourceConfigBeforeMigrations: params.sourceConfigBeforeMigrations,
      })
    : rootAuthoredConfig;
  // Include paths and their recorded evidence need the same roster coordinates.
  // Reindex the pre-migration source without migrating its field values.
  const includeProjectionSourceBeforeMigrations = persistCanonicalRoster
    ? projectAuthoredAgentRosterForWrite({
        rootAuthoredConfig: params.sourceConfigBeforeMigrations,
      })
    : params.sourceConfigBeforeMigrations;
  const includeProjectionRootAuthoredConfig =
    persistCanonicalRoster && !hasAgentRosterProperty(projectedAuthoredRoster)
      ? setPathValueCreatingParents(
          projectedAuthoredRoster,
          ["agents", "entries"],
          toAgentEntriesRecord(listAgentEntries(params.sourceConfig as OpenClawConfig)),
        )
      : projectedAuthoredRoster;
  const explicitSetPaths = persistCanonicalRoster
    ? params.explicitSetPaths?.filter((path) => !pathTargetsAgentRoster(path))
    : preserveKeyedEntryIncludes
      ? (params.explicitSetPaths ?? []).filter(
          (path) =>
            findOverlappingIncludeOwnedPath(includeProjectionRootAuthoredConfig, [...path]) ===
            undefined,
        )
      : params.explicitSetPaths;
  const explicitSetValueSource = persistCanonicalRoster
    ? canonicalizeAgentRosterForExplicitWrite({
        valueSource: params.explicitSetValueSource ?? params.nextConfig,
        rootAuthoredConfig,
        runtimeConfig: params.runtimeConfig,
        sourceConfig: params.sourceConfig,
        sourceConfigBeforeMigrations: params.sourceConfigBeforeMigrations,
        nextConfig: params.nextConfig,
        explicitSetPaths: params.explicitSetPaths,
        unsetPaths: params.unsetPaths,
      })
    : (params.explicitSetValueSource ?? params.nextConfig);
  let persistedBase = projectConfigWriteSource(params);
  if (persistCanonicalRoster) {
    persistedBase = deletePathValue(persistedBase, ["agents", "entries"]);
    persistedBase = deletePathValue(persistedBase, ["agents", "list"]);
    const entries = getPathValue(explicitSetValueSource, ["agents", "entries"]);
    if (entries !== undefined) {
      persistedBase = setPathValueCreatingParents(persistedBase, ["agents", "entries"], entries);
    }
  }
  const withPreservedIncludes = preserveUntouchedIncludes({
    runtimeConfig: inputBasis.config,
    sourceConfig: params.sourceConfig,
    sourceConfigBeforeMigrations: includeProjectionSourceBeforeMigrations,
    nextConfig: params.nextConfig,
    rootAuthoredConfig: includeProjectionRootAuthoredConfig,
    persistedCandidate: persistedBase,
  });
  // Structural reconstruction finishes first so it cannot discard later explicit sibling writes.
  const persisted = injectExplicitlySetPaths({
    valueSource: explicitSetValueSource,
    persistedCandidate: withPreservedIncludes,
    runtimeConfig: inputBasis.config,
    sourceConfig: params.sourceConfig,
    sourceConfigBeforeMigrations: includeProjectionSourceBeforeMigrations,
    explicitSetPaths,
    rootAuthoredConfig: includeProjectionRootAuthoredConfig,
    // Includes were validated and restored above; ancestor merges retain their directives.
    preserveDescendantIncludes: persistCanonicalRoster,
    allowIncludeAncestorExplicitSetPaths: params.allowIncludeAncestorExplicitSetPaths,
  });
  const preserveAuthoredRoster =
    canCanonicalizeAgentRoster(params.nextConfig) || params.preserveLegacyAgentRoster === true;
  const withAuthoredRoster =
    wantsCanonicalRoster || !preserveAuthoredRoster
      ? persisted
      : restoreAuthoredAgentRoster(persisted, rootAuthoredConfig);
  if (wantsCanonicalRoster) {
    // A roster rewrite must never drop entries the mutation did not explicitly delete.
    // A 2026-07-25 production incident lost agents.entries.main twice through silent rewrites.
    assertCanonicalAgentRosterRetainsEntries({
      currentConfig: params.sourceConfig,
      canonicalConfig: withAuthoredRoster,
      allowedRemovals: params.allowedAgentRosterRemovals,
    });
  }
  const withSchema = preserveRootSchemaUri({
    rootAuthoredConfig,
    nextConfig: params.nextConfig,
    persistedCandidate: withAuthoredRoster,
  });
  // Source edits and invalid-config repairs own omitted params as well as explicit values.
  return params.sourceConfigValid === false || inputBasis.kind === "source"
    ? withSchema
    : preserveAuthoredAgentParams({
        sourceConfig: params.sourceConfig,
        nextConfig: params.nextConfig,
        rootAuthoredConfig,
        persistedCandidate: withSchema,
        unsetPaths: params.unsetPaths,
      });
}

function preserveRootSchemaUri(params: {
  rootAuthoredConfig: unknown;
  nextConfig: unknown;
  persistedCandidate: unknown;
}): unknown {
  if (isRecord(params.nextConfig) && Object.hasOwn(params.nextConfig, "$schema")) {
    return params.persistedCandidate;
  }
  const sourceSchema = readStringField(asOptionalRecord(params.rootAuthoredConfig), "$schema");
  if (sourceSchema === undefined || !isRecord(params.persistedCandidate)) {
    return params.persistedCandidate;
  }
  return {
    ...params.persistedCandidate,
    $schema: sourceSchema,
  };
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
