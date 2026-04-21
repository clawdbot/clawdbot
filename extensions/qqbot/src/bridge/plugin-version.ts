/**
 * QQBot plugin version resolver.
 *
 * Reads the version field from this plugin's own `package.json` by
 * walking up the directory tree starting from `import.meta.url` of the
 * caller until a `package.json` whose `name` field matches the plugin
 * package id is located.
 *
 * Why not a hardcoded relative path?
 *   - The source file can live at different depths depending on whether
 *     we run from raw sources (`src/bridge/gateway.ts`) or a future
 *     compiled output. Hardcoding `"../../package.json"` breaks as soon
 *     as the source layout changes, which is what caused the previous
 *     `vunknown` regression.
 *   - A `name` guard prevents accidentally reading the parent
 *     `openclaw/package.json` (the framework root) when the plugin
 *     lives inside the monorepo.
 *
 * The lookup is performed only once per process at startup, so the
 * synchronous file I/O is negligible.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `name` field in this plugin's `package.json`. */
const QQBOT_PLUGIN_PKG_NAME = "@openclaw/qqbot";

/** Sentinel used when the version cannot be resolved. */
export const QQBOT_PLUGIN_VERSION_UNKNOWN = "unknown";

/**
 * Resolve the QQBot plugin version from `package.json`.
 *
 * @param startUrl — pass `import.meta.url` from the call site so the
 *   lookup begins at the caller's file regardless of where this helper
 *   itself lives. Falls back to this module's own location when omitted.
 */
export function resolveQQBotPluginVersion(startUrl?: string): string {
  const entryUrl = startUrl ?? import.meta.url;
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(entryUrl));
  } catch {
    return QQBOT_PLUGIN_VERSION_UNKNOWN;
  }

  const root = path.parse(dir).root;
  while (dir && dir !== root) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      const version = readQQBotVersionFromManifest(candidate);
      if (version) {
        return version;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return QQBOT_PLUGIN_VERSION_UNKNOWN;
}

/**
 * Read the `version` field from a `package.json` file and return it
 * only when the manifest describes the QQBot plugin itself.
 *
 * Returning `null` for mismatched or malformed manifests lets the
 * caller keep walking up the directory tree until the correct package
 * boundary is located.
 */
function readQQBotVersionFromManifest(manifestPath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const manifest = parsed as { name?: unknown; version?: unknown };
  if (manifest.name !== QQBOT_PLUGIN_PKG_NAME) {
    return null;
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    return null;
  }
  return manifest.version;
}
