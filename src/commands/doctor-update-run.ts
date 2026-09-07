import { note } from "../../packages/terminal-core/src/note.js";
import { staleUpdateRunGuidance } from "../infra/update-run-activity.js";
import { listUpdateRuns } from "../infra/update-run-ledger.js";

/** Doctor reports legacy history without granting startup automatic recovery authority. */
export function noteStaleUpdateRuns(options: { gatewayStartup: boolean }): void {
  if (options.gatewayStartup) {
    return;
  }
  for (const run of listUpdateRuns({ active: true, limit: 100 })) {
    const guidance = staleUpdateRunGuidance(run);
    if (guidance) {
      note(`Update ${run.runId}: ${guidance}`, "Update history");
    }
  }
}
