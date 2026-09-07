import { note } from "../../packages/terminal-core/src/note.js";
import { staleUpdateRunGuidance } from "../infra/update-run-activity.js";
import { listUpdateRuns } from "../infra/update-run-ledger.js";

/** Startup and proven-pristine preflights do not need a public ledger snapshot. */
export function noteStaleUpdateRuns(options: {
  requireStartupMigrationCheckpoint?: boolean;
  skipPristineStartupStateMigrations?: boolean;
}): void {
  if (options.requireStartupMigrationCheckpoint || options.skipPristineStartupStateMigrations) {
    return;
  }
  for (const run of listUpdateRuns({ active: true, limit: 100 })) {
    const guidance = staleUpdateRunGuidance(run);
    if (guidance) {
      note(`Update ${run.runId}: ${guidance}`, "Update history");
    }
  }
}
