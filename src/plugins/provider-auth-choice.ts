import {
  resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { formatLiteralProviderPrefixedModelRef } from "../agents/model-ref-shared.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
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
import {
  resolveManifestProviderAuthChoice,
  type ProviderAuthChoiceMetadata,
} from "./provider-auth-choices.js";
import { applyAuthProfileConfig } from "./provider-auth-helpers.js";
import { resolveProviderInstallCatalogEntry } from "./provider-install-catalog.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";
import { isRemoteEnvironment, openUrl } from "./setup-browser.js";
import type { ProviderAuthMethod, ProviderAuthOptionBag, ProviderPlugin } from "./types.js";

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

function formatModelRefForDisplay(modelRef: string, provider: ProviderPlugin): string {
  if (!provider.preserveLiteralProviderPrefix) {
    return modelRef;
  }
  return formatLiteralProviderPrefixedModelRef(provider.id, modelRef);
}

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
  selectedModelDisplay?: string;
  preserveExistingDefaultModel: boolean | undefined;
  prompter: WizardPrompter;
}): Promise<void> {
  const selectedModelDisplay = params.selectedModelDisplay ?? params.selectedModel;
  if (
    params.preserveExistingDefaultModel === true &&
    params.previousPrimary &&
    params.previousPrimary !== params.selectedModel
  ) {
    await params.prompter.note(
      `Kept existing default model ${params.previousPrimary}; ${selectedModelDisplay} is available.`,
      "Model configured",
    );
    return;
  }

  await params.prompter.note(`Default model set to ${selectedModelDisplay}`, "Model configured");
}

