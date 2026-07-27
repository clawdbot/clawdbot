import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
// Applies runtime-only config overrides without mutating persisted config.
import { isPlainObject } from "../utils.js";
import { parseConfigPath, setConfigValueAtPath, unsetConfigValueAtPath } from "./config-paths.js";
import type { OpenClawConfig } from "./types.js";

type OverrideTree = Record<string, unknown>;

let overrides: OverrideTree = {};

function sanitizeOverrideValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeOverrideValue(entry, seen));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  if (seen.has(value)) {
    return {};
  }
  seen.add(value);
  const sanitized: OverrideTree = {};
  for (const [key, entry] of Object.entries(value)) {
    // Overrides can come from debug commands, so strip prototype keys before they reach config.
    if (entry === undefined || isBlockedObjectKey(key)) {
      continue;
    }
    sanitized[key] = sanitizeOverrideValue(entry, seen);
  }
  seen.delete(value);
  return sanitized;
}

function mergeOverrides(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override;
  }
  const next: OverrideTree = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || isBlockedObjectKey(key)) {
      continue;
    }
    next[key] = mergeOverrides((base as OverrideTree)[key], value);
  }
  return next;
}

/** Return the process-local runtime override tree used by debug config commands. */
export function getConfigOverrides(): OverrideTree {
  return overrides;
}

/** Clear all process-local runtime overrides. Intended for debug reset flows and tests. */
export function resetConfigOverrides(): void {
  overrides = {};
}

/** Set one runtime override at a parsed config path after sanitizing object values. */
export function setConfigOverride(pathRaw: string, value: unknown): Result<string[], string> {
  const parsed = parseConfigPath(pathRaw);
  if (!parsed.ok) {
    return err(parsed.error);
  }
  setConfigValueAtPath(overrides, parsed.path, sanitizeOverrideValue(value));
  return ok(parsed.path);
}

/** Remove one runtime override path and report whether an override was present. */
export function unsetConfigOverride(pathRaw: string): Result<boolean, string> {
  const parsed = parseConfigPath(pathRaw);
  if (!parsed.ok) {
    return err(parsed.error);
  }
  const removed = unsetConfigValueAtPath(overrides, parsed.path);
  return ok(removed);
}

/** Merge the current runtime overrides over a loaded config without mutating the input config. */
export function applyConfigOverrides(cfg: OpenClawConfig): OpenClawConfig {
  if (!overrides || Object.keys(overrides).length === 0) {
    return cfg;
  }
  return mergeOverrides(cfg, overrides) as OpenClawConfig;
}

/** Capture an immutable applier for the process-local overrides active at this instant. */
export function captureConfigOverrideApplier(): (cfg: OpenClawConfig) => OpenClawConfig {
  const capturedOverrides = structuredClone(overrides);
  if (Object.keys(capturedOverrides).length === 0) {
    return (cfg) => cfg;
  }
  return (cfg) => mergeOverrides(cfg, capturedOverrides) as OpenClawConfig;
}
