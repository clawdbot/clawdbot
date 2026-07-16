// Prepares config writes by diffing current state and preserving metadata.
import { isDeepStrictEqual } from "node:util";
import { normalizeConfiguredProviderCatalogModelId } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { expectDefined } from "@openclaw/normalization-core";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { isRecord } from "../utils.js";
import { applyMergePatch } from "./merge-patch.js";
import { normalizeAgentModelMapForConfig, normalizeAgentModelRefForConfig } from "./model-input.js";
import type { OpenClawConfig } from "./types.js";

const OPEN_DM_POLICY_ALLOW_FROM_RE =
  /^(?<policyPath>[a-z0-9_.-]+)\s*=\s*"open"\s+requires\s+(?<allowPath>[a-z0-9_.-]+)(?:\s+\(or\s+[a-z0-9_.-]+\))?\s+to include "\*"$/i;

const MANAGED_CONFIG_UNSET_PATHS = [["plugins", "installs"]] as const;

type ManifestModelIdNormalizationProvider = {
  aliases?: Record<string, string>;
  stripPrefixes?: string[];
  prefixWhenBare?: string;
  prefixWhenBareAfterAliasStartsWith?: {
    modelPrefix: string;
    prefix: string;
  }[];
};

// Clone config fragments before patching so mutation preparation never aliases callers.
function cloneUnknown<T>(value: T): T {
  return structuredClone(value);
}

