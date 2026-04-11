import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import {
  resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { enablePluginInConfig } from "./enable.js";
import {
  applyProviderAuthConfigPatch,
  applyDefaultModel,
  pickAuthMethod,
  resolveProviderMatch,
} from "./provider-auth-choice-helpers.js";
import { applyAuthProfileConfig } from "./provider-auth-helpers.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";
import { isRemoteEnvironment, openUrl } from "./setup-browser.js";
import type { ProviderAuthMethod, ProviderAuthOptionBag } from "./types.js";

export type ApplyProviderAuthChoiceParams = {
  authChoice: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  agentDir?: string;
  setDefaultModel: boolean;
  agentId?: string;
  opts?: Partial<ProviderAuthOptionBag>;
};

export type ApplyProviderAuthChoiceResult = {
  config: OpenClawConfig;
  agentModelOverride?: string;
};

export type PluginProviderAuthChoiceOptions = {
  authChoice: string;
  pluginId: string;
  providerId: string;
  methodId?: string;
  label: string;
};

function restoreConfiguredPrimaryModel(
  nextConfig: OpenClawConfig,
  originalConfig: OpenClawConfig,
): OpenClawConfig {
  const originalModel = originalConfig.agents?.defaults?.model;
  const nextAgents = nextConfig.agents;
  const nextDefaults = nextAgents?.defaults;
  if (!nextDefaults) {
    return nextConfig;
  }
  if (originalModel !== undefined) {
    return {
      ...nextConfig,
      agents: {
        ...nextAgents,
        defaults: {
          ...nextDefaults,
          model: originalModel,
        },
      },
    };
  }
  const { model: _model, ...restDefaults } = nextDefaults;
  return {
    ...nextConfig,
    agents: {
      ...nextAgents,
      defaults: restDefaults,
    },
  };
}

type ProviderAuthChoiceRuntime = typeof import("./provider-auth-choice.runtime.js");

const defaultProviderAuthChoiceDeps = {
  loadPluginProviderRuntime: async (): Promise<ProviderAuthChoiceRuntime> =>
    import("./provider-auth-choice.runtime.js"),
};

let providerAuthChoiceDeps = defaultProviderAuthChoiceDeps;

async function loadPluginProviderRuntime() {
  return await providerAuthChoiceDeps.loadPluginProviderRuntime();
}

export const __testing = {
  resetDepsForTest(): void {
    providerAuthChoiceDeps = defaultProviderAuthChoiceDeps;
  },
  setDepsForTest(deps: Partial<typeof defaultProviderAuthChoiceDeps>): void {
    providerAuthChoiceDeps = {
      ...defaultProviderAuthChoiceDeps,
      ...deps,
    };
  },
} as const;

export async function runProviderPluginAuthMethod(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  method: ProviderAuthMethod;
  agentDir?: string;
  agentId?: string;
  workspaceDir?: string;
  emitNotes?: boolean;
  secretInputMode?: ProviderAuthOptionBag["secretInputMode"];
  allowSecretRefPrompt?: boolean;
  opts?: Partial<ProviderAuthOptionBag>;
}): Promise<{ config: OpenClawConfig; defaultModel?: string }> {
  const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
  const defaultAgentId = resolveDefaultAgentId(params.config);
  const agentDir =
    params.agentDir ??
    (agentId === defaultAgentId
      ? resolveOpenClawAgentDir()
      : resolveAgentDir(params.config, agentId));
  const workspaceDir =
    params.workspaceDir ??
    resolveAgentWorkspaceDir(params.config, agentId) ??
    resolveDefaultAgentWorkspaceDir();

  const result = await params.method.run({
    config: params.config,
    env: params.env,
    agentDir,
    workspaceDir,
    prompter: params.prompter,
    runtime: params.runtime,
    opts: params.opts,
    secretInputMode: params.secretInputMode,
    allowSecretRefPrompt: params.allowSecretRefPrompt,
    isRemote: isRemoteEnvironment(),
    openUrl: async (url) => {
      await openUrl(url);
    },
    oauth: {
      createVpsAwareHandlers: (opts) => createVpsAwareOAuthHandlers(opts),
    },
  });

  let nextConfig = params.config;
  if (result.configPatch) {
    nextConfig = applyProviderAuthConfigPatch(nextConfig, result.configPatch);
  }

  for (const profile of result.profiles) {
    upsertAuthProfile({
      profileId: profile.profileId,
      credential: profile.credential,
      agentDir,
    });

    nextConfig = applyAuthProfileConfig(nextConfig, {
      profileId: profile.profileId,
      provider: profile.credential.provider,
      mode: profile.credential.type === "token" ? "token" : profile.credential.type,
      ...("email" in profile.credential && profile.credential.email
        ? { email: profile.credential.email }
        : {}),
      ...("displayName" in profile.credential && profile.credential.displayName
        ? { displayName: profile.credential.displayName }
        : {}),
    });
  }

  if (params.emitNotes !== false && result.notes && result.notes.length > 0) {
    await params.prompter.note(result.notes.join("\n"), "Provider notes");
  }

  return {
    config: nextConfig,
    defaultModel: result.defaultModel,
  };
}

