// Prepares config writes by diffing current state and preserving metadata.
import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import {
  hasAgentRosterProperty,
  listAgentEntries,
  readAgentRosterProperty,
  toAgentEntriesRecord,
} from "../agents/agent-scope-config.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { isRecord } from "../utils.js";
import { configIncludeOwnsAgentRosterValues } from "./agent-roster-provenance.js";
import { applyMergePatch, createMergePatch } from "./merge-patch.js";
import { normalizeAgentModelMapForConfig, normalizeAgentModelRefForConfig } from "./model-input.js";
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

// Clone config fragments before patching so mutation preparation never aliases callers.
function cloneUnknown<T>(value: T): T {
  return structuredClone(value);
}

export function projectSourceOntoRuntimeShape(source: unknown, runtime: unknown): unknown {
  if (!isRecord(source) || !isRecord(runtime)) {
    return cloneUnknown(source);
  }

  const next: Record<string, unknown> = {};
  for (const [key, sourceValue] of Object.entries(source)) {
    if (!(key in runtime)) {
      next[key] = cloneUnknown(sourceValue);
      continue;
    }
    next[key] = projectSourceOntoRuntimeShape(sourceValue, runtime[key]);
  }
  return next;
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

function collectIncludeOwnedPaths(value: unknown, path: string[] = []): string[][] {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) =>
      collectIncludeOwnedPaths(child, [...path, String(index)]),
    );
  }
  if (!isRecord(value)) {
    return [];
  }
  if (hasOwnValidIncludeDirective(value)) {
    return [path];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    collectIncludeOwnedPaths(child, [...path, key]),
  );
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