/** Builds an RFC-7396-style merge patch between source and target config values. */
export function createMergePatch(base: unknown, target: unknown): unknown {
  if (!isRecord(base) || !isRecord(target)) {
    return cloneUnknown(target);
  }

  const patch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
  for (const key of keys) {
    const hasBase = Object.hasOwn(base, key);
    const hasTarget = Object.hasOwn(target, key);
    if (!hasTarget) {
      patch[key] = null;
      continue;
    }
    const targetValue = target[key];
    if (!hasBase) {
      patch[key] = cloneUnknown(targetValue);
      continue;
    }
    const baseValue = base[key];
    if (isRecord(baseValue) && isRecord(targetValue)) {
      const childPatch = createMergePatch(baseValue, targetValue);
      if (isRecord(childPatch) && Object.keys(childPatch).length === 0) {
        continue;
      }
      patch[key] = childPatch;
      continue;
    }
    if (!isDeepStrictEqual(baseValue, targetValue)) {
      patch[key] = cloneUnknown(targetValue);
    }
  }
  return patch;
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

function pathStartsWith(path: string[], prefix: string[]): boolean {
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

function normalizeAgentModelConfigForWrite(value: unknown): unknown {
  if (typeof value === "string") {
    const normalized = normalizeAgentModelRefForConfig(value);
    return normalized === value ? value : normalized;
  }
  if (!isRecord(value)) {
    return value;
  }

  let mutated = false;
  const next: Record<string, unknown> = { ...value };
  if (typeof value.primary === "string") {
    const primary = normalizeAgentModelRefForConfig(value.primary);
    if (primary !== value.primary) {
      next.primary = primary;
      mutated = true;
    }
  }
  if (Array.isArray(value.fallbacks)) {
    const fallbacks = value.fallbacks.map((fallback) =>
      typeof fallback === "string" ? normalizeAgentModelRefForConfig(fallback) : fallback,
    );
    if (!isDeepStrictEqual(fallbacks, value.fallbacks)) {
      next.fallbacks = fallbacks;
      mutated = true;
    }
  }
  return mutated ? next : value;
}

const AGENT_MODEL_CONFIG_KEYS = [
  "model",
  "imageModel",
  "imageGenerationModel",
  "videoGenerationModel",
  "musicGenerationModel",
  "voiceModel",
  "pdfModel",
] as const;

function normalizeModelConfigPathForWrite(config: unknown, path: string[]): unknown {
  const value = getPathValue(config, path);
  if (value === undefined) {
    return config;
  }
  const normalizedModel = normalizeAgentModelConfigForWrite(value);
  return normalizedModel !== value ? setPathValue(config, path, normalizedModel) : config;
}

function normalizeModelStringPathForWrite(config: unknown, path: string[]): unknown {
  const value = getPathValue(config, path);
  if (typeof value !== "string") {
    return config;
  }
  const normalized = normalizeAgentModelRefForConfig(value);
  return normalized !== value ? setPathValue(config, path, normalized) : config;
}

function normalizeAgentModelRefsAtPathForWrite(config: unknown, path: string[]): unknown {
  const agent = getPathValue(config, path);
  if (!isRecord(agent)) {
    return config;
  }

  let next = config;
  for (const key of AGENT_MODEL_CONFIG_KEYS) {
    next = normalizeModelConfigPathForWrite(next, [...path, key]);
  }
  next = normalizeModelStringPathForWrite(next, [...path, "utilityModel"]);
  next = normalizeModelStringPathForWrite(next, [...path, "heartbeat", "model"]);
  next = normalizeModelConfigPathForWrite(next, [...path, "subagents", "model"]);
  next = normalizeModelStringPathForWrite(next, [...path, "compaction", "model"]);
  next = normalizeModelStringPathForWrite(next, [...path, "compaction", "memoryFlush", "model"]);

  const models = getPathValue(next, [...path, "models"]);
  if (isRecord(models)) {
    const normalizedModels = normalizeAgentModelMapForConfig(models);
    if (normalizedModels !== models) {
      next = setPathValue(next, [...path, "models"], normalizedModels);
    }
  }
  return next;
}

function normalizeAgentListModelRefsForWrite(config: unknown): unknown {
  const list = getPathValue(config, ["agents", "list"]);
  if (!Array.isArray(list)) {
    return config;
  }

  let mutated = false;
  const nextList = list.map((agent) => {
    if (!isRecord(agent)) {
      return agent;
    }

    const normalized = normalizeAgentModelRefsAtPathForWrite({ agent }, ["agent"]) as {
      agent: unknown;
    };
    if (normalized.agent !== agent) {
      mutated = true;
      return normalized.agent;
    }
    return agent;
  });

  return mutated ? setPathValue(config, ["agents", "list"], nextList) : config;
}

function normalizeToolsModelRefsForWrite(config: unknown): unknown {
  return normalizeModelConfigPathForWrite(config, ["tools", "subagents", "model"]);
}

function normalizeModelProviderCatalogRefsForWrite(
  config: unknown,
  modelIdNormalizationPolicies?: ReadonlyMap<string, ManifestModelIdNormalizationProvider>,
): unknown {
  const providers = getPathValue(config, ["models", "providers"]);
  if (!isRecord(providers)) {
    return config;
  }

  let mutated = false;
  const nextProviders: Record<string, unknown> = { ...providers };
  for (const [provider, providerConfig] of Object.entries(providers)) {
    if (!isRecord(providerConfig) || !Array.isArray(providerConfig.models)) {
      continue;
    }

    let providerMutated = false;
    const models = providerConfig.models.map((model) => {
      if (!isRecord(model) || typeof model.id !== "string") {
        return model;
      }
      const trimmed = model.id.trim();
      if (!trimmed) {
        return model;
      }
      const id = normalizeConfiguredProviderCatalogModelId(
        provider,
        trimmed,
        modelIdNormalizationPolicies,
      );
      if (id === model.id) {
        return model;
      }
      providerMutated = true;
      return { ...model, id };
    });

    if (providerMutated) {
      nextProviders[provider] = { ...providerConfig, models };
      mutated = true;
    }
  }

  return mutated ? setPathValue(config, ["models", "providers"], nextProviders) : config;
}

function normalizeModelRefsForWrite(
  config: unknown,
  modelIdNormalizationPolicies?: ReadonlyMap<string, ManifestModelIdNormalizationProvider>,
): unknown {
  return normalizeModelProviderCatalogRefsForWrite(
    normalizeToolsModelRefsForWrite(
      normalizeAgentListModelRefsForWrite(
        normalizeAgentModelRefsAtPathForWrite(config, ["agents", "defaults"]),
      ),
    ),
    modelIdNormalizationPolicies,
  );
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
    if (includeOwnedPath) {
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

export function resolvePersistCandidateForWrite(params: {
  runtimeConfig: unknown;
  sourceConfig: unknown;
  nextConfig: unknown;
  rootAuthoredConfig?: unknown;
  unsetPaths?: readonly string[][];
  explicitSetPaths?: readonly (readonly string[])[];
  explicitSetValueSource?: unknown;
  modelIdNormalizationPolicies?: ReadonlyMap<string, ManifestModelIdNormalizationProvider>;
}): unknown {
  const patch = createMergePatch(params.runtimeConfig, params.nextConfig);
  const projectedSource = projectSourceOntoRuntimeShape(params.sourceConfig, params.runtimeConfig);
  const rootAuthoredConfig = params.rootAuthoredConfig ?? params.sourceConfig;
  const persistedBase = preserveUntouchedIncludes({
    runtimeConfig: params.runtimeConfig,
    sourceConfig: params.sourceConfig,
    nextConfig: params.nextConfig,
    rootAuthoredConfig,
    persistedCandidate: applyMergePatch(projectedSource, patch),
  });
  const persisted = injectExplicitlySetPaths({
    valueSource: params.explicitSetValueSource ?? params.nextConfig,
    persistedCandidate: persistedBase,
    explicitSetPaths: params.explicitSetPaths,
    rootAuthoredConfig,
  });
  const withSchema = preserveRootSchemaUri({
    rootAuthoredConfig,
    nextConfig: params.nextConfig,
    persistedCandidate: persisted,
  });
  const withAuthoredParams = preserveAuthoredAgentParams({
    sourceConfig: params.sourceConfig,
    nextConfig: params.nextConfig,
    rootAuthoredConfig,
    persistedCandidate: withSchema,
    unsetPaths: params.unsetPaths,
  });
  return normalizeModelRefsForWrite(withAuthoredParams, params.modelIdNormalizationPolicies);
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

export function formatConfigValidationFailure(pathLabel: string, issueMessage: string): string {
  const match = issueMessage.match(OPEN_DM_POLICY_ALLOW_FROM_RE);
  const policyPath = match?.groups?.policyPath?.trim();
  const allowPath = match?.groups?.allowPath?.trim();
  if (!policyPath || !allowPath) {
    return `Config validation failed: ${pathLabel}: ${issueMessage}`;
  }

  return [
    `Config validation failed: ${pathLabel}`,
    "",
    `Configuration mismatch: ${policyPath} is "open", but ${allowPath} does not include "*".`,
    "",
    "Fix with:",
    `  openclaw config set ${allowPath} '["*"]'`,
    "",
    "Or switch policy:",
    `  openclaw config set ${policyPath} "pairing"`,
  ].join("\n");
}

function isNumericPathSegment(raw: string): boolean {
  return parseArrayIndexPathSegment(raw) !== undefined;
}

function parseArrayIndexPathSegment(raw: string): number | undefined {
  return parseConfigPathArrayIndex(raw);
}

function isWritePlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwnObjectKey(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

const WRITE_PRUNED_OBJECT = Symbol("write-pruned-object");

function coerceConfig(value: unknown): OpenClawConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as OpenClawConfig;
}

function unsetPathForWriteAt(
  value: unknown,
  pathSegments: string[],
  depth: number,
): { changed: boolean; value: unknown } {
  if (depth >= pathSegments.length) {
    return { changed: false, value };
  }
  const segment = expectDefined(pathSegments[depth], "path segments entry at depth");
  const isLeaf = depth === pathSegments.length - 1;

  if (Array.isArray(value)) {
    const index = parseArrayIndexPathSegment(segment);
    if (index === undefined || index >= value.length) {
      return { changed: false, value };
    }
    if (isLeaf) {
      const next = value.slice();
      next.splice(index, 1);
      return { changed: true, value: next };
    }
    const child = unsetPathForWriteAt(value[index], pathSegments, depth + 1);
    if (!child.changed) {
      return { changed: false, value };
    }
    const next = value.slice();
    if (child.value === WRITE_PRUNED_OBJECT) {
      next.splice(index, 1);
    } else {
      next[index] = child.value;
    }
    return { changed: true, value: next };
  }

  if (
    isBlockedObjectKey(segment) ||
    !isWritePlainObject(value) ||
    !hasOwnObjectKey(value, segment)
  ) {
    return { changed: false, value };
  }
  if (isLeaf) {
    const next: Record<string, unknown> = { ...value };
    delete next[segment];
    return {
      changed: true,
      value: Object.keys(next).length === 0 ? WRITE_PRUNED_OBJECT : next,
    };
  }

  const child = unsetPathForWriteAt(value[segment], pathSegments, depth + 1);
  if (!child.changed) {
    return { changed: false, value };
  }
  const next: Record<string, unknown> = { ...value };
  if (child.value === WRITE_PRUNED_OBJECT) {
    delete next[segment];
  } else {
    next[segment] = child.value;
  }
  return {
    changed: true,
    value: Object.keys(next).length === 0 ? WRITE_PRUNED_OBJECT : next,
  };
}

function unsetPathForWrite(
  root: OpenClawConfig,
  pathSegments: string[],
): { changed: boolean; next: OpenClawConfig } {
  if (pathSegments.length === 0) {
    return { changed: false, next: root };
  }
  const result = unsetPathForWriteAt(root, pathSegments, 0);
  if (!result.changed) {
    return { changed: false, next: root };
  }
  if (result.value === WRITE_PRUNED_OBJECT) {
    return { changed: true, next: {} };
  }
  if (isWritePlainObject(result.value)) {
    return { changed: true, next: coerceConfig(result.value) };
  }
  return { changed: false, next: root };
}

export function applyUnsetPathsForWrite(
  root: OpenClawConfig,
  unsetPaths: readonly string[][] | undefined,
): OpenClawConfig {
  let next = root;
  for (const unsetPath of unsetPaths ?? []) {
    if (!Array.isArray(unsetPath) || unsetPath.length === 0) {
      continue;
    }
    const unsetResult = unsetPathForWrite(next, unsetPath);
    if (unsetResult.changed) {
      next = unsetResult.next;
    }
  }
  return next;
}

export function resolveManagedUnsetPathsForWrite(
  unsetPaths: readonly string[][] | undefined,
): string[][] {
  const next: string[][] = [];
  for (const managedPath of MANAGED_CONFIG_UNSET_PATHS) {
    next.push(Array.from(managedPath));
  }
  for (const unsetPath of unsetPaths ?? []) {
    if (!Array.isArray(unsetPath) || unsetPath.length === 0) {
      continue;
    }
    if (next.some((existing) => isDeepStrictEqual(existing, unsetPath))) {
      continue;
    }
    next.push([...unsetPath]);
  }
  return next;
}

export function collectChangedPaths(
  base: unknown,
  target: unknown,
  path: string,
  output: Set<string>,
): void {
  if (Array.isArray(base) && Array.isArray(target)) {
    const max = Math.max(base.length, target.length);
    for (let index = 0; index < max; index += 1) {
      const childPath = path ? `${path}[${index}]` : `[${index}]`;
      if (index >= base.length || index >= target.length) {
        output.add(childPath);
        continue;
      }
      collectChangedPaths(base[index], target[index], childPath, output);
    }
    return;
  }
  if (isRecord(base) && isRecord(target)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      const hasBase = Object.hasOwn(base, key);
      const hasTarget = Object.hasOwn(target, key);
      if (!hasTarget || !hasBase) {
        output.add(childPath);
        continue;
      }
      collectChangedPaths(base[key], target[key], childPath, output);
    }
    return;
  }
  if (!isDeepStrictEqual(base, target)) {
    output.add(path);
  }
}

function parentPath(value: string): string {
  if (!value) {
    return "";
  }
  if (value.endsWith("]")) {
    const index = value.lastIndexOf("[");
    return index > 0 ? value.slice(0, index) : "";
  }
  const index = value.lastIndexOf(".");
  return index >= 0 ? value.slice(0, index) : "";
}

function isPathChanged(path: string, changedPaths: Set<string>): boolean {
  if (changedPaths.has(path)) {
    return true;
  }
  let current = parentPath(path);
  while (current) {
    if (changedPaths.has(current)) {
      return true;
    }
    current = parentPath(current);
  }
  return changedPaths.has("");
}

export function restoreEnvRefsFromMap(
  value: unknown,
  path: string,
  envRefMap: Map<string, string>,
  changedPaths: Set<string>,
  identityRestoredPaths: ReadonlySet<string> = new Set(),
): unknown {
  if (typeof value === "string") {
    if (identityRestoredPaths.has(path)) {
      return value;
    }
    if (!isPathChanged(path, changedPaths)) {
      const original = envRefMap.get(path);
      if (original !== undefined) {
        return original;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item, index) => {
      const updated = restoreEnvRefsFromMap(
        item,
        `${path}[${index}]`,
        envRefMap,
        changedPaths,
        identityRestoredPaths,
      );
      if (updated !== item) {
        changed = true;
      }
      return updated;
    });
    return changed ? next : value;
  }
  if (isRecord(value)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      const updated = restoreEnvRefsFromMap(
        child,
        childPath,
        envRefMap,
        changedPaths,
        identityRestoredPaths,
      );
      if (updated !== child) {
        changed = true;
      }
      next[key] = updated;
    }
    return changed ? next : value;
  }
  return value;
}

export function resolveWriteEnvSnapshotForPath(params: {
  actualConfigPath: string;
  expectedConfigPath?: string;
  envSnapshotForRestore?: Record<string, string | undefined>;
}): Record<string, string | undefined> | undefined {
  if (
    params.expectedConfigPath === undefined ||
    params.expectedConfigPath === params.actualConfigPath
  ) {
    return params.envSnapshotForRestore;
  }
  return undefined;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
