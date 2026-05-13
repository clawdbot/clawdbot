import { isDeepStrictEqual } from "node:util";
import { normalizeConfiguredProviderCatalogModelId } from "../agents/model-ref-shared.js";
import { isRecord } from "../utils.js";
import { applyMergePatch } from "./merge-patch.js";
import { normalizeAgentModelMapForConfig, normalizeAgentModelRefForConfig } from "./model-input.js";
import { isBlockedObjectKey } from "./prototype-keys.js";
import type { OpenClawConfig } from "./types.js";

const OPEN_DM_POLICY_ALLOW_FROM_RE =
  /^(?<policyPath>[a-z0-9_.-]+)\s*=\s*"open"\s+requires\s+(?<allowPath>[a-z0-9_.-]+)(?:\s+\(or\s+[a-z0-9_.-]+\))?\s+to include "\*"$/i;

const MANAGED_CONFIG_UNSET_PATHS = [["plugins", "installs"]] as const;

function cloneUnknown<T>(value: T): T {
  return structuredClone(value);
}

export function createMergePatch(base: unknown, target: unknown): unknown {
  if (!isRecord(base) || !isRecord(target)) {
    return cloneUnknown(target);
  }

  const patch: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
  for (const key of keys) {
    const hasBase = key in base;
    const hasTarget = key in target;
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

function hasOwnIncludeKey(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, "$include");
}

function collectIncludeOwnedPaths(value: unknown, path: string[] = []): string[][] {
  if (!isRecord(value)) {
    return [];
  }
  if (hasOwnIncludeKey(value)) {
    return [path];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    collectIncludeOwnedPaths(child, [...path, key]),
  );
}

function patchTouchesPath(patch: unknown, path: string[]): boolean {
  if (path.length === 0) {
    return isRecord(patch) ? Object.keys(patch).length > 0 : true;
  }
  if (!isRecord(patch)) {
    return true;
  }
  const [head, ...tail] = path;
  if (!Object.prototype.hasOwnProperty.call(patch, head)) {
    return false;
  }
  return patchTouchesPath(patch[head], tail);
}

function formatConfigPath(path: string[]): string {
  return path.length > 0 ? path.join(".") : "<root>";
}

function getPathValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (!isNumericPathSegment(segment)) {
        return undefined;
      }
      const index = Number.parseInt(segment, 10);
      if (!Number.isFinite(index) || index < 0 || index >= current.length) {
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
  const [head, ...tail] = path;
  if (Array.isArray(value)) {
    if (!isNumericPathSegment(head)) {
      return value;
    }
    const index = Number.parseInt(head, 10);
    if (!Number.isFinite(index) || index < 0 || index >= value.length) {
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
  return collectIncludeOwnedPaths(rootAuthoredConfig).some(
    (includePath) => pathStartsWith(path, includePath) || pathStartsWith(includePath, path),
  );
}

function findOverlappingIncludeOwnedPath(
  rootAuthoredConfig: unknown,
  path: string[],
): string[] | undefined {
  return collectIncludeOwnedPaths(rootAuthoredConfig).find(
    (includePath) => pathStartsWith(path, includePath) || pathStartsWith(includePath, path),
  );
}

function setPathValueCreatingParents(value: unknown, path: string[], nextValue: unknown): unknown {
  if (path.length === 0) {
    return cloneUnknown(nextValue);
  }
  const [head, ...tail] = path;
  if (Array.isArray(value) || isNumericPathSegment(head)) {
    if (!isNumericPathSegment(head)) {
      return value;
    }
    const index = Number.parseInt(head, 10);
    if (!Number.isFinite(index) || index < 0) {
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
  if (path.length === 0 || !isRecord(value)) {
    return value;
  }
  const [head, ...tail] = path;
  if (!Object.prototype.hasOwnProperty.call(value, head)) {
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
  if (Object.prototype.hasOwnProperty.call(defaults, "params")) {
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
  for (const [modelId, modelEntry] of Object.entries(models)) {
    if (!isRecord(modelEntry) || !Object.prototype.hasOwnProperty.call(modelEntry, "params")) {
      continue;
    }
    const modelPath = [
      "agents",
      "defaults",
      "models",
      normalizeAgentModelRefForConfig(modelId) || modelId,
    ];
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

function normalizeAgentDefaultModelRefsForWrite(config: unknown): unknown {
  const defaults = getPathValue(config, ["agents", "defaults"]);
  if (!isRecord(defaults)) {
    return config;
  }

  let next = config;
  if (Object.prototype.hasOwnProperty.call(defaults, "model")) {
    const normalizedModel = normalizeAgentModelConfigForWrite(defaults.model);
    if (normalizedModel !== defaults.model) {
      next = setPathValue(next, ["agents", "defaults", "model"], normalizedModel);
    }
  }
  if (isRecord(defaults.models)) {
    const normalizedModels = normalizeAgentModelMapForConfig(defaults.models);
    if (normalizedModels !== defaults.models) {
      next = setPathValue(next, ["agents", "defaults", "models"], normalizedModels);
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

    let nextAgent = agent;
    if (Object.prototype.hasOwnProperty.call(agent, "model")) {
      const normalizedModel = normalizeAgentModelConfigForWrite(agent.model);
      if (normalizedModel !== agent.model) {
        nextAgent = { ...nextAgent, model: normalizedModel };
        mutated = true;
      }
    }
    if (isRecord(agent.models)) {
      const normalizedModels = normalizeAgentModelMapForConfig(agent.models);
      if (normalizedModels !== agent.models) {
        nextAgent = { ...nextAgent, models: normalizedModels };
        mutated = true;
      }
    }
    return nextAgent;
  });

  return mutated ? setPathValue(config, ["agents", "list"], nextList) : config;
}

function normalizeModelProviderCatalogRefsForWrite(config: unknown): unknown {
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
      const id = normalizeConfiguredProviderCatalogModelId(provider, trimmed);
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

function normalizeModelRefsForWrite(config: unknown): unknown {
  return normalizeModelProviderCatalogRefsForWrite(
    normalizeAgentListModelRefsForWrite(normalizeAgentDefaultModelRefsForWrite(config)),
  );
}

function preserveUntouchedIncludes(params: {
  patch: unknown;
  rootAuthoredConfig: unknown;
  persistedCandidate: unknown;
}): unknown {
  let next = params.persistedCandidate;
  for (const includePath of collectIncludeOwnedPaths(params.rootAuthoredConfig)) {
    if (patchTouchesPath(params.patch, includePath)) {
      throw new Error(
        `Config write would flatten $include-owned config at ${formatConfigPath(
          includePath,
        )}; edit that include file directly or remove the $include first.`,
      );
    }
    next = setPathValue(next, includePath, getPathValue(params.rootAuthoredConfig, includePath));
  }
  return next;
}

function hasPathValue(value: unknown, path: readonly string[]): boolean {
  if (path.length === 0) {
    return true;
  }
  const [head, ...tail] = path;
  if (Array.isArray(value)) {
    if (!isNumericPathSegment(head)) {
      return false;
    }
    const index = Number.parseInt(head, 10);
    if (!Number.isFinite(index) || index < 0 || index >= value.length) {
      return false;
    }
    return tail.length === 0 || hasPathValue(value[index], tail);
  }
  if (!isRecord(value)) {
    return false;
  }
  if (isBlockedObjectKey(head) || !Object.prototype.hasOwnProperty.call(value, head)) {
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
      const index = Number.parseInt(key, 10);
      if (!Number.isFinite(index) || index < 0) {
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
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
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

export function injectExplicitlySetPaths(params: {
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
}): unknown {
  const patch = createMergePatch(params.runtimeConfig, params.nextConfig);
  const projectedSource = projectSourceOntoRuntimeShape(params.sourceConfig, params.runtimeConfig);
  const rootAuthoredConfig = params.rootAuthoredConfig ?? params.sourceConfig;
  const persistedBase = preserveUntouchedIncludes({
    patch,
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
  return normalizeModelRefsForWrite(withAuthoredParams);
}

function readRootSchemaUri(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.$schema !== "string") {
    return undefined;
  }
  return value.$schema;
}

function hasOwnRootSchemaKey(value: unknown): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, "$schema");
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
  return /^[0-9]+$/.test(raw);
}

function isWritePlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwnObjectKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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
  const segment = pathSegments[depth];
  const isLeaf = depth === pathSegments.length - 1;

  if (Array.isArray(value)) {
    if (!isNumericPathSegment(segment)) {
      return { changed: false, value };
    }
    const index = Number.parseInt(segment, 10);
    if (!Number.isFinite(index) || index < 0 || index >= value.length) {
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

export function unsetPathForWrite(
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
      const hasBase = key in base;
      const hasTarget = key in target;
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
): unknown {
  if (typeof value === "string") {
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
      const updated = restoreEnvRefsFromMap(item, `${path}[${index}]`, envRefMap, changedPaths);
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
      const updated = restoreEnvRefsFromMap(child, childPath, envRefMap, changedPaths);
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