function formatConfigPath(path: string[]): string {
  return path.length > 0 ? path.join(".") : "<root>";
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
      const index = parseArrayIndexPathSegment(segment);
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
    return cloneUnknown(nextValue);
  }
  const head = expectDefined(path[0], "config path head");
  const tail = path.slice(1);
  if (Array.isArray(value)) {
    const index = parseArrayIndexPathSegment(head);
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

function isIncludeOwnedPath(rootAuthoredConfig: unknown, path: string[]): boolean {
  return collectIncludeOwnedPaths(rootAuthoredConfig).some((includePath) => {
    const overlapsInclude = pathStartsWith(path, includePath) || pathStartsWith(includePath, path);
    if (!overlapsInclude) {
      return false;
    }
    return !isMutableSiblingPathAtInclude(rootAuthoredConfig, includePath, path);
  });
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
    return cloneUnknown(nextValue);
  }
  const head = expectDefined(path[0], "config path head");
  const tail = path.slice(1);
  if (Array.isArray(value) || isNumericPathSegment(head)) {
    const index = parseArrayIndexPathSegment(head);
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
    const index = parseArrayIndexPathSegment(head);
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
  explicitSetPaths?: readonly (readonly string[])[];
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
    for (const explicitPath of params.explicitSetPaths ?? []) {
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
  if (isIncludeOwnedPath(params.rootAuthoredConfig, params.path)) {
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
    const paramsPath = [...modelPath, "params"];
    if (modelPath.at(-1) !== modelId) {
      next = deletePathValue(next, ["agents", "defaults", "models", modelId]);
    }
    if (getPathValue(next, modelPath) === undefined) {
      next = preserveSourceValueAtPath({
        ...params,
        persistedCandidate: next,
        path: modelPath,
        sourceValue: modelEntry,
      });
      continue;
    }
    next = preserveSourceValueAtPath({
      ...params,
      persistedCandidate: next,
      path: paramsPath,
      sourceValue: modelEntry.params,
    });
  }
  return next;
}

type IncludeSiblingProjection =
  | { ok: true; present: false }
  | { ok: true; present: true; value: unknown }
  | { ok: false };

function projectRootAuthoredIncludeSibling(params: {
  authored: unknown;
  baseline: unknown;
  next: unknown;
  baselinePresent: boolean;
  nextPresent: boolean;
}): IncludeSiblingProjection {
  if (
    params.nextPresent &&
    params.baselinePresent &&
    isDeepStrictEqual(params.next, params.baseline)
  ) {
    return { ok: true, present: true, value: cloneUnknown(params.authored) };
  }
  if (!params.nextPresent) {
    return collectIncludeOwnedPaths(params.authored).length > 0
      ? { ok: false }
      : { ok: true, present: false };
  }
  if (!params.baselinePresent) {
    return { ok: true, present: true, value: cloneUnknown(params.next) };
  }
  if (hasOwnValidIncludeDirective(params.authored)) {
    return { ok: false };
  }
  if (Array.isArray(params.authored)) {
    return Array.isArray(params.next)
      ? { ok: false }
      : { ok: true, present: true, value: cloneUnknown(params.next) };
  }
  if (!isRecord(params.authored)) {
    return { ok: true, present: true, value: cloneUnknown(params.next) };
  }
  if (!isRecord(params.next)) {
    return collectIncludeOwnedPaths(params.authored).length > 0
      ? { ok: false }
      : { ok: true, present: true, value: cloneUnknown(params.next) };
  }
  if (!isRecord(params.baseline)) {
    return { ok: true, present: true, value: cloneUnknown(params.next) };
  }

  const value: Record<string, unknown> = cloneUnknown(params.authored);
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

function preserveUntouchedIncludes(params: {
  runtimeConfig: unknown;
  sourceConfig: unknown;
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
      throw new Error(
        `Config write would flatten $include-owned config at ${formatConfigPath(
          includePath,
        )}; edit that include file directly or remove the $include first.`,
      );
    }
    if (includeIsArrayEntry) {
      const index = parseArrayIndexPathSegment(includePath.at(-1) ?? "");
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
        throw new Error(
          `Config write would flatten $include-owned config at ${formatConfigPath(
            includePath,
          )}; edit that include file directly or remove the $include first.`,
        );
      }
    }
    let authoredIncludeValue = getPathValue(params.rootAuthoredConfig, includePath);
    for (const siblingPath of mutableSiblingPaths) {
      const relativeSiblingPath = siblingPath.slice(includePath.length);
      const nextPresent = hasPathValue(params.nextConfig, siblingPath);
      const projectAgainst = (baselineConfig: unknown) =>
        projectRootAuthoredIncludeSibling({
          authored: getPathValue(params.rootAuthoredConfig, siblingPath),
          baseline: getPathValue(baselineConfig, siblingPath),
          next: getPathValue(params.nextConfig, siblingPath),
          baselinePresent: hasPathValue(baselineConfig, siblingPath),
          nextPresent,
        });
      const sourceProjection = projectAgainst(params.sourceConfig);
      const projection = sourceProjection.ok
        ? sourceProjection
        : projectAgainst(params.runtimeConfig);
      if (!projection.ok) {
        throw new Error(
          `Config write would flatten $include-owned config at ${formatConfigPath(
            includePath,
          )}; edit that include file directly or remove the $include first.`,
        );
      }
      authoredIncludeValue = projection.present
        ? setPathValue(authoredIncludeValue, relativeSiblingPath, projection.value)
        : deletePathValue(authoredIncludeValue, relativeSiblingPath);
    }
    next = setPathValue(next, includePath, authoredIncludeValue);
  }
  return next;
}

export function preserveIncludeOwnedConfigForWrite(params: {
  runtimeConfig: unknown;
  sourceConfig: unknown;
  nextConfig: unknown;
  rootAuthoredConfig: unknown;
}): unknown {
  return preserveUntouchedIncludes({
    ...params,
    persistedCandidate: params.nextConfig,
  });
}

function hasPathValue(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) {
    return true;
  }
  const head = expectDefined(path[0], "config path head");
  const tail = path.slice(1);
  if (Array.isArray(value)) {
    const index = parseArrayIndexPathSegment(head);
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
  if (!isRecord(currentValue) || !isRecord(explicitValue)) {
    if (!Array.isArray(currentValue) || !Array.isArray(explicitValue)) {
      return { changed: false, value: currentValue };
    }
    let changed = false;
    const next = [...currentValue];
    for (const [key, childExplicitValue] of Object.entries(explicitValue)) {
      const index = parseArrayIndexPathSegment(key);
      if (index === undefined) {
        continue;
      }
      if (index >= next.length || next[index] === undefined) {
        next[index] = cloneUnknown(childExplicitValue);
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
      next[key] = cloneUnknown(childExplicitValue);
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

function injectExplicitlySetPaths(params: {
  valueSource: unknown;
  persistedCandidate: unknown;
  explicitSetPaths?: readonly (readonly string[])[];
  rootAuthoredConfig?: unknown;
  preserveDescendantIncludes?: boolean;
  allowIncludeAncestorExplicitSetPaths?: boolean;
}): unknown {
  if (!params.explicitSetPaths || params.explicitSetPaths.length === 0) {
    return params.persistedCandidate;
  }

  let next = params.persistedCandidate;
  for (const path of params.explicitSetPaths) {
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
      throw new Error(
        `Config write would flatten $include-owned config at ${formatConfigPath(
          includeOwnedPath,
        )}; edit that include file directly or remove the $include first.`,
      );
    }
    const nextValue = getPathValue(params.valueSource, [...path]);
    if (nextValue === undefined) {
      continue;
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
  explicitSetPaths?: readonly (readonly string[])[];
  unsetPaths?: readonly (readonly string[])[];
}): boolean {
  if (!canCanonicalizeAgentRoster(params.nextConfig)) {
    return false;
  }
  if (
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
  const droppedIds = listAgentEntries(params.currentConfig as OpenClawConfig)
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

function containsAuthoredRosterReference(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes("${");
  }
  if (Array.isArray(value)) {
    return value.some(containsAuthoredRosterReference);
  }
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.source === "string" && typeof value.id === "string") {
    return true;
  }
  return Object.values(value).some(containsAuthoredRosterReference);
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
      return { present: true, value: cloneUnknown(params.explicit) };
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
    return { present: true, value: cloneUnknown(params.explicit) };
  }
  const unchangedFromRuntime =
    params.runtimePresent && isDeepStrictEqual(params.runtime, params.next);
  const unchangedFromSource = params.sourcePresent && isDeepStrictEqual(params.source, params.next);
  return {
    present: true,
    value:
      params.authoredPresent && (unchangedFromRuntime || unchangedFromSource)
        ? cloneUnknown(params.authored)
        : cloneUnknown(params.next),
  };
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
  const authoredEntries =
    authoredRoster?.kind === "list" && Array.isArray(authoredRoster.value)
      ? Object.fromEntries(
          authoredRoster.value.flatMap((entry, index) => {
            if (!isRecord(entry)) {
              return [];
            }
            const resolvedEntry = resolvedLegacyList?.[index];
            const resolvedId = isRecord(resolvedEntry) ? resolvedEntry.id : undefined;
            const id = typeof resolvedId === "string" ? resolvedId : entry.id;
            if (typeof id !== "string") {
              return [];
            }
            const { id: _authoredId, ...config } = entry;
            return [[id, config]];
          }),
        )
      : (toAgentEntriesRecord(
          listAgentEntries(params.rootAuthoredConfig as OpenClawConfig),
        ) as Record<string, unknown>);
  const runtimeEntries = toAgentEntriesRecord(
    listAgentEntries(params.runtimeConfig as OpenClawConfig),
  ) as Record<string, unknown>;
  const sourceEntries = toAgentEntriesRecord(
    listAgentEntries(params.sourceConfig as OpenClawConfig),
  ) as Record<string, unknown>;
  const nextEntries = toAgentEntriesRecord(
    listAgentEntries(params.nextConfig as OpenClawConfig),
  ) as Record<string, unknown>;
  const explicitRoster = readAgentRosterProperty(params.valueSource);
  const renamedLegacyIndexes = new Set(
    (params.explicitSetPaths ?? []).flatMap((path) => {
      if (path[0] !== "agents" || path[1] !== "list" || path.length !== 4 || path[3] !== "id") {
        return [];
      }
      const index = parseArrayIndexPathSegment(path[2] ?? "");
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
      const index = parseArrayIndexPathSegment(path[2] ?? "");
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
    if (isRecord(entry) && typeof entry.id === "string" && entry.id.includes("${")) {
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
    return explicitId.includes("${") ? undefined : explicitId;
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
            const resolvedEntry = resolvedLegacyList?.[index];
            const resolvedId = isRecord(resolvedEntry) ? resolvedEntry.id : undefined;
            const id = structurallyExplicitLegacyIndexes.has(index)
              ? resolveExplicitLegacyEntryId(entry, index)
              : typeof resolvedId === "string"
                ? resolvedId
                : entry.id;
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
    const index = parseArrayIndexPathSegment(path[2] ?? "");
    const authoredEntry =
      authoredRoster?.kind === "list" && Array.isArray(authoredRoster.value) && index !== undefined
        ? authoredRoster.value[index]
        : undefined;
    const explicitEntry =
      explicitRoster?.kind === "list" && Array.isArray(explicitRoster.value) && index !== undefined
        ? explicitRoster.value[index]
        : undefined;
    const resolvedEntry = index === undefined ? undefined : resolvedLegacyList?.[index];
    const usesExplicitId =
      index !== undefined &&
      (renamedLegacyIndexes.has(index) ||
        (path.length === 3 && structurallyExplicitLegacyIndexes.has(index)));
    const id =
      usesExplicitId && isRecord(explicitEntry)
        ? explicitEntry.id
        : isRecord(resolvedEntry) && typeof resolvedEntry.id === "string"
          ? resolvedEntry.id
          : isRecord(authoredEntry)
            ? authoredEntry.id
            : undefined;
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
      const index = parseArrayIndexPathSegment(path[2] ?? "");
      const authoredEntry = index === undefined ? undefined : authoredRoster.value[index];
      const explicitEntry = index === undefined ? undefined : explicitRoster.value[index];
      const resolvedEntry = index === undefined ? undefined : resolvedLegacyList?.[index];
      const oldId = isRecord(resolvedEntry)
        ? resolvedEntry.id
        : isRecord(authoredEntry)
          ? authoredEntry.id
          : undefined;
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
    ambiguousRemovedIds.some((id) => containsAuthoredRosterReference(authoredEntries[id]))
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
          const preservesAuthoredReference =
            Object.hasOwn(value, "default") &&
            containsAuthoredRosterReference(value.default) &&
            ((Object.hasOwn(runtimeEntries, priorId) &&
              isRecord(runtimeEntries[priorId]) &&
              isDeepStrictEqual(runtimeEntries[priorId].default, nextEntry.default)) ||
              (Object.hasOwn(sourceEntries, priorId) &&
                isRecord(sourceEntries[priorId]) &&
                isDeepStrictEqual(sourceEntries[priorId].default, nextEntry.default)));
          if (!preservesAuthoredReference) {
            value.default = cloneUnknown(nextEntry.default);
          }
        } else {
          delete value.default;
        }
      }
      return [id, value];
    }),
  );
  if (authoredRoster?.kind === "list" && Array.isArray(authoredRoster.value)) {
    const authoredList = authoredRoster.value;
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
      const index = parseArrayIndexPathSegment(unsetPath[2] ?? "");
      const authoredEntry = index === undefined ? undefined : authoredList[index];
      const resolvedEntry = index === undefined ? undefined : resolvedLegacyList?.[index];
      const usesExplicitIdentity =
        index !== undefined && structurallyExplicitLegacyIndexes.has(index);
      const explicitResolvedId =
        usesExplicitIdentity && index !== undefined ? resolveExplicitLegacyId(index) : undefined;
      const id =
        explicitResolvedId !== undefined
          ? explicitResolvedId
          : isRecord(resolvedEntry)
            ? resolvedEntry.id
            : isRecord(authoredEntry)
              ? authoredEntry.id
              : undefined;
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
  return authoredRoster
    ? setPathValueCreatingParents(
        next,
        ["agents", authoredRoster.kind],
        cloneUnknown(authoredRoster.value),
      )
    : next;
}

function projectAuthoredAgentRosterForCanonicalIncludes(params: {
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
  const entries = Object.fromEntries(
    authoredRoster.value.flatMap((entry, index) => {
      if (!isRecord(entry)) {
        return [];
      }
      const resolvedEntry = resolvedLegacyList?.[index];
      const resolvedId = isRecord(resolvedEntry) ? resolvedEntry.id : undefined;
      const id = typeof resolvedId === "string" ? resolvedId : entry.id;
      if (typeof id !== "string") {
        return [];
      }
      const { id: _authoredId, ...config } = entry;
      return [[normalizeAgentId(id), config]];
    }),
  );
  const withoutLegacyRoster = deletePathValue(
    deletePathValue(params.rootAuthoredConfig, ["agents", "list"]),
    ["agents", "entries"],
  );
  return setPathValueCreatingParents(withoutLegacyRoster, ["agents", "entries"], entries);
}

export function resolvePersistCandidateForWrite(params: {
  runtimeConfig: unknown;
  sourceConfig: unknown;
  sourceConfigBeforeMigrations?: unknown;
  nextConfig: unknown;
  rootAuthoredConfig?: unknown;
  agentRosterIncludeOwned?: boolean;
  unsetPaths?: readonly string[][];
  explicitSetPaths?: readonly (readonly string[])[];
  explicitSetValueSource?: unknown;
  allowedAgentRosterRemovals?: readonly string[];
  allowIncludeAncestorExplicitSetPaths?: boolean;
  preserveLegacyAgentRoster?: boolean;
}): unknown {
  const patch = createMergePatch(params.runtimeConfig, params.nextConfig);
  const projectedSource = normalizeTouchedAgentModelMapEntries({
    projectedSource: projectSourceOntoRuntimeShape(params.sourceConfig, params.runtimeConfig),
    patch,
    explicitSetPaths: params.explicitSetPaths,
    explicitSetValueSource: params.explicitSetValueSource ?? params.nextConfig,
  });
  const rootAuthoredConfig = params.rootAuthoredConfig ?? params.sourceConfig;
  const persistCanonicalRoster = shouldPersistCanonicalAgentRoster(params);
  const includeOwnsRoster =
    persistCanonicalRoster &&
    configIncludeOwnsAgentRosterValues({
      parsed: rootAuthoredConfig,
      sourceConfigBeforeMigrations: params.sourceConfigBeforeMigrations ?? params.sourceConfig,
      includeContributesRoster: params.agentRosterIncludeOwned,
    });
  if (includeOwnsRoster) {
    // Canonical roster writes replace the whole roster atomically. Any included contribution
    // therefore owns this boundary; flattening only its root-authored siblings is not safe.
    throw new Error(
      "Config write would flatten $include-owned config at agents; edit that include file directly or remove the $include first.",
    );
  }
  const projectedAuthoredRoster = persistCanonicalRoster
    ? projectAuthoredAgentRosterForCanonicalIncludes({
        rootAuthoredConfig,
        sourceConfigBeforeMigrations: params.sourceConfigBeforeMigrations,
      })
    : rootAuthoredConfig;
  const includeProjectionRootAuthoredConfig =
    persistCanonicalRoster && !hasAgentRosterProperty(projectedAuthoredRoster)
      ? setPathValueCreatingParents(
          projectedAuthoredRoster,
          ["agents", "entries"],
          toAgentEntriesRecord(listAgentEntries(params.sourceConfig as OpenClawConfig)),
        )
      : projectedAuthoredRoster;
  let persistedBase = preserveUntouchedIncludes({
    runtimeConfig: params.runtimeConfig,
    sourceConfig: params.sourceConfig,
    nextConfig: params.nextConfig,
    rootAuthoredConfig: includeProjectionRootAuthoredConfig,
    persistedCandidate: applyMergePatch(projectedSource, patch),
  });
  const explicitSetPaths = persistCanonicalRoster
    ? [
        ...(params.explicitSetPaths ?? []).filter((path) => !pathTargetsAgentRoster(path)),
        ["agents", "entries"],
      ]
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
  if (persistCanonicalRoster) {
    persistedBase = deletePathValue(persistedBase, ["agents", "entries"]);
    persistedBase = deletePathValue(persistedBase, ["agents", "list"]);
  }
  const persisted = injectExplicitlySetPaths({
    valueSource: explicitSetValueSource,
    persistedCandidate: persistedBase,
    explicitSetPaths,
    rootAuthoredConfig: includeProjectionRootAuthoredConfig,
    // This only postpones descendant include validation: the preservation pass below
    // compares next against source/runtime and still rejects every changed include subtree.
    preserveDescendantIncludes: persistCanonicalRoster,
    allowIncludeAncestorExplicitSetPaths: params.allowIncludeAncestorExplicitSetPaths,
  });
  const withPreservedIncludes = persistCanonicalRoster
    ? preserveUntouchedIncludes({
        runtimeConfig: params.runtimeConfig,
        sourceConfig: params.sourceConfig,
        nextConfig: params.nextConfig,
        rootAuthoredConfig: includeProjectionRootAuthoredConfig,
        persistedCandidate: persisted,
      })
    : persisted;
  const preserveAuthoredRoster =
    canCanonicalizeAgentRoster(params.nextConfig) || params.preserveLegacyAgentRoster === true;
  const withAuthoredRoster =
    persistCanonicalRoster || !preserveAuthoredRoster
      ? withPreservedIncludes
      : restoreAuthoredAgentRoster(withPreservedIncludes, rootAuthoredConfig);
  if (persistCanonicalRoster) {
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
  const withAuthoredParams = preserveAuthoredAgentParams({
    sourceConfig: params.sourceConfig,
    nextConfig: params.nextConfig,
    rootAuthoredConfig,
    persistedCandidate: withSchema,
    unsetPaths: params.unsetPaths,
  });
  return withAuthoredParams;
}

function readRootSchemaUri(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.$schema !== "string") {
    return undefined;
  }
  return value.$schema;
}

function hasOwnRootSchemaKey(value: unknown): boolean {
  return isRecord(value) && Object.hasOwn(value, "$schema");
}

function preserveRootSchemaUri(params: {
  rootAuthoredConfig: unknown;
  nextConfig: unknown;
  persistedCandidate: unknown;
}): unknown {
  if (hasOwnRootSchemaKey(params.nextConfig)) {
    return params.persistedCandidate;
  }
  const sourceSchema = readRootSchemaUri(params.rootAuthoredConfig);
  if (sourceSchema === undefined || !isRecord(params.persistedCandidate)) {
    return params.persistedCandidate;
  }
  return {
    ...params.persistedCandidate,
    $schema: sourceSchema,
  };
}

function isNumericPathSegment(raw: string): boolean {
  return parseArrayIndexPathSegment(raw) !== undefined;
}

function parseArrayIndexPathSegment(raw: string): number | undefined {
  return parseConfigPathArrayIndex(raw);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
