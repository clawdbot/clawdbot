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
export { resolveCandidateThinkingLevel } from "../../agents/thinking-runtime.js";
export {
  classifyEmbeddedAgentRunResultForModelFallback,
  mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
} from "../../agents/embedded-agent-runner/result-fallback-classifier.js";
export { isCliProvider } from "../../agents/model-selection-cli.js";
export { normalizeVerboseLevel } from "../../auto-reply/thinking.shared.js";
export { registerAgentRunContext } from "../../infra/agent-events.js";
export { logWarn } from "../../logger.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";

const cronExecutionCliRuntimeLoader = createLazyImportLoader(
  () => import("./run-execution-cli.runtime.js"),
);

async function loadCronExecutionCliRuntime() {
  return await cronExecutionCliRuntimeLoader.load();
}

/** Lazily resolves complete CLI bindings so cron continuations preserve reuse metadata. */
export async function getCliSessionBinding(
  ...args: Parameters<typeof import("../../agents/cli-session.js").getCliSessionBinding>
): Promise<ReturnType<typeof import("../../agents/cli-session.js").getCliSessionBinding>> {
  const runtime = await loadCronExecutionCliRuntime();
  return runtime.getCliSessionBinding(...args);
}

/** Lazily runs the CLI-backed agent path used by isolated cron execution. */
export async function runCliAgent(
  ...args: Parameters<typeof import("../../agents/cli-runner.js").runCliAgent>
): ReturnType<typeof import("../../agents/cli-runner.js").runCliAgent> {
  const runtime = await loadCronExecutionCliRuntime();
  return runtime.runCliAgent(...args);
}
