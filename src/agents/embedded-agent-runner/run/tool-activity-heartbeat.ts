import { copyPluginToolMeta } from "../../../plugins/tools.js";
import {
  clearToolActivityRun,
  getLastToolActivityMs,
  notifyToolActivity,
  onToolActivity,
} from "../../../shared/tool-activity-heartbeat.js";
import { copyBeforeToolCallHookMarker } from "../../agent-tools.before-tool-call.js";
import { copyChannelAgentToolMeta } from "../../channel-tools.js";
import { copyCodeModeControlToolIdentity } from "../../code-mode-control-tools.js";
import { copyToolTerminalPresentation } from "../../tool-terminal-presentation.js";
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
  // Tool metadata lives in identity-keyed WeakMaps, so object spread is insufficient.
  copyPluginToolMeta(tool, wrappedTool);
  copyChannelAgentToolMeta(tool, wrappedTool);
  copyBeforeToolCallHookMarker(tool, wrappedTool);
  copyToolTerminalPresentation(tool, wrappedTool);
  copyCodeModeControlToolIdentity(tool, wrappedTool);
  return wrappedTool;
}
