/** Doctor-owned migration of shipped generated provider catalogs into agent SQLite. */
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { migrateLegacyPluginModelCatalogs } from "../agents/plugin-model-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import {
  detectLegacyPluginModelCatalogs,
  type LegacyPluginModelCatalogMigration,
} from "./doctor-plugin-model-catalog-detection.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

/** Imports and verifies released sidecars before Doctor removes any legacy bytes. */
export async function maybeMigrateLegacyPluginModelCatalogs(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: readonly string[];
  prompter: DoctorPrompter;
  runtime: RuntimeEnv;
  note?: typeof note;
}): Promise<{ detected: number; migrated: number; warnings: string[] }> {
  const detection = await detectLegacyPluginModelCatalogs(params);
  const warnings = [...detection.warnings];
  const migrations = detection.migrations;
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
