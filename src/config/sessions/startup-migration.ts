import { migrateOrphanedSessionKeys } from "../../infra/state-migrations.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { sweepOrphanSessionStoreTemps } from "./store-temp-cleanup.js";
import { resolveAllAgentSessionStoreTargetsSync } from "./targets.js";

export type SessionStartupMigrationLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

/**
 * Run session migration and orphan-temp cleanup before runtime store reads.
 *
 * Both passes are idempotent and failure-isolated: startup continues if either
 * fails, but warnings stay visible for operator follow-up.
 */
export async function runSessionStartupMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: SessionStartupMigrationLogger;
  deps?: {
    migrateOrphanedSessionKeys?: typeof migrateOrphanedSessionKeys;
    resolveAllAgentSessionStoreTargetsSync?: typeof resolveAllAgentSessionStoreTargetsSync;
    sweepOrphanSessionStoreTemps?: typeof sweepOrphanSessionStoreTemps;
  };
}): Promise<void> {
  const migrate = params.deps?.migrateOrphanedSessionKeys ?? migrateOrphanedSessionKeys;
  try {
    const result = await migrate({
      cfg: params.cfg,
      env: params.env ?? process.env,
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

  const resolveTargets =
    params.deps?.resolveAllAgentSessionStoreTargetsSync ?? resolveAllAgentSessionStoreTargetsSync;
  const sweepTemps = params.deps?.sweepOrphanSessionStoreTemps ?? sweepOrphanSessionStoreTemps;
  try {
    let removedFiles = 0;
    for (const target of resolveTargets(params.cfg, {
      env: params.env ?? process.env,
    })) {
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
}
