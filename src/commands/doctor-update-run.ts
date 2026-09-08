import { note } from "../../packages/terminal-core/src/note.js";
import { staleUpdateRunGuidance } from "../infra/update-run-activity.js";
import { listUpdateRunsAsync } from "../infra/update-run-reader.js";

/** Startup and proven-pristine preflights do not need a public ledger snapshot. */
export async function noteStaleUpdateRuns(options: {
  requireStartupMigrationCheckpoint?: boolean;
  skipPristineStartupStateMigrations?: boolean;
}): Promise<void> {
  if (options.requireStartupMigrationCheckpoint || options.skipPristineStartupStateMigrations) {
    return;
  }
  for (const run of await listUpdateRunsAsync({ active: true, limit: 100 })) {
    const guidance = staleUpdateRunGuidance(run);
    if (guidance) {
      note(`Update ${run.runId}: ${guidance}`, "Update history");
    }
  }
}
