/** Doctor-owned migration of shipped generated provider catalogs into agent SQLite. */
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds, resolveAgentDir, resolveDefaultAgentDir } from "../agents/agent-scope.js";
import {
  decodePluginModelCatalogRelativePathPluginId,
  isGeneratedPluginModelCatalog,
  isPluginModelCatalogMigrationFile,
  migrateLegacyPluginModelCatalogs,
} from "../agents/plugin-model-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { privateFileStore } from "../infra/private-file-store.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type LegacyPluginModelCatalogMigration = {
  agentDir: string;
  pluginId: string;
  relativePath: string;
  contents: string;
};

function resolveMigrationAgentDirs(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: readonly string[];
}): string[] {
  if (params.agentDirs) {
    return [...new Set(params.agentDirs)].toSorted((left, right) => left.localeCompare(right));
  }
  const env = params.env ?? process.env;
  const agentIds = listAgentIds(params.cfg);
  const configuredAgentDirs =
    agentIds.length > 0
      ? agentIds.map((agentId) => resolveAgentDir(params.cfg, agentId, env))
      : [resolveDefaultAgentDir(params.cfg, env)];
  return [...new Set(configuredAgentDirs)].toSorted((left, right) => left.localeCompare(right));
}

async function readLegacyPluginCatalogContents(params: {
  agentDir: string;
  relativePath: string;
}): Promise<string | null> {
  const pluginDir = path.dirname(path.join(params.agentDir, params.relativePath));
  return await privateFileStore(pluginDir).readTextIfExists(path.basename(params.relativePath));
}

/** Detects only marker-backed catalogs produced by tagged OpenClaw releases. */
async function collectLegacyPluginModelCatalogMigrations(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: readonly string[];
  warnings?: string[];
}): Promise<LegacyPluginModelCatalogMigration[]> {
  const migrations: LegacyPluginModelCatalogMigration[] = [];
  for (const agentDir of resolveMigrationAgentDirs(params)) {
    const pluginsDir = path.join(agentDir, "plugins");
    let pluginDirs: Dirent[];
    try {
      pluginDirs = await fs.readdir(pluginsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      params.warnings?.push(
        `Could not inspect legacy provider catalogs: ${shortenHomePath(pluginsDir)}`,
      );
      continue;
    }
    for (const pluginDir of pluginDirs) {
      if (!pluginDir.isDirectory()) {
        continue;
      }
      const canonicalRelativePath = path.join("plugins", pluginDir.name, "catalog.json");
      const pluginId = decodePluginModelCatalogRelativePathPluginId(canonicalRelativePath);
      if (!pluginId) {
        continue;
      }
      const pluginPath = path.join(pluginsDir, pluginDir.name);
      let catalogFiles: Dirent[];
      try {
        catalogFiles = await fs.readdir(pluginPath, { withFileTypes: true });
      } catch {
        params.warnings?.push(
          `Could not inspect legacy provider catalogs: ${shortenHomePath(pluginPath)}`,
        );
        continue;
      }
      const sourceFiles = catalogFiles
        .filter((entry) => entry.isFile() && isPluginModelCatalogMigrationFile(entry.name))
        .toSorted((left, right) => {
          if (left.name === "catalog.json") {
            return 1;
          }
          if (right.name === "catalog.json") {
            return -1;
          }
          return left.name.localeCompare(right.name);
        });
      const pluginMigrations: LegacyPluginModelCatalogMigration[] = [];
      let hasUnreadableCatalog = false;
      for (const sourceFile of sourceFiles) {
        const relativePath = path.join("plugins", pluginDir.name, sourceFile.name);
        let contents: string | null;
        try {
          contents = await readLegacyPluginCatalogContents({ agentDir, relativePath });
        } catch {
          hasUnreadableCatalog = true;
          params.warnings?.push(
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
          pluginMigrations.push({ agentDir, pluginId, relativePath, contents });
        }
      }
      if (hasUnreadableCatalog) {
        continue;
      }
      if (
        !pluginMigrations.some(
          (migration) => path.basename(migration.relativePath) === "catalog.json",
        ) &&
        new Set(pluginMigrations.map((migration) => migration.contents)).size > 1
      ) {
        params.warnings?.push(
          `Conflicting retained legacy provider catalogs: ${shortenHomePath(pluginPath)}`,
        );
        continue;
      }
      migrations.push(...pluginMigrations);
    }
  }
  return migrations.toSorted((left, right) => {
    const agentOrder = left.agentDir.localeCompare(right.agentDir);
    return agentOrder !== 0 ? agentOrder : left.pluginId.localeCompare(right.pluginId);
  });
}

/** Imports and verifies released sidecars before Doctor removes any legacy bytes. */
export async function maybeMigrateLegacyPluginModelCatalogs(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: readonly string[];
  prompter: DoctorPrompter;
  runtime: RuntimeEnv;
  note?: typeof note;
}): Promise<{ detected: number; migrated: number; warnings: string[] }> {
  const warnings: string[] = [];
  const migrations = await collectLegacyPluginModelCatalogMigrations({ ...params, warnings });
  for (const warning of warnings) {
    params.runtime.error(warning);
  }
  if (migrations.length === 0) {
    return { detected: 0, migrated: 0, warnings };
  }

  const emitNote = params.note ?? note;
  emitNote(
    [
      "Legacy generated provider catalogs contain model and credential state.",
      ...migrations.map(
        (migration) =>
          `- ${shortenHomePath(path.join(migration.agentDir, migration.relativePath))}`,
      ),
      "Run openclaw doctor --fix to verify and migrate these catalogs into agent SQLite.",
    ].join("\n"),
    "Plugin model catalogs",
  );
  const shouldRepair =
    params.prompter.shouldRepair ||
    (await params.prompter.confirmAutoFix({
      message: "Migrate generated provider model catalogs into agent SQLite now?",
      initialValue: true,
    }));
  if (!shouldRepair) {
    return { detected: migrations.length, migrated: 0, warnings };
  }

  const grouped = new Map<string, LegacyPluginModelCatalogMigration[]>();
  for (const migration of migrations) {
    const agentMigrations = grouped.get(migration.agentDir) ?? [];
    agentMigrations.push(migration);
    grouped.set(migration.agentDir, agentMigrations);
  }

  let migrated = 0;
  for (const [agentDir, agentMigrations] of grouped) {
    const result = migrateLegacyPluginModelCatalogs({
      agentDir,
      expectedContents: new Map(
        agentMigrations.map((migration) => [migration.pluginId, migration.contents]),
      ),
    });
    migrated += result.migrated;
    for (const warning of result.warnings) {
      const displayWarning = shortenHomePath(warning);
      if (warnings.includes(displayWarning)) {
        continue;
      }
      warnings.push(displayWarning);
      params.runtime.error(displayWarning);
    }
  }

  if (migrated > 0) {
    emitNote(
      `Migrated and verified ${migrated} generated provider catalog${migrated === 1 ? "" : "s"} in agent SQLite.`,
      "Doctor changes",
    );
  }
  return { detected: migrations.length, migrated, warnings };
}
