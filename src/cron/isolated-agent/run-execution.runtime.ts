/** Lazy runtime facade for isolated cron agent execution dependencies. */
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
export {
  resolveEffectiveModelFallbacks,
  resolveSubagentModelFallbacksOverride,
} from "../../agents/agent-scope.js";
export { resolveBootstrapWarningSignaturesSeen } from "../../agents/bootstrap-budget.js";
export { resolveCronAgentLane } from "../../agents/lanes.js";
export { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
export { resolveCandidateThinkingLevel } from "../../agents/thinking-runtime.js";
export { isCliProvider } from "../../agents/model-selection-cli.js";
export { normalizeVerboseLevel } from "../../auto-reply/thinking.shared.js";
export { registerAgentRunContext } from "../../infra/agent-run-registry.js";
export { logWarn } from "../../logger.js";

const cronExecutionCliRuntimeLoader = createLazyImportLoader(
  () => import("./run-execution-cli.runtime.js"),
);

/** Lazily resolves complete CLI bindings so cron continuations preserve reuse metadata. */
export async function getCliSessionBinding(
  ...args: Parameters<typeof import("../../agents/cli-session.js").getCliSessionBinding>
): Promise<ReturnType<typeof import("../../agents/cli-session.js").getCliSessionBinding>> {
  const runtime = await cronExecutionCliRuntimeLoader.load();
  return runtime.getCliSessionBinding(...args);
}

/** Lazily runs the CLI-backed agent path used by isolated cron execution. */
export async function runCliAgent(
  ...args: Parameters<typeof import("../../agents/cli-runner.js").runCliAgent>
): ReturnType<typeof import("../../agents/cli-runner.js").runCliAgent> {
  const runtime = await cronExecutionCliRuntimeLoader.load();
  return runtime.runCliAgent(...args);
}
