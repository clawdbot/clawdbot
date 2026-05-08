import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withActivatedPluginIds } from "../../plugins/activation-context.js";
import { resolveAgentHarnessPolicy } from "./selection.js";

export async function ensureSelectedAgentHarnessPlugin(params: {
  provider: string;
  modelId: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  workspaceDir: string;
}): Promise<void> {
  const policy = resolveAgentHarnessPolicy({
    provider: params.provider,
    modelId: params.modelId,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  if (policy.runtime !== "codex") {
    return;
  }

  const { ensurePluginRegistryLoaded } =
    await import("../../plugins/runtime/runtime-registry-loader.js");
  const activatedConfig =
    withActivatedPluginIds({
      config: params.config,
      pluginIds: ["codex"],
    }) ?? params.config;
  ensurePluginRegistryLoaded({
    scope: "all",
    ...(activatedConfig
      ? {
          config: activatedConfig,
          activationSourceConfig: activatedConfig,
        }
      : {}),
    workspaceDir: params.workspaceDir,
    onlyPluginIds: ["codex"],
  });
}
