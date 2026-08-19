// Normalizes path-like config values to canonical user paths.
import { isPlainObject, resolveUserPath } from "../utils.js";
import type { OpenClawConfig } from "./types.js";

const PATH_VALUE_RE = /^~(?=$|[\\/])/;

const PATH_KEY_RE = /(dir|path|paths|file|root|workspace)$/i;
const PATH_LIST_KEYS = new Set(["paths", "pathPrepend"]);

function normalizeStringValue(key: string | undefined, value: string): string {
  if (!PATH_VALUE_RE.test(value.trim())) {
    return value;
  }
  if (!key) {
    return value;
  }
  if (PATH_KEY_RE.test(key) || PATH_LIST_KEYS.has(key)) {
    return resolveUserPath(value);
  }
  return value;
}

function normalizeAny(key: string | undefined, value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeStringValue(key, value);
  }

  if (Array.isArray(value)) {
    const normalizeChildren = Boolean(key && PATH_LIST_KEYS.has(key));
    let mutated = false;
    const normalized = value.map((entry) => {
      let next = entry;
      if (typeof entry === "string") {
        next = normalizeChildren ? normalizeStringValue(key, entry) : entry;
      } else if (Array.isArray(entry) || isPlainObject(entry)) {
        next = normalizeAny(undefined, entry);
      }
      if (next !== entry) {
        mutated = true;
      }
      return next;
    });
    return mutated ? normalized : value;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  let normalized: Record<string, unknown> = value;
  for (const [childKey, childValue] of Object.entries(value)) {
    const next = normalizeAny(childKey, childValue);
    if (next !== childValue) {
      if (normalized === value) {
        normalized = { ...value };
      }
      normalized[childKey] = next;
    }
  }

  return normalized;
}

/**
 * Normalize "~" paths in path-ish config fields.
 *
 * Goal: accept `~/...` consistently across config file + env overrides, while
 * keeping the surface area small and predictable.
 */
export function normalizeConfigPaths(cfg: OpenClawConfig): OpenClawConfig {
  if (!cfg || typeof cfg !== "object") {
    return cfg;
  }
  // SAFETY: normalization only copy-on-writes existing config containers and rewrites string values.
  return normalizeAny(undefined, cfg) as OpenClawConfig;
}
