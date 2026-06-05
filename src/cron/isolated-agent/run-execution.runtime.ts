/** Lazy runtime facade for isolated cron agent execution dependencies. */
export {
  resolveEffectiveModelFallbacks,
  resolveSubagentModelFallbacksOverride,
} from "../../agents/agent-scope.js";
export { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
export { resolveCronAgentLane } from "../../agents/lanes.js";
export { ensureSelectedAgentHarnessPlugin } from "../../agents/harness/runtime-plugin.js";
export { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
export { runWithModelFallback } from "../../agents/model-fallback.js";
export { isCliProvider } from "../../agents/model-selection-cli.js";
export { normalizeVerboseLevel } from "../../auto-reply/thinking.shared.js";
export { resolveSessionTranscriptPath } from "../../config/sessions/paths.js";
export { registerAgentRunContext } from "../../infra/agent-events.js";
export { logWarn } from "../../logger.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";

const cronExecutionCliRuntimeLoader = createLazyImportLoader(
  () => import("./run-execution-cli.runtime.js"),
);

async function loadCronExecutionCliRuntime() {
  return await cronExecutionCliRuntimeLoader.load();
}

/** Lazily resolves CLI session ids without loading the cron CLI runner at module import time. */
export async function getCliSessionId(
  ...args: Parameters<typeof import("../../agents/cli-session.js").getCliSessionId>
): Promise<ReturnType<typeof import("../../agents/cli-session.js").getCliSessionId>> {
  const runtime = await loadCronExecutionCliRuntime();
  return runtime.getCliSessionId(...args);
}

/** Lazily runs the CLI-backed agent path used by isolated cron execution. */
export async function runCliAgent(
  ...args: Parameters<typeof import("../../agents/cli-runner.js").runCliAgent>
): ReturnType<typeof import("../../agents/cli-runner.js").runCliAgent> {
  const runtime = await loadCronExecutionCliRuntime();
  return runtime.runCliAgent(...args);
}