async function applyDefaultModelFromAuthChoice(params: {
  config: OpenClawConfig;
  configBeforeProviderAuth?: OpenClawConfig;
  selectedModel: string;
  selectedModelDisplay?: string;
  preserveExistingDefaultModel: boolean | undefined;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
  runSelectedModelHook: (config: OpenClawConfig) => Promise<void>;
}): Promise<OpenClawConfig> {
  const defaultModelBaseConfig = params.configBeforeProviderAuth ?? params.config;
  const previousPrimary = resolveConfiguredDefaultModelPrimary(defaultModelBaseConfig);
  const preservesDifferentPrimary =
    params.preserveExistingDefaultModel === true &&
    previousPrimary !== undefined &&
    previousPrimary !== params.selectedModel;
  const defaultModelConfig =
    params.preserveExistingDefaultModel === true
      ? restoreConfiguredPrimaryModel(params.config, defaultModelBaseConfig)
      : params.config;
  let nextConfig = applyDefaultModel(defaultModelConfig, params.selectedModel, {
    preserveExistingPrimary: params.preserveExistingDefaultModel === true,
  });
  if (!preservesDifferentPrimary) {
    const { CODEX_RUNTIME_PLUGIN_ID, ensureCodexRuntimePluginForModelSelection } =
      await import("../commands/codex-runtime-plugin-install.js");
    const codexInstall = await ensureCodexRuntimePluginForModelSelection({
      cfg: nextConfig,
      model: params.selectedModel,
      prompter: params.prompter,
      runtime: params.runtime,
      ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
    });
    nextConfig = codexInstall.cfg;
    await params.runSelectedModelHook(nextConfig);
    if (codexInstall.installed) {
      // Offer Codex CLI state migration whenever the harness is in place for
      // the selected model, regardless of whether this run was a fresh install
      // or a repair against an already-present harness. The user can always
      // decline the prompt; surfacing it again costs nothing if there is no
      // migratable state to find.
      const { offerPostInstallMigrations } =
        await import("../wizard/setup.post-install-migration.js");
      const migrationResult = await offerPostInstallMigrations({
        config: nextConfig,
        runtime: params.runtime,
        prompter: params.prompter,
        installedPluginIds: [CODEX_RUNTIME_PLUGIN_ID],
      });
      nextConfig = migrationResult.config;
    }
  }
  await noteDefaultModelResult({
    previousPrimary,
    selectedModel: params.selectedModel,
    selectedModelDisplay: params.selectedModelDisplay,
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

function resolveManifestAuthChoiceScope(params: {
  authChoice: string;
  config: OpenClawConfig;
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
}): ProviderAuthChoiceMetadata | undefined {
  return resolveManifestProviderAuthChoice(params.authChoice, {
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeUntrustedWorkspacePlugins: false,
  });
}

function withProviderPluginId(provider: ProviderPlugin, pluginId: string): ProviderPlugin {
  return provider.pluginId === pluginId ? provider : { ...provider, pluginId };
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
  const agentDir = params.agentDir ?? resolveAgentDir(params.config, agentId);
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

  const defaultModel = result.defaultModel
    ? normalizeAgentModelRefForConfig(result.defaultModel)
    : undefined;

  return {
    config: nextConfig,
    ...(defaultModel ? { defaultModel } : {}),
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
  const {
    resolvePluginProviders,
    resolvePluginSetupProvider,
    resolveProviderPluginChoice,
    runProviderModelSelectedHook,
  } = await loadPluginProviderRuntime();
  const manifestAuthChoice = resolveManifestAuthChoiceScope({
    authChoice: params.authChoice,
    config: nextConfig,
    workspaceDir,
    env: params.env,
  });
  const installCatalogEntry = resolveProviderInstallCatalogEntry(params.authChoice, {
    config: nextConfig,
    workspaceDir,
    env: params.env,
    includeUntrustedWorkspacePlugins: false,
  });
  const choicePlugin = manifestAuthChoice
    ? { pluginId: manifestAuthChoice.pluginId, label: manifestAuthChoice.choiceLabel }
    : installCatalogEntry
      ? { pluginId: installCatalogEntry.pluginId, label: installCatalogEntry.label }
      : undefined;
  if (choicePlugin) {
    const enableResult = enablePluginInConfig(nextConfig, choicePlugin.pluginId);
    if (!enableResult.enabled) {
      const safeLabel = sanitizeTerminalText(choicePlugin.label);
      await params.prompter.note(
        `${safeLabel} plugin is disabled (${enableResult.reason ?? "blocked"}).`,
        safeLabel,
      );
      return { config: nextConfig };
    }
    enabledConfig = enableResult.config;
  }

  const resolveScopedRuntimeProviders = (config: OpenClawConfig): ProviderPlugin[] =>
    resolvePluginProviders({
      config,
      workspaceDir,
      env: params.env,
      mode: "setup",
      ...(manifestAuthChoice
        ? {
            onlyPluginIds: [manifestAuthChoice.pluginId],
            providerRefs: [manifestAuthChoice.providerId],
          }
        : {}),
    });

  const setupProvider = manifestAuthChoice
    ? resolvePluginSetupProvider({
        provider: manifestAuthChoice.providerId,
        config: enabledConfig,
        workspaceDir,
        env: params.env,
        pluginIds: [manifestAuthChoice.pluginId],
      })
    : undefined;
  let providers = setupProvider
    ? [withProviderPluginId(setupProvider, manifestAuthChoice!.pluginId)]
    : resolveScopedRuntimeProviders(enabledConfig);
  let resolved = resolveProviderPluginChoice({
    providers,
    choice: params.authChoice,
  });
  if (!resolved && setupProvider) {
    providers = resolveScopedRuntimeProviders(enabledConfig);
    resolved = resolveProviderPluginChoice({
      providers,
      choice: params.authChoice,
    });
  }
  if (!resolved && installCatalogEntry) {
    const { ensureOnboardingPluginInstalled } =
      await import("../commands/onboarding-plugin-install.js");
    const installResult = await ensureOnboardingPluginInstalled({
      cfg: nextConfig,
      entry: {
        pluginId: installCatalogEntry.pluginId,
        label: installCatalogEntry.label,
        install: installCatalogEntry.install,
        ...(installCatalogEntry.origin === "bundled"
          ? { trustedSourceLinkedOfficialInstall: true }
          : {}),
      },
      prompter: params.prompter,
      runtime: params.runtime,
      workspaceDir,
    });
    if (!installResult.installed) {
      return { config: installResult.cfg, retrySelection: true };
    }
    nextConfig = installResult.cfg;
    providers = resolveScopedRuntimeProviders(nextConfig);
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

  const configBeforeProviderAuth = nextConfig;
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
    const selectedModelDisplay = formatModelRefForDisplay(selectedModel, resolved.provider);
    if (params.setDefaultModel) {
      nextConfig = await applyDefaultModelFromAuthChoice({
        config: nextConfig,
        configBeforeProviderAuth,
        selectedModel,
        selectedModelDisplay,
        preserveExistingDefaultModel: params.preserveExistingDefaultModel,
        prompter: params.prompter,
        runtime: params.runtime,
        workspaceDir,
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
  const agentDir = params.agentDir ?? resolveAgentDir(nextConfig, agentId);
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
      `${options.label} auth plugin is not available. Install or enable the plugin, then rerun onboarding. If this started after an update, run "openclaw doctor --fix" first.`,
      options.label,
    );
    return { config: nextConfig };
  }

  const method = pickAuthMethod(provider, options.methodId) ?? provider.auth[0];
  if (!method) {
    await params.prompter.note(`${options.label} auth method missing.`, options.label);
    return { config: nextConfig };
  }

  const configBeforeProviderAuth = nextConfig;
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
    const selectedModelDisplay = formatModelRefForDisplay(selectedModel, provider);
    if (params.setDefaultModel) {
      nextConfig = await applyDefaultModelFromAuthChoice({
        config: nextConfig,
        configBeforeProviderAuth,
        selectedModel,
        selectedModelDisplay,
        preserveExistingDefaultModel: params.preserveExistingDefaultModel,
        prompter: params.prompter,
        runtime: params.runtime,
        workspaceDir,
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
        `Default model set to ${selectedModelDisplay} for agent "${params.agentId}".`,
        "Model configured",
      );
    }
    nextConfig = restoreConfiguredPrimaryModel(nextConfig, params.config);
    return { config: nextConfig, agentModelOverride: selectedModel };
  }

  return { config: nextConfig };
}
