import {
  runSessionStartupMigration,
  type SessionStartupMigrationLogger,
} from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type SessionMigrationDeps = Parameters<typeof runSessionStartupMigration>[0]["deps"] & {
  reconcileSessionTranscriptIndexes?: typeof import("../config/sessions/session-transcript-reconcile.js").reconcileSessionTranscriptIndexes;
};

/** Await SQLite maintenance and projection repair before serving session history. */
export async function runStartupSessionMigration(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: SessionStartupMigrationLogger;
  deps?: SessionMigrationDeps;
}): Promise<void> {
  let reconcile = params.deps?.reconcileSessionTranscriptIndexes;
  let reconciledSessions = 0;
  await runSessionStartupMigration({
    ...params,
    handoffDatabase: async (database) => {
      reconcile ??= (await import("../config/sessions/session-transcript-reconcile.js"))
        .reconcileSessionTranscriptIndexes;
      reconciledSessions += (await reconcile(database)).reconciledSessions;
    },
  });
  if (reconciledSessions > 0) {
    params.log.info(
      `session: rebuilt ${reconciledSessions} transcript projection(s) before serving history`,
    );
  }
}
