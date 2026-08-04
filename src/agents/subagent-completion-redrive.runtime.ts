/**
 * Process wiring for the compaction-unlock redrive. Lives behind a lazy
 * boundary so the pure selection logic never loads the delivery/registry
 * runtime stack in unit tests.
 */
import { retrySubagentCompletionDelivery } from "./subagent-completion-delivery.js";
import { redriveSuspendedSubagentCompletions } from "./subagent-completion-redrive.js";
import { subagentRuns } from "./subagent-registry-memory.js";

/** Process entry point wired from the compaction teardown. */
export async function redriveSuspendedSubagentCompletionsForRequester(
  requesterSessionKey: string,
): Promise<{ matched: number; redriven: number }> {
  return redriveSuspendedSubagentCompletions(requesterSessionKey, {
    runs: subagentRuns,
    retryDelivery: async (taskId) => retrySubagentCompletionDelivery(taskId),
  });
}
