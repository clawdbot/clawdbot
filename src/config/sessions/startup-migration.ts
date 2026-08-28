import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../../cli/command-format.js";
import { listOpenClawRegisteredAgentDatabases } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPath,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { resolveStateDir } from "../paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  isCanonicalSqliteSessionMainKeyCurrent,
  setCanonicalSqliteSessionMainKey,
} from "./session-canonical-key.js";
import { resolveAllAgentSessionStoreTargetsSync } from "./targets.js";
import { migrateManagedWorktreeCanonicalWorkspaces } from "./worktree-workspace-migration.js";

export type SessionStartupMigrationLogger = Record<"info" | "warn", (message: string) => void>;

/** Maintains existing SQLite stores and returns their physical owners for startup reconciliation. */
export async function runSessionStartupMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: SessionStartupMigrationLogger;
  deps?: {
    migrateLegacyMainSessionKeys?: typeof migrateLegacyMainSessionKeys;
    migrateManagedWorktreeCanonicalWorkspaces?: typeof migrateManagedWorktreeCanonicalWorkspaces;
    resolveAllAgentSessionStoreTargetsSync?: typeof resolveAllAgentSessionStoreTargetsSync;
  };
}): Promise<OpenClawAgentDatabaseOptions[]> {
  const env = params.env ?? process.env;
  const resolveTargets =
    params.deps?.resolveAllAgentSessionStoreTargetsSync ?? resolveAllAgentSessionStoreTargetsSync;
  let targets = resolveTargets(params.cfg, { env });
  // Stable installations may still have file-backed history. Only Doctor imports it;
  // do not serve an empty SQLite history or rewrite those files during startup.
  const legacyStore = [
    path.join(resolveStateDir(env), "sessions", "sessions.json"),
    ...targets.map((target) => target.storePath),
  ].find((storePath) => !storePath.endsWith(".sqlite") && fs.existsSync(storePath));
  if (legacyStore) {
    throw new Error(
      `Legacy session store requires migration: ${legacyStore}. Run "${formatCliCommand("openclaw doctor --fix", env)}" against the same state/config before starting OpenClaw.`,
    );
  }
  const migrateLegacyMain =
    params.deps?.migrateLegacyMainSessionKeys ?? migrateLegacyMainSessionKeys;
  const result = await migrateLegacyMain({ cfg: params.cfg, env, mode: "automatic" });
  if (result.changes.length > 0) {
    params.log.info(
      `session: migrated retired main-agent session keys:\n${result.changes.map((change) => `- ${change}`).join("\n")}`,
    );
  }
  if (result.warnings.length > 0) {
    params.log.warn(
      `session: retired main-agent session migration warnings:\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}`,
    );
  }
  if (result.armed) {
    // A partial move can create the destination before source cleanup succeeds.
    targets = resolveTargets(params.cfg, { env });
  }

  const databases = new Map<string, OpenClawAgentDatabaseOptions>();
  const migrateWorktreeSessions =
    params.deps?.migrateManagedWorktreeCanonicalWorkspaces ??
    migrateManagedWorktreeCanonicalWorkspaces;
  const registeredDatabases = new Set(
    listOpenClawRegisteredAgentDatabases({ env }).map((entry) => `${entry.agentId}\0${entry.path}`),
  );
  let migratedWorktreeSessions = 0;
  for (const target of targets) {
    const options = toDatabaseOptions(resolveSqliteReadScope({ ...target, env }));
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    if (databases.has(databasePath) || !fs.existsSync(databasePath)) {
      continue;
    }
    databases.set(databasePath, options);
    const alreadyOpen = isOpenClawAgentDatabaseOpen(databasePath);
    try {
      if (
        !registeredDatabases.has(`${options.agentId}\0${databasePath}`) ||
        !isCanonicalSqliteSessionMainKeyCurrent(options, params.cfg.session?.mainKey)
      ) {
        const database = openOpenClawAgentDatabase(options);
        setCanonicalSqliteSessionMainKey(database, params.cfg.session?.mainKey);
      }
      // Workspace metadata participates in claim matching. Preserve it during a
      // partial move so the next attempt can finish removing the source claim.
      if (!result.armed || result.complete) {
        migratedWorktreeSessions += await migrateWorktreeSessions({
          ...target,
          cfg: params.cfg,
          env,
        });
      }
    } catch (error) {
      params.log.warn(
        `session: SQLite startup maintenance failed for ${target.agentId}; continuing: ${String(error)}`,
      );
    } finally {
      if (!alreadyOpen && isOpenClawAgentDatabaseOpen(databasePath)) {
        closeOpenClawAgentDatabaseByPath(databasePath);
      }
    }
  }
  if (migratedWorktreeSessions > 0) {
    params.log.info(
      `session: recorded canonical workspaces for ${migratedWorktreeSessions} managed-worktree session(s)`,
    );
  }
  return [...databases.values()];
}
