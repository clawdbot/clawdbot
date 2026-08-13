// Applies immutable path removals to config-like objects.
import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import type { OpenClawConfig } from "./types.js";

const MANAGED_CONFIG_UNSET_PATHS = [["plugins", "installs"]] as const;
const WRITE_PRUNED_OBJECT = Symbol("write-pruned-object");

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
    const index = parseConfigPathArrayIndex(segment);
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

  if (isBlockedObjectKey(segment) || !isRecord(value) || !Object.hasOwn(value, segment)) {
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
  if (isRecord(result.value)) {
    return { changed: true, next: result.value as OpenClawConfig };
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
