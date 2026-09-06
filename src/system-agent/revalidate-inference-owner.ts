// Rebuilds an exact verified inference owner after a successful live probe.
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import type { AgentHarnessPluginSelection } from "../agents/harness/runtime-plugin-load-plan.js";
import { loadAgentRuntimePluginRegistryHandle } from "../agents/runtime-plugins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { getPluginRegistryForContext } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import {
  createSystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

type RevalidationDeps = SystemAgentVerifiedInferenceDeps & {
  createSystemAgentVerifiedInferenceBinding?: typeof createSystemAgentVerifiedInferenceBinding;
  resolvePluginMetadataSnapshot?: typeof resolvePluginMetadataSnapshot;
};

/** Setup owns fresh package facts without replacing the Gateway's startup generation. */
export function loadSetupInferencePluginGeneration(params: {
  config: OpenClawConfig;
  workspaceDir: string;
  selection: AgentHarnessPluginSelection;
  resolvePluginMetadataSnapshot?: typeof resolvePluginMetadataSnapshot;
}) {
  // Revalidation must select the probed artifacts: switching a built Gateway
  // owner to source files would report drift even when neither tree changed.
  const preferBuiltPluginArtifacts = getPluginRuntimeLoadContext(
    getPluginRegistryForContext() ?? undefined,
  )?.preferBuiltPluginArtifacts;
  // The install lease may have cached absence before writing the package.
  // This post-mutation owner must capture new facts without retiring that lease's cache.
  return withPluginCache(createPluginCache(), () => {
    const generation = {
      config: params.config,
      metadataSnapshot: (params.resolvePluginMetadataSnapshot ?? resolvePluginMetadataSnapshot)({
        config: params.config,
        env: process.env,
        workspaceDir: params.workspaceDir,
        allowCurrent: false,
      }),
    };
    const pluginRegistry = withPluginRuntimeGenerationScope(generation, () =>
      loadAgentRuntimePluginRegistryHandle({
        config: params.config,
        workspaceDir: params.workspaceDir,
        metadataSnapshot: generation.metadataSnapshot,
        preferBuiltPluginArtifacts,
        selections: [params.selection],
      }),
    );
    if (!pluginRegistry) {
      throw new Error(`Could not load the ${params.selection.runtime} runtime plugin.`);
    }
    return { ...generation, pluginRegistry };
  });
}

export async function revalidateSetupInferenceOwner(params: {
  route: SystemAgentConfiguredRoute;
  auth: AgentExecutionAuthBinding;
  deps: RevalidationDeps;
}): Promise<SystemAgentVerifiedInferenceBinding> {
  const configuredHarnessId =
    params.route.runner === "embedded"
      ? params.route.agentHarnessRuntimeOverride?.trim()
      : undefined;
  const successfulHarnessId =
    params.auth.agentHarnessId?.trim() ||
    (configuredHarnessId && configuredHarnessId !== "auto" ? configuredHarnessId : undefined);
  const createBinding = () =>
    (
      params.deps.createSystemAgentVerifiedInferenceBinding ??
      createSystemAgentVerifiedInferenceBinding
    )({
      configuredRoute: params.route,
      executionRoute: params.route,
      auth: params.auth,
      deps: params.deps,
    });
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
    const generation = loadSetupInferencePluginGeneration({
      config: params.route.runConfig,
      workspaceDir,
      selection: {
        provider: params.route.provider,
        modelId: params.route.model,
        runtime: successfulHarnessId,
        agentId: params.route.agentId,
      },
      resolvePluginMetadataSnapshot: params.deps.resolvePluginMetadataSnapshot,
    });
    return await withPluginRuntimeGenerationScope(generation, createBinding);
  }
  return await createBinding();
}
