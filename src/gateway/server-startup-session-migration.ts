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
  const databases = await runSessionStartupMigration(params);
  if (databases.length === 0) {
    return;
  }
  const reconcile =
    params.deps?.reconcileSessionTranscriptIndexes ??
    (await import("../config/sessions/session-transcript-reconcile.js"))
      .reconcileSessionTranscriptIndexes;
  let reconciledSessions = 0;
  for (const database of databases) {
    const result = await reconcile(database);
    reconciledSessions += result.reconciledSessions;
  }
  if (reconciledSessions > 0) {
    params.log.info(
      `session: rebuilt ${reconciledSessions} transcript projection(s) before serving history`,
    );
  }
}
