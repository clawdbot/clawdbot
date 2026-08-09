/** Non-mutating Doctor discovery for shipped generated provider catalog sidecars. */
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentDir,
  resolveDefaultAgentDir,
} from "../agents/agent-scope-config.js";
import {
  decodePluginModelCatalogRelativePathPluginId,
  isGeneratedPluginModelCatalog,
  isPluginModelCatalogMigrationFile,
  PLUGIN_MODEL_CATALOG_FILE,
} from "../agents/plugin-model-catalog-repair.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { privateFileStore } from "../infra/private-file-store.js";
import { shortenHomePath } from "../utils.js";

export type LegacyPluginModelCatalogMigration = {
  agentDir: string;
  pluginId: string;
  relativePath: string;
  contents: string;
};

export type LegacyPluginModelCatalogDetection = Omit<LegacyPluginModelCatalogMigration, "contents">;

export type LegacyPluginModelCatalogDetectionResult = {
  /** Every readable sidecar with the exact released generator marker. */
  detected: LegacyPluginModelCatalogDetection[];
  /** Catalogs Doctor can import without choosing between unreadable or conflicting claims. */
  migrations: LegacyPluginModelCatalogMigration[];
  warnings: string[];
};

function formatLegacyPluginModelCatalogPaths(
  catalogs: readonly LegacyPluginModelCatalogDetection[],
): string[] {
  return catalogs.map(
    (catalog) => `- ${shortenHomePath(path.join(catalog.agentDir, catalog.relativePath))}`,
  );
}

export function formatLegacyPluginModelCatalogStartupRefusal(
  catalogs: readonly LegacyPluginModelCatalogDetection[],
): string {
  return [
    "OpenClaw found released legacy plugin model catalogs; refusing to report the gateway ready because runtime model discovery reads canonical SQLite state only.",
    ...formatLegacyPluginModelCatalogPaths(catalogs),
    'Run "openclaw doctor --fix" against the same state/config, then restart the gateway.',
  ].join("\n");
}

export function formatLegacyPluginModelCatalogCommandRefusal(
  catalogs: readonly LegacyPluginModelCatalogDetection[],
): string {
  return [
    "OpenClaw found released legacy plugin model catalogs; refusing to report incomplete model results because runtime model discovery reads canonical SQLite state only.",
    ...formatLegacyPluginModelCatalogPaths(catalogs),
    'Run "openclaw doctor --fix" against the same state/config, then rerun the command.',
  ].join("\n");
}

export async function findLegacyPluginCatalogStartupRefusal(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const detection = await detectLegacyPluginModelCatalogs(params);
  return detection.detected.length > 0
    ? formatLegacyPluginModelCatalogStartupRefusal(detection.detected)
    : undefined;
}

function resolveDetectionAgentDirs(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: readonly string[];
}): string[] {
  if (params.agentDirs) {
    return [...new Set(params.agentDirs)].toSorted((left, right) => left.localeCompare(right));
  }
  const env = params.env ?? process.env;
  return [
    ...new Set([
      resolveDefaultAgentDir(params.cfg, env),
      ...listAgentIds(params.cfg).map((agentId) => resolveAgentDir(params.cfg, agentId, env)),
    ]),
  ].toSorted((left, right) => left.localeCompare(right));
}

async function readLegacyPluginCatalogContents(params: {
  agentDir: string;
  relativePath: string;
}): Promise<string | null> {
  const pluginDir = path.dirname(path.join(params.agentDir, params.relativePath));
  return await privateFileStore(pluginDir).readTextIfExists(path.basename(params.relativePath));
}

function sortDetections<T extends LegacyPluginModelCatalogDetection>(detections: T[]): T[] {
  return detections.toSorted((left, right) => {
    const agentOrder = left.agentDir.localeCompare(right.agentDir);
    if (agentOrder !== 0) {
      return agentOrder;
    }
    const pluginOrder = left.pluginId.localeCompare(right.pluginId);
    if (pluginOrder !== 0) {
      return pluginOrder;
    }
    const leftCanonical = path.basename(left.relativePath) === PLUGIN_MODEL_CATALOG_FILE;
    const rightCanonical = path.basename(right.relativePath) === PLUGIN_MODEL_CATALOG_FILE;
    if (leftCanonical !== rightCanonical) {
      return leftCanonical ? 1 : -1;
    }
    return left.relativePath.localeCompare(right.relativePath);
  });
}