export async function applyAuthChoiceLoadedPluginProvider(
  params: ApplyProviderAuthChoiceParams,
): Promise<ApplyProviderAuthChoiceResult | null> {
  const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
  const workspaceDir =
    resolveAgentWorkspaceDir(params.config, agentId) ?? resolveDefaultAgentWorkspaceDir();
  const { resolvePluginProviders, resolveProviderPluginChoice, runProviderModelSelectedHook } =
    await loadPluginProviderRuntime();
  const providers = resolvePluginProviders({
    config: params.config,
    workspaceDir,
    env: params.env,
    mode: "setup",
  });
  const resolved = resolveProviderPluginChoice({
    providers,
    choice: params.authChoice,
  });
  if (!resolved) {
    return null;
  }

  const applied = await runProviderPluginAuthMethod({
    config: params.config,
    env: params.env,
    runtime: params.runtime,
    prompter: params.prompter,
    method: resolved.method,
    agentDir: params.agentDir,
    agentId: params.agentId,
    workspaceDir,
    secretInputMode: params.opts?.secretInputMode,
    allowSecretRefPrompt: false,
    opts: params.opts,
  });

  let nextConfig = applied.config;
  let agentModelOverride: string | undefined;
  if (applied.defaultModel) {
    if (params.setDefaultModel) {
      nextConfig = applyDefaultModel(nextConfig, applied.defaultModel);
      await runProviderModelSelectedHook({
        config: nextConfig,
        model: applied.defaultModel,
        prompter: params.prompter,
        agentDir: params.agentDir,
        workspaceDir,
      });
      await params.prompter.note(
        `Default model set to ${applied.defaultModel}`,
        "Model configured",
      );
      return { config: nextConfig };
    }
    nextConfig = restoreConfiguredPrimaryModel(nextConfig, params.config);
    agentModelOverride = applied.defaultModel;
  }

  return { config: nextConfig, agentModelOverride };
}

export async function applyAuthChoicePluginProvider(
  params: ApplyProviderAuthChoiceParams,
  options: PluginProviderAuthChoiceOptions,
): Promise<ApplyProviderAuthChoiceResult | null> {
  if (params.authChoice !== options.authChoice) {
    return null;
  }

  const enableResult = enablePluginInConfig(params.config, options.pluginId);
  let nextConfig = enableResult.config;
  if (!enableResult.enabled) {
    await params.prompter.note(
      `${options.label} plugin is disabled (${enableResult.reason ?? "blocked"}).`,
      options.label,
    );
    return { config: nextConfig };
  }

  const agentId = params.agentId ?? resolveDefaultAgentId(nextConfig);
  const defaultAgentId = resolveDefaultAgentId(nextConfig);
  const agentDir =
    params.agentDir ??
    (agentId === defaultAgentId ? resolveOpenClawAgentDir() : resolveAgentDir(nextConfig, agentId));
  const workspaceDir =
    resolveAgentWorkspaceDir(nextConfig, agentId) ?? resolveDefaultAgentWorkspaceDir();

  const { resolvePluginProviders, runProviderModelSelectedHook } =
    await loadPluginProviderRuntime();
  const providers = resolvePluginProviders({
    config: nextConfig,
    workspaceDir,
    env: params.env,
    mode: "setup",
  });
  const provider = resolveProviderMatch(providers, options.providerId);
  if (!provider) {
    await params.prompter.note(
      `${options.label} auth plugin is not available. Enable it and re-run onboarding.`,
      options.label,
    );
    return { config: nextConfig };
  }

  const method = pickAuthMethod(provider, options.methodId) ?? provider.auth[0];
  if (!method) {
    await params.prompter.note(`${options.label} auth method missing.`, options.label);
    return { config: nextConfig };
  }

  const applied = await runProviderPluginAuthMethod({
    config: nextConfig,
    env: params.env,
    runtime: params.runtime,
    prompter: params.prompter,
    method,
    agentDir,
    agentId,
    workspaceDir,
    secretInputMode: params.opts?.secretInputMode,
    allowSecretRefPrompt: false,
    opts: params.opts,
  });

  nextConfig = applied.config;
  if (applied.defaultModel) {
    if (params.setDefaultModel) {
      nextConfig = applyDefaultModel(nextConfig, applied.defaultModel);
      await runProviderModelSelectedHook({
        config: nextConfig,
        model: applied.defaultModel,
        prompter: params.prompter,
        agentDir,
        workspaceDir,
      });
      await params.prompter.note(
        `Default model set to ${applied.defaultModel}`,
        "Model configured",
      );
      return { config: nextConfig };
    }
    if (params.agentId) {
      await params.prompter.note(
        `Default model set to ${applied.defaultModel} for agent "${params.agentId}".`,
        "Model configured",
      );
    }
    nextConfig = restoreConfiguredPrimaryModel(nextConfig, params.config);
    return { config: nextConfig, agentModelOverride: applied.defaultModel };
  }

  return { config: nextConfig };
}
