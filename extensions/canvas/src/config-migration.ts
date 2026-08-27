/** Canvas config migration to the single surviving route-enable switch. */
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  asBoolean,
  asOptionalRecord as readRecord,
  readStringValue as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";

const RETIRED_HOST_KEYS = ["root", "port", "liveReload"] as const;

export function resolveLegacyCanvasDocumentsDir(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
}): string | null {
  const pluginConfig = resolvePluginConfigObject(params.config, "canvas");
  const configuredRoot = readString(readRecord(pluginConfig?.host)?.root)?.trim();
  if (!configuredRoot) {
    return null;
  }
  const legacyDir = path.join(
    path.resolve(resolveUserPath(configuredRoot, params.env)),
    "documents",
  );
  return legacyDir === path.resolve(params.stateDir, "canvas", "documents") ? null : legacyDir;
}

export function listLegacyCanvasDocumentIds(documentsDir: string): string[] {
  try {
    return fs
      .readdirSync(documentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted();
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return [];
    }
    throw new Error(
      `Cannot read Canvas documents at ${documentsDir}: ${String(error)}. Keep plugins.entries.canvas.config.host.root, fix access, then rerun "openclaw doctor --fix".`,
      { cause: error },
    );
  }
}

/** Removes retired file-host settings while preserving the route enablement choice. */
export function migrateCanvasHostConfig(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} | null {
  const legacyHost = readRecord((config as { canvasHost?: unknown }).canvasHost);
  const plugins = readRecord(config.plugins);
  const entries = readRecord(plugins?.entries);
  const canvasEntry = readRecord(entries?.canvas);
  const canvasConfig = readRecord(canvasEntry?.config);
  const existingHost = readRecord(canvasConfig?.host);
  // An unresolved template is not evidence that its source directory is absent.
  // Doctor's resolved config pass can retire it once the source is inspectable.
  if (readString(existingHost?.root)?.includes("${")) {
    return null;
  }
  const legacyDir = resolveLegacyCanvasDocumentsDir({
    config,
    env: process.env,
    stateDir: resolveStateDir(),
  });
  let retainRoot = false;
  if (legacyDir) {
    // Normalization also runs before migration and through setup. Only a verified
    // empty source may lose its retry locator; unreadable sources remain pending.
    try {
      retainRoot = listLegacyCanvasDocumentIds(legacyDir).length > 0;
    } catch {
      retainRoot = true;
    }
  }
  const retiredKeys = RETIRED_HOST_KEYS.filter(
    (key) => Object.hasOwn(existingHost ?? {}, key) && !(key === "root" && retainRoot),
  );
  if (!legacyHost && retiredKeys.length === 0) {
    return null;
  }

  const next = structuredClone(config) as OpenClawConfig & { canvasHost?: unknown };
  delete next.canvasHost;
  const enabled = asBoolean(existingHost?.enabled) ?? asBoolean(legacyHost?.enabled);
  const nextPlugins = readRecord(next.plugins) ?? {};
  const nextEntries = readRecord(nextPlugins.entries) ?? {};
  const nextEntry = readRecord(nextEntries.canvas) ?? {};
  const nextPluginConfig = readRecord(nextEntry.config) ?? {};

  if (existingHost || enabled !== undefined) {
    if (enabled === undefined && !retainRoot) {
      delete nextPluginConfig.host;
    } else {
      nextPluginConfig.host = {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(retainRoot ? { root: existingHost?.root } : {}),
      };
    }
    nextEntry.config = nextPluginConfig;
    nextEntries.canvas = nextEntry;
    nextPlugins.entries = nextEntries;
    next.plugins = nextPlugins;
  }

  const changes: string[] = [];
  if (legacyHost) {
    changes.push(
      enabled === undefined
        ? "Removed retired canvasHost configuration."
        : "Migrated canvasHost.enabled to plugins.entries.canvas.config.host.enabled.",
    );
  }
  if (retiredKeys.length > 0) {
    changes.push(
      `Removed retired Canvas host config: ${retiredKeys.map((key) => `plugins.entries.canvas.config.host.${key}`).join(", ")}.`,
    );
  }
  return { config: next, changes };
}
