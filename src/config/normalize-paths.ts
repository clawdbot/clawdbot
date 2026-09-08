// Normalizes path-like config values to canonical user paths.
import { isPlainObject, resolveUserPath } from "../utils.js";
import type { OpenClawConfig } from "./types.js";

const PATH_VALUE_RE = /^~(?=$|[\\/])/;

const PATH_KEY_RE = /(dir|path|paths|file|root|workspace)$/i;
const PATH_LIST_KEYS = new Set(["paths", "pathPrepend"]);

/** Normalize tilde paths in path-like config fields using the config reader's home. */
export function normalizeConfigPaths(
  cfg: OpenClawConfig,
  opts?: { env?: NodeJS.ProcessEnv; homedir?: () => string },
): OpenClawConfig {
  // Status can read a daemon's config from a different home. Capture that
  // resolution context once so nested paths cannot fall back to the CLI home.
  function normalizeAny(key: string | undefined, value: unknown): unknown {
    if (typeof value === "string") {
      return key &&
        PATH_VALUE_RE.test(value.trim()) &&
        (PATH_KEY_RE.test(key) || PATH_LIST_KEYS.has(key))
        ? resolveUserPath(value, opts?.env, opts?.homedir)
        : value;
    }
    if (Array.isArray(value)) {
      const normalizeChildren = Boolean(key && PATH_LIST_KEYS.has(key));
      // Only direct string children of path lists inherit the field's path semantics.
      return value.map((entry) =>
        normalizeAny(typeof entry === "string" && normalizeChildren ? key : undefined, entry),
      );
    }
    if (isPlainObject(value)) {
      for (const [childKey, childValue] of Object.entries(value)) {
        const next = normalizeAny(childKey, childValue);
        if (next !== childValue) {
          value[childKey] = next;
        }
      }
    }
    return value;
  }
  normalizeAny(undefined, cfg);
  return cfg;
}
