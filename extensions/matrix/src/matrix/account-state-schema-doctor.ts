// Matrix plugin module owns Doctor repair of account-scoped SQLite databases.
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawStateDatabaseSchemaMigration } from "openclaw/plugin-sdk/doctor-repair-runtime";
import type { PluginDoctorStateMigration } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { resolveMatrixStateLayoutChildDepth } from "../storage-paths.js";
import { resolveMatrixSqliteStateEnv } from "./sqlite-state.js";

const STATE_DATABASE_FILENAME = "openclaw.sqlite";

async function collectMatrixAccountStateRoots(stateDir: string): Promise<string[]> {
  const matrixRoot = path.join(stateDir, "matrix");
  const roots = new Set<string>();

  async function visit(dir: string, depth: number, allowMissing = false): Promise<void> {
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
      if (entry.isFile() && depth === 5 && entry.name === STATE_DATABASE_FILENAME) {
        roots.add(path.dirname(dir));
        continue;
      }
      if (!entry.isDirectory()) {
        continue;
      }
      const isStorageRoot = depth === 2 || depth === 4;
      if (isStorageRoot && entry.name === "state") {
        await visit(entryPath, 5);
        continue;
      }
      const childDepth = resolveMatrixStateLayoutChildDepth(depth, entry.name);
      if (childDepth !== null) {
        await visit(entryPath, childDepth);
      }
    }
  }

  await visit(matrixRoot, 0, true);
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
    const preview: string[] = [];
    for (const storageRootDir of await collectMatrixAccountStateRoots(params.stateDir)) {
      // Empty-state startup scans must not load the schema repair runtime.
      const { detectOpenClawStateDatabaseSchemaMigrations } =
        await import("openclaw/plugin-sdk/doctor-repair-runtime");
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
    const changes: string[] = [];
    const warnings: string[] = [];
    for (const storageRootDir of await collectMatrixAccountStateRoots(params.stateDir)) {
      const { detectOpenClawStateDatabaseSchemaMigrations, repairOpenClawStateDatabaseSchema } =
        await import("openclaw/plugin-sdk/doctor-repair-runtime");
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
