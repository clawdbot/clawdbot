// First-agent creation for the classic setup wizard.
import type { CreateAgentEntry } from "../agents/agent-create.js";
import { ensureOnboardingAgent, stageOnboardingAgent } from "../commands/onboard-agent.js";
import {
  applyLocalSetupWorkspaceConfig,
  applySkipBootstrapConfig,
} from "../commands/onboard-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { WizardPrompter } from "./prompts.js";

export type SetupWizardAgentStage = {
  config: OpenClawConfig;
  firstAgent?: {
    entry: CreateAgentEntry;
    name: string;
    workspace: string;
  };
};

export async function persistSetupAgentStage(params: {
  baseConfig: OpenClawConfig;
  commit: boolean;
  config: OpenClawConfig;
  stage: SetupWizardAgentStage;
  writeConfig: (
    config: OpenClawConfig,
    options: { allowConfigSizeDrop: false },
  ) => Promise<OpenClawConfig>;
}): Promise<OpenClawConfig> {
  const firstAgent = params.stage.firstAgent;
  if (!firstAgent) {
    return await params.writeConfig(params.config, { allowConfigSizeDrop: false });
  }
  const defaults = { ...params.config.agents?.defaults };
  if (!params.commit) {
    const baseWorkspace = params.baseConfig.agents?.defaults?.workspace;
    if (baseWorkspace === undefined) {
      delete defaults.workspace;
    } else {
      defaults.workspace = baseWorkspace;
    }
  }
  const persisted = await params.writeConfig(
    {
      ...params.config,
      agents: { ...params.config.agents, defaults, list: params.baseConfig.agents?.list ?? [] },
    },
    { allowConfigSizeDrop: false },
  );
  if (!params.commit) {
    return {
      ...persisted,
      agents: { ...persisted.agents, ...params.config.agents, list: params.config.agents?.list },
    };
  }
  const entry = params.config.agents?.list?.[0] ?? firstAgent.entry;
  return (
    await ensureOnboardingAgent({
      config: persisted,
      entry,
      name: firstAgent.name,
      workspace: firstAgent.workspace,
    })
  ).config;
}

export async function stageSetupWizardAgent(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  workspaceDir: string;
  requestedWorkspaceDir: string;
  allowWorkspaceChange: boolean;
  skipBootstrap?: boolean;
}): Promise<SetupWizardAgentStage> {
  let nextConfig = applyLocalSetupWorkspaceConfig(params.config, params.requestedWorkspaceDir, {
    allowWorkspaceChange: params.allowWorkspaceChange,
  });
  if (params.skipBootstrap) {
    nextConfig = applySkipBootstrapConfig(nextConfig);
  }
  if ((nextConfig.agents?.list?.length ?? 0) > 0) {
    return { config: nextConfig };
  }

  const agentName = await params.prompter.text({
    message: "What should we call your first agent?",
    initialValue: "main",
    validate: (value) => (value?.trim() ? undefined : "Agent name is required"),
  });
  const name = agentName.trim() || "main";
  const staged = stageOnboardingAgent({
    config: nextConfig,
    name,
    workspace: params.workspaceDir,
  });
  const entry = staged.config.agents?.list?.[0];
  if (!entry) {
    throw new Error("First-agent staging did not produce a roster entry.");
  }
  nextConfig = applyLocalSetupWorkspaceConfig(staged.config, params.requestedWorkspaceDir, {
    allowWorkspaceChange: params.allowWorkspaceChange,
  });
  return {
    config: params.skipBootstrap ? applySkipBootstrapConfig(nextConfig) : nextConfig,
    firstAgent: { entry, name, workspace: params.workspaceDir },
  };
}
