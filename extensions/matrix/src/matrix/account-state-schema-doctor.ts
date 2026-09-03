// Matrix plugin module owns Doctor repair of account-scoped SQLite databases.
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawStateDatabaseSchemaMigration } from "openclaw/plugin-sdk/doctor-repair-runtime";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { resolveMatrixSqliteStateEnv } from "./sqlite-state.js";

const STATE_DATABASE_FILENAME = "openclaw.sqlite";

async function collectMatrixAccountStateRoots(stateDir: string): Promise<string[]> {
  const accountsRoot = path.join(stateDir, "matrix", "accounts");
  const roots = new Set<string>();

  async function visit(dir: string, allowMissing = false): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (
        allowMissing &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (
        entry.isFile() &&
        entry.name === STATE_DATABASE_FILENAME &&
        path.basename(dir) === "state"
      ) {
        roots.add(path.dirname(dir));
      } else if (entry.isDirectory()) {
        await visit(entryPath);
      }
    }
  }

  await visit(accountsRoot, true);
  return [...roots].toSorted();
}

function describeMatrixAccountStateMigration(
  storageRootDir: string,
  migration: OpenClawStateDatabaseSchemaMigration,
): string {
  return `Matrix account SQLite schema migration (${migration.kind}): ${storageRootDir}`;
}

export const matrixAccountStateSchemaMigration: PluginDoctorStateMigration = {
  id: "matrix-account-sqlite-schema",
  label: "Matrix account SQLite schemas",
  async detectLegacyState(params) {
    const { detectOpenClawStateDatabaseSchemaMigrations } =
      await import("openclaw/plugin-sdk/doctor-repair-runtime");
    const preview: string[] = [];
    for (const storageRootDir of await collectMatrixAccountStateRoots(params.stateDir)) {
      const env = resolveMatrixSqliteStateEnv({ env: params.env, stateDir: storageRootDir });
      preview.push(
        ...detectOpenClawStateDatabaseSchemaMigrations({ env }).map((migration) =>
          describeMatrixAccountStateMigration(storageRootDir, migration),
        ),
      );
    }
    return preview.length > 0 ? { preview } : null;
  },
  async migrateLegacyState(params) {
    const { detectOpenClawStateDatabaseSchemaMigrations, repairOpenClawStateDatabaseSchema } =
      await import("openclaw/plugin-sdk/doctor-repair-runtime");
    const changes: string[] = [];
    const warnings: string[] = [];
    for (const storageRootDir of await collectMatrixAccountStateRoots(params.stateDir)) {
      const env = resolveMatrixSqliteStateEnv({ env: params.env, stateDir: storageRootDir });
      if (detectOpenClawStateDatabaseSchemaMigrations({ env }).length === 0) {
        continue;
      }
      const repaired = repairOpenClawStateDatabaseSchema({ env });
      changes.push(
        ...repaired.changes.map((change) => `Matrix account SQLite ${storageRootDir}: ${change}`),
      );
      warnings.push(
        ...repaired.warnings.map(
          (warning) => `Matrix account SQLite ${storageRootDir}: ${warning}`,
        ),
      );
    }
    return { changes, warnings };
  },
};