/**
 * Detects released sidecars without creating SQLite or changing any source file.
 * Conflict and unreadable-source policy stays with Doctor; startup only consumes `detected`.
 */
export async function detectLegacyPluginModelCatalogs(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: readonly string[];
}): Promise<LegacyPluginModelCatalogDetectionResult> {
  const detected: LegacyPluginModelCatalogDetection[] = [];
  const migrations: LegacyPluginModelCatalogMigration[] = [];
  const warnings: string[] = [];
  for (const agentDir of resolveDetectionAgentDirs(params)) {
    const pluginsDir = path.join(agentDir, "plugins");
    let pluginDirs: Dirent[];
    try {
      pluginDirs = await fs.readdir(pluginsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      warnings.push(`Could not inspect legacy provider catalogs: ${shortenHomePath(pluginsDir)}`);
      continue;
    }
    for (const pluginDir of pluginDirs) {
      if (!pluginDir.isDirectory()) {
        continue;
      }
      const canonicalRelativePath = path.join("plugins", pluginDir.name, PLUGIN_MODEL_CATALOG_FILE);
      const pluginId = decodePluginModelCatalogRelativePathPluginId(canonicalRelativePath);
      if (!pluginId) {
        continue;
      }
      const pluginPath = path.join(pluginsDir, pluginDir.name);
      let catalogFiles: Dirent[];
      try {
        catalogFiles = await fs.readdir(pluginPath, { withFileTypes: true });
      } catch {
        warnings.push(`Could not inspect legacy provider catalogs: ${shortenHomePath(pluginPath)}`);
        continue;
      }
      const sourceFiles = catalogFiles
        .filter((entry) => entry.isFile() && isPluginModelCatalogMigrationFile(entry.name))
        .toSorted((left, right) => {
          if (left.name === PLUGIN_MODEL_CATALOG_FILE) {
            return 1;
          }
          if (right.name === PLUGIN_MODEL_CATALOG_FILE) {
            return -1;
          }
          return left.name.localeCompare(right.name);
        });
      const pluginDetections: LegacyPluginModelCatalogMigration[] = [];
      let hasUnreadableCatalog = false;
      for (const sourceFile of sourceFiles) {
        const relativePath = path.join("plugins", pluginDir.name, sourceFile.name);
        let contents: string | null;
        try {
          contents = await readLegacyPluginCatalogContents({ agentDir, relativePath });
        } catch {
          hasUnreadableCatalog = true;
          warnings.push(
            `Could not read legacy provider catalog: ${shortenHomePath(path.join(agentDir, relativePath))}`,
          );
          continue;
        }
        if (contents === null) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(contents) as unknown;
        } catch {
          continue;
        }
        if (isGeneratedPluginModelCatalog(parsed)) {
          pluginDetections.push({ agentDir, pluginId, relativePath, contents });
        }
      }
      detected.push(
        ...pluginDetections.map((detection) => ({
          agentDir: detection.agentDir,
          pluginId: detection.pluginId,
          relativePath: detection.relativePath,
        })),
      );
      if (hasUnreadableCatalog) {
        continue;
      }
      if (
        !pluginDetections.some(
          (detection) => path.basename(detection.relativePath) === PLUGIN_MODEL_CATALOG_FILE,
        ) &&
        new Set(pluginDetections.map((detection) => detection.contents)).size > 1
      ) {
        warnings.push(
          `Conflicting retained legacy provider catalogs: ${shortenHomePath(pluginPath)}`,
        );
        continue;
      }
      migrations.push(...pluginDetections);
    }
  }
  return {
    detected: sortDetections(detected),
    migrations: sortDetections(migrations),
    warnings,
  };
}
