import type { AgentRunSessionTarget } from "./run-session-target.js";
/**
 * Late-bound steer hooks for the subagent registry.
 *
 * Lets steer/recovery code depend on a small module while the full registry installs concrete mutation hooks.
 */
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type ReplaceSubagentRunAfterSteerParams = {
  previousRunId: string;
  nextRunId: string;
  fallback?: SubagentRunRecord;
  runTimeoutSeconds?: number;
  preserveFrozenResultFallback?: boolean;
  transcriptTarget?: AgentRunSessionTarget;
  /**
   * Optional task override for the replacement run.  Callers that dispatched a
   * new message (steer, descendant wake, orphan resume) should pass the text
   * actually sent so that restart-redispatch reconstructs the correct prompt
   * after a gateway crash.  When omitted, the previous run's `task` is carried
   * over untouched.
   */
  task?: string;
};

type ReplaceSubagentRunAfterSteerFn = (params: ReplaceSubagentRunAfterSteerParams) => boolean;

type FinalizeInterruptedSubagentRunParams = {
  runId: string;
  error: string;
  endedAt?: number;
};

type FinalizeInterruptedSubagentRunFn = (
  params: FinalizeInterruptedSubagentRunParams,
) => Promise<number>;

let replaceSubagentRunAfterSteerImpl: ReplaceSubagentRunAfterSteerFn | null = null;
let finalizeInterruptedSubagentRunImpl: FinalizeInterruptedSubagentRunFn | null = null;

/** Installs registry mutation hooks used by steer/recovery runtime paths. */
export function configureSubagentRegistrySteerRuntime(params: {
  replaceSubagentRunAfterSteer: ReplaceSubagentRunAfterSteerFn;
  finalizeInterruptedSubagentRun?: FinalizeInterruptedSubagentRunFn;
}) {
  replaceSubagentRunAfterSteerImpl = params.replaceSubagentRunAfterSteer;
  finalizeInterruptedSubagentRunImpl = params.finalizeInterruptedSubagentRun ?? null;
}

/** Replaces a previous run id after steering, returning false when no hook is installed. */
export function replaceSubagentRunAfterSteer(params: ReplaceSubagentRunAfterSteerParams) {
  return replaceSubagentRunAfterSteerImpl?.(params) ?? false;
}

/** Finalizes one interrupted run generation through the installed registry hook. */
export async function finalizeInterruptedSubagentRun(params: FinalizeInterruptedSubagentRunParams) {
  return (await finalizeInterruptedSubagentRunImpl?.(params)) ?? 0;
}
