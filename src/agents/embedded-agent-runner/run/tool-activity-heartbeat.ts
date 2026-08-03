import {
  clearToolActivityRun,
  getLastToolActivityMs,
  notifyToolActivity,
  onToolActivity,
} from "../../../shared/tool-activity-heartbeat.js";
import { copyAgentToolMetadata } from "../../agent-tool-metadata.js";
import type { AnyAgentTool } from "../../tools/common.js";

export { clearToolActivityRun, getLastToolActivityMs, notifyToolActivity, onToolActivity };

export function wrapEmbeddedAttemptToolWithActivity<T extends AnyAgentTool>(
  tool: T,
  runId: string,
): T {
  const originalExecute = tool.execute;
  const wrappedTool = {
    ...tool,
    execute: (async (...args: Parameters<typeof originalExecute>) => {
      // Long-running tools keep the attempt's idle watchdog alive.
      const interval = setInterval(() => notifyToolActivity(runId), 60_000);
      interval.unref?.();
      try {
        notifyToolActivity(runId);
        return await originalExecute(...args);
      } finally {
        clearInterval(interval);
        notifyToolActivity(runId);
      }
    }) as typeof originalExecute,
  } as T;
  // Tool metadata is identity-keyed, so object spread is insufficient.
  return copyAgentToolMetadata(tool, wrappedTool);
}
