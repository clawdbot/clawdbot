import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../../cli/command-format.js";
import { listOpenClawRegisteredAgentDatabases } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPath,
  isOpenClawAgentDatabaseOpen,
  withOpenClawAgentDatabaseAsync,
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

export function assertSessionStoreMigrationComplete(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  targets?: readonly { storePath: string }[];
}): void {
  const env = params.env ?? process.env;
  const targets = params.targets ?? resolveAllAgentSessionStoreTargetsSync(params.cfg, { env });
  const legacyStore = [
    path.join(resolveStateDir(env), "sessions", "sessions.json"),
    ...targets.map((target) => target.storePath),
  ].find((storePath) => !storePath.endsWith(".sqlite") && fs.existsSync(storePath));
  if (legacyStore) {
    throw new Error(
      `Legacy session store requires migration: ${legacyStore}. Run "${formatCliCommand("openclaw doctor --fix", env)}" against the same state/config before starting OpenClaw.`,
    );
  }
}

/** Maintains existing stores, optionally handing each live database to its runtime owner. */
export async function runSessionStartupMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: SessionStartupMigrationLogger;
  handoffDatabase?: (database: OpenClawAgentDatabaseOptions) => Promise<void>;
  deps?: {
    migrateLegacyMainSessionKeys?: typeof migrateLegacyMainSessionKeys;
    migrateManagedWorktreeCanonicalWorkspaces?: typeof migrateManagedWorktreeCanonicalWorkspaces;
    resolveAllAgentSessionStoreTargetsSync?: typeof resolveAllAgentSessionStoreTargetsSync;
  };
}): Promise<void> {
  const env = params.env ?? process.env;
  const resolveTargets =
    params.deps?.resolveAllAgentSessionStoreTargetsSync ?? resolveAllAgentSessionStoreTargetsSync;
  let targets = resolveTargets(params.cfg, { env });
  // Stable installations may still have file-backed history. Only Doctor imports it;
  // do not serve an empty SQLite history or rewrite those files during startup.
  assertSessionStoreMigrationComplete({ cfg: params.cfg, env, targets });
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

  const databases = new Set<string>();
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
    databases.add(databasePath);
    const alreadyOpen = isOpenClawAgentDatabaseOpen(databasePath);
    let handedOff = false;
    try {
      try {
        const mainKey = params.cfg.session?.mainKey;
        if (
          !registeredDatabases.has(`${options.agentId}\0${databasePath}`) ||
          !isCanonicalSqliteSessionMainKeyCurrent(options, mainKey)
        ) {
          await withOpenClawAgentDatabaseAsync(options, (database) =>
            setCanonicalSqliteSessionMainKey(database, mainKey),
          );
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
      }
      if (params.handoffDatabase) {
        // Runtime readiness failures must propagate; only successful handoff
        // transfers the cold connection beyond this maintenance operation.
        await params.handoffDatabase(options);
        handedOff = true;
      }
    } finally {
      if (!alreadyOpen && !handedOff && isOpenClawAgentDatabaseOpen(databasePath)) {
        closeOpenClawAgentDatabaseByPath(databasePath);
      }
    }
  }
  if (migratedWorktreeSessions > 0) {
    params.log.info(
      `session: recorded canonical workspaces for ${migratedWorktreeSessions} managed-worktree session(s)`,
    );
  }
}
