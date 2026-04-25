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
import { sanitizeTerminalText } from "../terminal/safe-text.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { enablePluginInConfig } from "./enable.js";
import {
  applyProviderAuthConfigPatch,
  applyDefaultModel,
  pickAuthMethod,
  resolveProviderMatch,
} from "./provider-auth-choice-helpers.js";
import { applyAuthProfileConfig } from "./provider-auth-helpers.js";
import { resolveProviderInstallCatalogEntry } from "./provider-install-catalog.js";
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
  preserveExistingDefaultModel?: boolean;
  agentId?: string;
  opts?: Partial<ProviderAuthOptionBag>;
};

export type ApplyProviderAuthChoiceResult = {
  config: OpenClawConfig;
  agentModelOverride?: string;
  retrySelection?: boolean;
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

function resolveConfiguredDefaultModelPrimary(cfg: OpenClawConfig): string | undefined {
  const model = cfg.agents?.defaults?.model;
  if (typeof model === "string") {
    return model;
  }
  if (model && typeof model === "object" && typeof model.primary === "string") {
    return model.primary;
  }
  return undefined;
}

async function noteDefaultModelResult(params: {
  previousPrimary: string | undefined;
  selectedModel: string;
  preserveExistingDefaultModel: boolean | undefined;
  prompter: WizardPrompter;
}): Promise<void> {
  if (
    params.preserveExistingDefaultModel === true &&
    params.previousPrimary &&
    params.previousPrimary !== params.selectedModel
  ) {
    await params.prompter.note(
      `Kept existing default model ${params.previousPrimary}; ${params.selectedModel} is available.`,
      "Model configured",
    );
    return;
  }

  await params.prompter.note(`Default model set to ${params.selectedModel}`, "Model configured");
}

async function applyDefaultModelFromAuthChoice(params: {
  config: OpenClawConfig;
  selectedModel: string;
  preserveExistingDefaultModel: boolean | undefined;
  prompter: WizardPrompter;
  runSelectedModelHook: (config: OpenClawConfig) => Promise<void>;
}): Promise<OpenClawConfig> {
  const previousPrimary = resolveConfiguredDefaultModelPrimary(params.config);
  const preservesDifferentPrimary =
    params.preserveExistingDefaultModel === true &&
    previousPrimary !== undefined &&
    previousPrimary !== params.selectedModel;
  const nextConfig = applyDefaultModel(params.config, params.selectedModel, {
    preserveExistingPrimary: params.preserveExistingDefaultModel === true,
  });
  if (!preservesDifferentPrimary) {
    await params.runSelectedModelHook(nextConfig);
  }
  await noteDefaultModelResult({
    previousPrimary,
    selectedModel: params.selectedModel,
    preserveExistingDefaultModel: params.preserveExistingDefaultModel,
    prompter: params.prompter,
  });
  return nextConfig;
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
    nextConfig = applyProviderAuthConfigPatch(nextConfig, result.configPatch, {
      replaceDefaultModels: result.replaceDefaultModels,
    });
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
  let nextConfig = params.config;
  let enabledConfig = params.config;
  const { resolvePluginProviders, resolveProviderPluginChoice, runProviderModelSelectedHook } =
    await loadPluginProviderRuntime();
  const installCatalogEntry = resolveProviderInstallCatalogEntry(params.authChoice, {
    config: nextConfig,
    workspaceDir,
    env: params.env,
    includeUntrustedWorkspacePlugins: false,
  });
  if (installCatalogEntry) {
    const enableResult = enablePluginInConfig(nextConfig, installCatalogEntry.pluginId);
    if (!enableResult.enabled) {
      const safeLabel = sanitizeTerminalText(installCatalogEntry.label);
      await params.prompter.note(
        `${safeLabel} plugin is disabled (${enableResult.reason ?? "blocked"}).`,
        safeLabel,
      );
      return { config: nextConfig };
    }
    enabledConfig = enableResult.config;
  }

  let providers = resolvePluginProviders({
    config: enabledConfig,
    workspaceDir,
    env: params.env,
    mode: "setup",
  });
  let resolved = resolveProviderPluginChoice({
    providers,
    choice: params.authChoice,
  });
  if (!resolved && installCatalogEntry) {
    const [{ ensureOnboardingPluginInstalled }, { clearPluginDiscoveryCache }] = await Promise.all([
      import("../commands/onboarding-plugin-install.js"),
      import("./discovery.js"),
    ]);
    const installResult = await ensureOnboardingPluginInstalled({
      cfg: nextConfig,
      entry: {
        pluginId: installCatalogEntry.pluginId,
        label: installCatalogEntry.label,
        install: installCatalogEntry.install,
      },
      prompter: params.prompter,
      runtime: params.runtime,
      workspaceDir,
    });
    if (!installResult.installed) {
      return { config: installResult.cfg, retrySelection: true };
    }
    nextConfig = installResult.cfg;
    clearPluginDiscoveryCache();
    providers = resolvePluginProviders({
      config: nextConfig,
      workspaceDir,
      env: params.env,
      mode: "setup",
    });
    resolved = resolveProviderPluginChoice({
      providers,
      choice: params.authChoice,
    });
  }
  if (!resolved) {
    return nextConfig === params.config ? null : { config: nextConfig, retrySelection: true };
  }
  if (nextConfig === params.config && enabledConfig !== params.config) {
    nextConfig = enabledConfig;
  }

  const applied = await runProviderPluginAuthMethod({
    config: nextConfig,
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

  nextConfig = applied.config;
  let agentModelOverride: string | undefined;
  if (applied.defaultModel) {
    const selectedModel = applied.defaultModel;
    if (params.setDefaultModel) {
      nextConfig = await applyDefaultModelFromAuthChoice({
        config: nextConfig,
        selectedModel,
        preserveExistingDefaultModel: params.preserveExistingDefaultModel,
        prompter: params.prompter,
        runSelectedModelHook: async (config) => {
          await runProviderModelSelectedHook({
            config,
            model: selectedModel,
            prompter: params.prompter,
            agentDir: params.agentDir,
            workspaceDir,
          });
        },
      });
      return { config: nextConfig };
    }
    nextConfig = restoreConfiguredPrimaryModel(nextConfig, params.config);
    agentModelOverride = selectedModel;
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
    const selectedModel = applied.defaultModel;
    if (params.setDefaultModel) {
      nextConfig = await applyDefaultModelFromAuthChoice({
        config: nextConfig,
        selectedModel,
        preserveExistingDefaultModel: params.preserveExistingDefaultModel,
        prompter: params.prompter,
        runSelectedModelHook: async (config) => {
          await runProviderModelSelectedHook({
            config,
            model: selectedModel,
            prompter: params.prompter,
            agentDir,
            workspaceDir,
          });
        },
      });
      return { config: nextConfig };
    }
    if (params.agentId) {
      await params.prompter.note(
        `Default model set to ${selectedModel} for agent "${params.agentId}".`,
        "Model configured",
      );
    }
    nextConfig = restoreConfiguredPrimaryModel(nextConfig, params.config);
    return { config: nextConfig, agentModelOverride: selectedModel };
  }

  return { config: nextConfig };
}
