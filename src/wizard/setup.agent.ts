// First-agent creation for the classic setup wizard.
import { ensureOnboardingAgent } from "../commands/onboard-agent.js";
import {
  applyLocalSetupWorkspaceConfig,
  applySkipBootstrapConfig,
} from "../commands/onboard-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "./prompts.js";

export async function ensureSetupWizardAgent(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  workspaceDir: string;
  requestedWorkspaceDir: string;
  allowWorkspaceChange: boolean;
  skipBootstrap?: boolean;
}): Promise<OpenClawConfig> {
  let nextConfig = applyLocalSetupWorkspaceConfig(params.config, params.requestedWorkspaceDir, {
    allowWorkspaceChange: params.allowWorkspaceChange,
  });
  if (params.skipBootstrap) {
    nextConfig = applySkipBootstrapConfig(nextConfig);
  }
  if ((nextConfig.agents?.list?.length ?? 0) > 0) {
    return nextConfig;
  }

  const agentName = await params.prompter.text({
    message: "What should we call your first agent?",
    initialValue: "main",
    validate: (value) => (value?.trim() ? undefined : "Agent name is required"),
  });
  const created = await ensureOnboardingAgent({
    config: nextConfig,
    name: agentName.trim() || "main",
    workspace: params.workspaceDir,
  });
  nextConfig = applyLocalSetupWorkspaceConfig(created.config, params.requestedWorkspaceDir, {
    allowWorkspaceChange: params.allowWorkspaceChange,
  });
  return params.skipBootstrap ? applySkipBootstrapConfig(nextConfig) : nextConfig;
}
