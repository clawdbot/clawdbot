import { resolveAgentSessionDirs } from "../../agents/session-dirs.js";
import { migrateOrphanedSessionKeys } from "../../infra/state-migrations.session-store.js";
import type { PreparedLegacySessionSurfaces } from "../../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawAgentDatabaseByPath,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveStateDir } from "../paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { setCanonicalSqliteSessionMainKey } from "./session-canonical-key.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { sweepOrphanSessionStoreTemps } from "./store-temp-cleanup.js";
import { resolveAllAgentSessionStoreTargetsSync } from "./targets.js";

export type SessionStartupMigrationLogger = Record<"info" | "warn", (message: string) => void>;

type PrepareLegacySessionSurfaces = (params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}) => PreparedLegacySessionSurfaces;

/** Runs best-effort session migration and orphan-temp cleanup before runtime reads. */
export async function runSessionStartupMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: SessionStartupMigrationLogger;
  deps?: {
    migrateOrphanedSessionKeys?: typeof migrateOrphanedSessionKeys;
    prepareLegacySessionSurfaces?: PrepareLegacySessionSurfaces;
    resolveAllAgentSessionStoreTargetsSync?: typeof resolveAllAgentSessionStoreTargetsSync;
    sweepOrphanSessionStoreTemps?: typeof sweepOrphanSessionStoreTemps;
  };
}): Promise<boolean> {
  const env = params.env ?? process.env;
  const migrate = params.deps?.migrateOrphanedSessionKeys ?? migrateOrphanedSessionKeys;
  const resolveTargets =
    params.deps?.resolveAllAgentSessionStoreTargetsSync ?? resolveAllAgentSessionStoreTargetsSync;
  let targets: ReturnType<typeof resolveTargets> | undefined;
  try {
    if (
      !params.cfg.session?.store &&
      (await resolveAgentSessionDirs(resolveStateDir(env))).length === 0
    ) {
      return false;
    }
    targets = resolveTargets(params.cfg, { env });
  } catch (err) {
    params.log.warn(
      `session: stale session store temp cleanup failed during startup; continuing: ${String(err)}`,
    );
  }
  try {
    const prepareSurfaces =
      params.deps?.prepareLegacySessionSurfaces ??
      (await import("../../plugins/legacy-session-surfaces.js")).prepareLegacySessionSurfaces;
    const result = await migrate({
      cfg: params.cfg,
      env,
      legacySessionSurfaces: prepareSurfaces({ config: params.cfg, env }),
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
  if (!targets) {
    return true;
  }

  const sweepTemps = params.deps?.sweepOrphanSessionStoreTemps ?? sweepOrphanSessionStoreTemps;
  try {
    let removedFiles = 0;
    for (const target of targets) {
      const path = resolveSqliteTargetFromSessionStorePath(target.storePath, {
        agentId: target.agentId,
        env: params.env,
      }).path;
      const alreadyOpen = isOpenClawAgentDatabaseOpen(path);
      const database = openOpenClawAgentDatabase({ agentId: target.agentId, path });
      setCanonicalSqliteSessionMainKey(database, params.cfg.session?.mainKey);
      if (!alreadyOpen) {
        closeOpenClawAgentDatabaseByPath(path);
      }
      removedFiles += await sweepTemps({ storePath: target.storePath });
    }
    if (removedFiles > 0) {
      params.log.info(`session: removed ${removedFiles} stale session store temp file(s)`);
    }
  } catch (err) {
    params.log.warn(
      `session: stale session store temp cleanup failed during startup; continuing: ${String(err)}`,
    );
  }
  return true;
}
