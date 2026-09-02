import {
  clearToolActivityRun,
  getLastToolActivityMs,
  notifyToolActivity,
  onToolActivity,
} from "../../../shared/tool-activity-heartbeat.js";
import { copyAgentToolMetadata } from "../../agent-tool-metadata.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "../../runtime/internal-hooks.js";
import type { AnyAgentTool } from "../../tools/common.js";

export { clearToolActivityRun, getLastToolActivityMs, notifyToolActivity, onToolActivity };

export function wrapEmbeddedAttemptToolWithActivity<T extends AnyAgentTool>(
  tool: T,
  runId: string,
): T {
  const withActivity = async <R>(operation: () => Promise<R>): Promise<R> => {
    const interval = setInterval(() => notifyToolActivity(runId), 60_000);
    interval.unref?.();
    try {
      notifyToolActivity(runId);
      return await operation();
    } finally {
      clearInterval(interval);
      notifyToolActivity(runId);
    }
  };
  const originalExecute = tool.execute;
  const wrappedTool = {
    ...tool,
    execute: ((...args: Parameters<typeof originalExecute>) =>
      withActivity(() => originalExecute(...args))) as typeof originalExecute,
  } as T;
  // Tool metadata is identity-keyed, so object spread is insufficient.
  copyAgentToolMetadata(tool, wrappedTool);
  const sourcePreparer = getInternalToolExecutionPreparer(tool);
  if (sourcePreparer) {
    attachInternalToolExecutionPreparer(wrappedTool, async (params) => {
      const prepared = await withActivity(() => sourcePreparer(params));
      return prepared.kind === "ready"
        ? {
            ...prepared,
            execute: (start) => withActivity(() => prepared.execute(start)),
          }
        : prepared;
    });
  }
  return wrappedTool;
}
