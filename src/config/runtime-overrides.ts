import type { ClawdbotConfig } from "./types.js";

type OverrideTree = Record<string, unknown>;

let overrides: OverrideTree = {};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

function parsePath(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(".").map((part) => part.trim());
  if (parts.some((part) => !part)) return null;
  return parts;
}

function setOverrideAtPath(
  root: OverrideTree,
  path: string[],
  value: unknown,
): void {
  let cursor: OverrideTree = root;
  for (let idx = 0; idx < path.length - 1; idx += 1) {
    const key = path[idx];
    const next = cursor[key];
    if (!isPlainObject(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as OverrideTree;
  }
  cursor[path[path.length - 1]] = value;
}

function unsetOverrideAtPath(root: OverrideTree, path: string[]): boolean {
  const stack: Array<{ node: OverrideTree; key: string }> = [];
  let cursor: OverrideTree = root;
  for (let idx = 0; idx < path.length - 1; idx += 1) {
    const key = path[idx];
    const next = cursor[key];
    if (!isPlainObject(next)) return false;
    stack.push({ node: cursor, key });
    cursor = next;
  }
  const leafKey = path[path.length - 1];
  if (!(leafKey in cursor)) return false;
  delete cursor[leafKey];
  for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
    const { node, key } = stack[idx];
    const child = node[key];
    if (isPlainObject(child) && Object.keys(child).length === 0) {
      delete node[key];
    } else {
      break;
    }
  }
  return true;
}

function mergeOverrides(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const next: OverrideTree = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    next[key] = mergeOverrides((base as OverrideTree)[key], value);
  }
  return next;
}

export function getConfigOverrides(): OverrideTree {
  return overrides;
}

export function resetConfigOverrides(): void {
  overrides = {};
}

export function setConfigOverride(
  pathRaw: string,
  value: unknown,
): {
  ok: boolean;
  error?: string;
} {
  const path = parsePath(pathRaw);
  if (!path) {
    return {
      ok: false,
      error: "Invalid path. Use dot notation (e.g. foo.bar).",
    };
  }
  setOverrideAtPath(overrides, path, value);
  return { ok: true };
}

export function unsetConfigOverride(pathRaw: string): {
  ok: boolean;
  removed: boolean;
  error?: string;
} {
  const path = parsePath(pathRaw);
  if (!path) {
    return { ok: false, removed: false, error: "Invalid path." };
  }
  const removed = unsetOverrideAtPath(overrides, path);
  return { ok: true, removed };
}

export function applyConfigOverrides(cfg: ClawdbotConfig): ClawdbotConfig {
  if (!overrides || Object.keys(overrides).length === 0) return cfg;
  return mergeOverrides(cfg, overrides) as ClawdbotConfig;
}
