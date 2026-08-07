/**
 * Process wiring for the compaction-unlock redrive. Lives behind a lazy
 * boundary so the pure selection logic never loads the delivery/registry
 * runtime stack in unit tests.
 */
import { findTaskByRunId } from "../tasks/runtime-internal.js";
import { retrySubagentCompletionDelivery } from "./subagent-completion-delivery.js";
import {
  redriveSuspendedSubagentCompletions,
  type CompactionLockWindow,
} from "./subagent-completion-redrive.js";
import { subagentRuns } from "./subagent-registry-memory.js";

/** Process entry point wired from the compaction teardown. */
export async function redriveSuspendedSubagentCompletionsForRequester(
  requesterSessionKey: string,
  lockWindow?: CompactionLockWindow,
): Promise<{ matched: number; redriven: number }> {
  if (!lockWindow) {
    // No held-lock window means no causal link to compaction: refusing to
    // redrive keeps the selection rule total and the lock-window binding exact.
    return { matched: 0, redriven: 0 };
  }
  return redriveSuspendedSubagentCompletions(
    requesterSessionKey,
    {
      runs: subagentRuns,
      retryDelivery: async (runId) => {
        // The registry exposes run ids (taskRunId ?? runId), but the shared
        // retry path is keyed by the owning TaskRecord.taskId. Resolve first so
        // retrySubagentCompletionDelivery's getTaskById actually finds the task.
        const task = findTaskByRunId(runId);
        if (!task) {
          return { ok: false, reason: `no task found for run id ${runId}` };
        }
        return await retrySubagentCompletionDelivery(task.taskId);
      },
    },
    lockWindow,
  );
}
