// Rebuilds an exact verified inference owner after a successful live probe.
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import type { ensureSelectedAgentHarnessPlugin } from "../agents/harness/runtime-plugin.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import {
  createSystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

type RevalidationDeps = SystemAgentVerifiedInferenceDeps & {
  createSystemAgentVerifiedInferenceBinding?: typeof createSystemAgentVerifiedInferenceBinding;
  ensureSelectedAgentHarnessPlugin?: typeof ensureSelectedAgentHarnessPlugin;
};

export async function revalidateSetupInferenceOwner(params: {
  route: SystemAgentConfiguredRoute;
  auth: AgentExecutionAuthBinding;
  deps: RevalidationDeps;
}): Promise<SystemAgentVerifiedInferenceBinding> {
  const configuredHarnessId =
    params.route.runner === "embedded"
      ? params.route.agentHarnessRuntimeOverride.trim()
      : undefined;
  const successfulHarnessId =
    params.auth.agentHarnessId?.trim() ||
    (configuredHarnessId && configuredHarnessId !== "auto" ? configuredHarnessId : undefined);
  if (
    params.route.runner === "embedded" &&
    successfulHarnessId &&
    successfulHarnessId !== "openclaw"
  ) {
    // Another gateway run can replace the process-global plugin registry while
    // setup probes. Reload the staged harness before validating its exact artifact.
    const ensureHarness =
      params.deps.ensureSelectedAgentHarnessPlugin ??
      (await import("../agents/harness/runtime-plugin.js")).ensureSelectedAgentHarnessPlugin;
    await ensureHarness({
      provider: params.route.provider,
      modelId: params.route.model,
      config: params.route.runConfig,
      agentId: params.route.agentId,
      agentHarnessId: successfulHarnessId,
      workspaceDir: resolveAgentWorkspaceDir(
        params.route.runConfig,
        params.route.agentId,
        process.env,
      ),
    });
  }
  const createBinding =
    params.deps.createSystemAgentVerifiedInferenceBinding ??
    createSystemAgentVerifiedInferenceBinding;
  return await createBinding({
    configuredRoute: params.route,
    executionRoute: params.route,
    auth: params.auth,
    deps: params.deps,
  });
}
