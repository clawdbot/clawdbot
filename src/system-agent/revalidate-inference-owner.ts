// Rebuilds an exact verified inference owner after a successful live probe.
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import { loadAgentRuntimePluginRegistryHandle } from "../agents/runtime-plugins.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import {
  createSystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

type RevalidationDeps = SystemAgentVerifiedInferenceDeps & {
  createSystemAgentVerifiedInferenceBinding?: typeof createSystemAgentVerifiedInferenceBinding;
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
  let pluginRegistry: PluginRegistry | undefined;
  if (
    params.route.runner === "embedded" &&
    successfulHarnessId &&
    successfulHarnessId !== "openclaw"
  ) {
    const workspaceDir = resolveAgentWorkspaceDir(
      params.route.runConfig,
      params.route.agentId,
      process.env,
    );
    pluginRegistry = loadAgentRuntimePluginRegistryHandle({
      config: params.route.runConfig,
      workspaceDir,
      selections: [
        {
          provider: params.route.provider,
          modelId: params.route.model,
          runtime: successfulHarnessId,
          agentId: params.route.agentId,
        },
      ],
    });
    if (!pluginRegistry) {
      throw new Error(`Could not load the ${successfulHarnessId} runtime plugin.`);
    }
  }
  const createBinding =
    params.deps.createSystemAgentVerifiedInferenceBinding ??
    createSystemAgentVerifiedInferenceBinding;
  return await withPluginRuntimeRegistryScope(pluginRegistry, () =>
    createBinding({
      configuredRoute: params.route,
      executionRoute: params.route,
      auth: params.auth,
      deps: params.deps,
    }),
  );
}
