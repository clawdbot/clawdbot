import fs from "node:fs";
import { resolveAgentSessionDirs } from "../../agents/session-dirs.js";
import { migrateOrphanedSessionKeys } from "../../infra/state-migrations.session-store.js";
import type { PreparedLegacySessionSurfaces } from "../../plugins/legacy-session-surfaces.types.js";
import { listOpenClawRegisteredAgentDatabases } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabaseByPath,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveStateDir } from "../paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import {
  isCanonicalSqliteSessionMainKeyCurrent,
  setCanonicalSqliteSessionMainKey,
} from "./session-canonical-key.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { sweepOrphanSessionStoreTemps } from "./store-temp-cleanup.js";
import { resolveAllAgentSessionStoreTargetsSync } from "./targets.js";
import { migrateManagedWorktreeCanonicalWorkspaces } from "./worktree-workspace-migration.js";

export type SessionStartupMigrationLogger = Record<"info" | "warn", (message: string) => void>;

type PrepareLegacySessionSurfaces = (params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}) => PreparedLegacySessionSurfaces;

type SessionSqliteDatabaseExists = (params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
}) => boolean;

/** Runs best-effort session migration and orphan-temp cleanup before runtime reads. */
export async function runSessionStartupMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: SessionStartupMigrationLogger;
  deps?: {
    migrateOrphanedSessionKeys?: typeof migrateOrphanedSessionKeys;
    migrateLegacyMainSessionKeys?: typeof migrateLegacyMainSessionKeys;
    prepareLegacySessionSurfaces?: PrepareLegacySessionSurfaces;
    migrateManagedWorktreeCanonicalWorkspaces?: typeof migrateManagedWorktreeCanonicalWorkspaces;
    resolveAllAgentSessionStoreTargetsSync?: typeof resolveAllAgentSessionStoreTargetsSync;
    sessionSqliteDatabaseExists?: SessionSqliteDatabaseExists;
    sweepOrphanSessionStoreTemps?: typeof sweepOrphanSessionStoreTemps;
  };
}): Promise<boolean> {
  const env = params.env ?? process.env;
  const migrate = params.deps?.migrateOrphanedSessionKeys ?? migrateOrphanedSessionKeys;
  const resolveTargets =
    params.deps?.resolveAllAgentSessionStoreTargetsSync ?? resolveAllAgentSessionStoreTargetsSync;
  let targets: ReturnType<typeof resolveTargets> | undefined;
  let hasLegacySessionDirectories = true;
  try {
    if (
      !params.cfg.session?.store &&
      (await resolveAgentSessionDirs(resolveStateDir(env))).length === 0
    ) {
      hasLegacySessionDirectories = false;
    } else {
      targets = resolveTargets(params.cfg, { env });
    }
  } catch (err) {
    params.log.warn(
      `session: stale session store temp cleanup failed during startup; continuing: ${String(err)}`,
    );
  }
  if (hasLegacySessionDirectories) {
    try {
      const prepareSurfaces =
        params.deps?.prepareLegacySessionSurfaces ??
        (await import("../../plugins/legacy-session-surfaces.js")).prepareLegacySessionSurfaces;
      const result = await migrate({
        cfg: params.cfg,
        env,
        legacySessionSurfaces: () =>
          prepareSurfaces({
            config: params.cfg,
            env,
          }),
      });
      if (result.changes.length > 0) {
        params.log.info(
          `session: canonicalized orphaned session keys:\n${result.changes.map((c) => `- ${c}`).join("\n")}`,
        );
      }
      if (result.warnings.length > 0) {
        params.log.warn(
          `session: session key migration warnings:\n${result.warnings.map((w) => `- ${w}`).join("\n")}`,
        );
      }
    } catch (err) {
      params.log.warn(
        `session: orphaned session key migration failed during startup; continuing: ${String(err)}`,
      );
    }
  }
  try {
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
  } catch (err) {
    params.log.warn(
      `session: retired main-agent session migration failed during startup; continuing: ${String(err)}`,
    );
  }
  if (!hasLegacySessionDirectories) {
    return false;
  }
  if (!targets) {
    return true;
  }

  const sweepTemps = params.deps?.sweepOrphanSessionStoreTemps ?? sweepOrphanSessionStoreTemps;
  const databaseExists =
    params.deps?.sessionSqliteDatabaseExists ??
    ((input: Parameters<SessionSqliteDatabaseExists>[0]) =>
      input.path !== undefined && fs.existsSync(input.path));
  try {
    let removedFiles = 0;
    let migratedWorktreeSessions = 0;
    const registeredDatabases = new Set(
      listOpenClawRegisteredAgentDatabases({ env }).map(
        (entry) => `${entry.agentId}\0${entry.path}`,
      ),
    );
    for (const target of targets) {
      const path = resolveSqliteTargetFromSessionStorePath(target.storePath, {
        agentId: target.agentId,
        env: params.env,
      }).path;
      if (
        !databaseExists({
          agentId: target.agentId,
          ...(params.env ? { env: params.env } : {}),
          path,
        })
      ) {
        removedFiles += await sweepTemps({ storePath: target.storePath });
        continue;
      }
      const alreadyOpen = isOpenClawAgentDatabaseOpen(path);
      const isRegistered = registeredDatabases.has(`${target.agentId}\0${path}`);
      if (
        !isRegistered ||
        !isCanonicalSqliteSessionMainKeyCurrent(
          { agentId: target.agentId, env, path },
          params.cfg.session?.mainKey,
        )
      ) {
        const database = openOpenClawAgentDatabase({ agentId: target.agentId, env, path });
        setCanonicalSqliteSessionMainKey(database, params.cfg.session?.mainKey);
      }
      const migrateWorktreeSessions =
        params.deps?.migrateManagedWorktreeCanonicalWorkspaces ??
        migrateManagedWorktreeCanonicalWorkspaces;
      try {
        migratedWorktreeSessions += await migrateWorktreeSessions({
          agentId: target.agentId,
          cfg: params.cfg,
          env,
          storePath: target.storePath,
        });
      } catch (error) {
        params.log.warn(
          `session: managed-worktree workspace migration failed for ${target.agentId}; continuing: ${String(error)}`,
        );
      }
      if (!alreadyOpen && isOpenClawAgentDatabaseOpen(path)) {
        closeOpenClawAgentDatabaseByPath(path);
      }
      removedFiles += await sweepTemps({ storePath: target.storePath });
    }
    if (removedFiles > 0) {
      params.log.info(`session: removed ${removedFiles} stale session store temp file(s)`);
    }
    if (migratedWorktreeSessions > 0) {
      params.log.info(
        `session: recorded canonical workspaces for ${migratedWorktreeSessions} managed-worktree session(s)`,
      );
    }
  } catch (err) {
    params.log.warn(
      `session: stale session store temp cleanup failed during startup; continuing: ${String(err)}`,
    );
  }
  return true;
}
