import { isDeepStrictEqual } from "node:util";
import { isRecord } from "../utils.js";
import { applyMergePatch } from "./merge-patch.js";
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
  if (!isRecord(value)) {
    return value;
  }
  const [head, ...tail] = path;
  return {
    ...value,
    [head]: setPathValue(value[head], tail, nextValue),
  };
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

export function resolvePersistCandidateForWrite(params: {
  runtimeConfig: unknown;
  sourceConfig: unknown;
  nextConfig: unknown;
  rootAuthoredConfig?: unknown;
}): unknown {
  const patch = createMergePatch(params.runtimeConfig, params.nextConfig);
  const projectedSource = projectSourceOntoRuntimeShape(params.sourceConfig, params.runtimeConfig);
  const persisted = preserveUntouchedIncludes({
    patch,
    rootAuthoredConfig: params.rootAuthoredConfig ?? params.sourceConfig,
    persistedCandidate: applyMergePatch(projectedSource, patch),
  });
  return preserveRootSchemaUri({
    rootAuthoredConfig: params.rootAuthoredConfig ?? params.sourceConfig,
    nextConfig: params.nextConfig,
    persistedCandidate: persisted,
  });
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
