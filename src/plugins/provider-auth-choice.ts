// Formats provider authentication choices exposed by plugin setup flows.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import {
  resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { formatLiteralProviderPrefixedModelRef } from "../agents/model-ref-shared.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
import { getPluginInstallRecordMapEntry } from "../config/plugin-install-record-map.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { openUrl } from "../infra/browser-open.js";
import { isRemoteEnvironment } from "../infra/remote-env.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import type { RuntimeEnv } from "../runtime.js";
import { t } from "../wizard/i18n/index.js";
import { createPluginCapabilityConsentPrompter } from "../wizard/plugin-capability-consent.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { enablePluginWithCapabilityConsent } from "./enable.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { applyProviderAuthConfigPatch, applyDefaultModel } from "./provider-auth-choice-helpers.js";
import {
  resolveManifestProviderAuthChoice,
  type ProviderAuthChoiceMetadata,
} from "./provider-auth-choices.js";
import { applyAuthProfileConfig } from "./provider-auth-helpers.js";
import { persistProviderAuthProfileBatch } from "./provider-auth-persistence.js";
import {
  loadProviderSetupAuthChoices,
  resolveProviderInstallCatalogEntry,
} from "./provider-install-catalog.js";
import { createVpsAwareOAuthHandlers } from "./provider-oauth-flow.js";
import type {
  ProviderAuthMethod,
  ProviderAuthOptionBag,
  ProviderAuthResult,
  ProviderPlugin,
} from "./types.js";

type ApplyProviderAuthChoiceParams = {
  authChoice: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  agentDir?: string;
  setDefaultModel: boolean;
  preserveExistingDefaultModel?: boolean;
  agentId?: string;
  workspaceDir?: string;
  signal?: AbortSignal;
  isRemote?: boolean;
  beforePersistentEffect?: () => void | Promise<void>;
  opts?: Partial<ProviderAuthOptionBag>;
};

type ApplyProviderAuthChoiceResult = {
  config: OpenClawConfig;
  agentModelOverride?: string;
  retrySelection?: boolean;
};

type PreparedApplyProviderAuthChoiceResult = ApplyProviderAuthChoiceResult & {
  authProfiles: ProviderAuthResult["profiles"];
  persistAuthProfiles: (profiles?: ProviderAuthResult["profiles"]) => Promise<void>;
};

function preparedWithoutAuthProfiles(
  result: ApplyProviderAuthChoiceResult,
): PreparedApplyProviderAuthChoiceResult {
  return {
    ...result,
    authProfiles: [],
    persistAuthProfiles: async () => {},
  };
}

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
  if (!nextAgents?.defaults) {
    return nextConfig;
  }
  const defaults = { ...nextAgents.defaults };
  if (originalModel === undefined) {
    delete defaults.model;
  } else {
    defaults.model = originalModel;
  }
  return {
    ...nextConfig,
    agents: { ...nextAgents, defaults },
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
      t("wizard.model.keptExistingDefault", {
        current: params.previousPrimary,
        selected: selectedModelDisplay,
      }),
      t("wizard.model.configuredTitle"),
    );
    return;
  }

  await params.prompter.note(
    t("wizard.model.defaultSet", { model: selectedModelDisplay }),
    t("wizard.model.configuredTitle"),
  );
}

async function applyDefaultModelFromAuthChoice(params: {
  config: OpenClawConfig;
  entryConfig: OpenClawConfig;
  selectedModel: string;
  selectedModelDisplay?: string;
  preserveExistingDefaultModel: boolean | undefined;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  workspaceDir?: string;
  beforePersistentEffect?: () => void | Promise<void>;
  runSelectedModelHook: (config: OpenClawConfig) => Promise<void>;
}): Promise<OpenClawConfig | null> {
  const previousPrimary = resolveConfiguredDefaultModelPrimary(params.entryConfig);
  const preservesDifferentPrimary =
    params.preserveExistingDefaultModel === true &&
    previousPrimary !== undefined &&
    previousPrimary !== params.selectedModel;
  const defaultModelBaseConfig = params.entryConfig;
  const defaultModelConfig =
    params.preserveExistingDefaultModel === true
      ? restoreConfiguredPrimaryModel(params.config, defaultModelBaseConfig)
      : params.config;
  let nextConfig = applyDefaultModel(defaultModelConfig, params.selectedModel, {
    preserveExistingPrimary: params.preserveExistingDefaultModel === true,
  });
  if (!preservesDifferentPrimary) {
    const runtimePlugins = await import("../commands/runtime-plugin-install.js");
    const installed = await runtimePlugins.ensureModelSelectionRuntimePlugins({
      cfg: nextConfig,
      model: params.selectedModel,
      prompter: params.prompter,
      runtime: params.runtime,
      beforePersistentEffect: params.beforePersistentEffect,
      ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
    });
    if (!installed.ok) {
      await params.prompter.note(installed.message, "Runtime unavailable");
      return null;
    }
    nextConfig = installed.cfg;
    await params.runSelectedModelHook(nextConfig);
    if (installed.codexInstalled) {
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
        installedPluginIds: [runtimePlugins.CODEX_RUNTIME_PLUGIN_ID],
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

async function loadPluginProviderRuntime(): Promise<ProviderAuthChoiceRuntime> {
  return await import("./provider-auth-choice.runtime.js");
}

function withProviderPluginId(provider: ProviderPlugin, pluginId: string): ProviderPlugin {
  return provider.pluginId === pluginId ? provider : { ...provider, pluginId };
}
export async function runProviderPluginAuthMethodUnpersisted(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  runtime: RuntimeEnv;
  signal?: AbortSignal;
  /** Force remote/manual browser presentation for a connected GUI client. */
  isRemote?: boolean;
  prompter: WizardPrompter;
  method: ProviderAuthMethod;
  agentDir: string;
  workspaceDir: string;
  secretInputMode?: ProviderAuthOptionBag["secretInputMode"];
  allowSecretRefPrompt?: boolean;
  opts?: Partial<ProviderAuthOptionBag>;
}): Promise<ProviderAuthResult> {
  const registerPromptSecret = (value: string) => {
    registerSecretValueForRedaction(value);
    registerSecretValueForRedaction(value.trim());
  };
  return await params.method.run({
    config: params.config,
    env: params.env,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    prompter: {
      ...params.prompter,
      text: async (prompt) => {
        const value = await params.prompter.text({
          ...prompt,
          ...(prompt.sensitive
            ? {
                validate: (input: string) => {
                  registerPromptSecret(input);
                  return prompt.validate?.(input);
                },
              }
            : {}),
        });
        // Auth can fail before persistence; register secrets before the plugin resumes.
        if (prompt.sensitive) {
          registerPromptSecret(value);
        }
        return value;
      },
    },
    runtime: params.runtime,
    ...(params.signal ? { signal: params.signal } : {}),
    opts: params.opts,
    secretInputMode: params.secretInputMode,
    allowSecretRefPrompt: params.allowSecretRefPrompt,
    isRemote: params.isRemote ?? isRemoteEnvironment(),
    openUrl: async (url) => {
      if (params.isRemote === true) {
        await params.prompter.openUrl?.(url);
        return;
      }
      await openUrl(url);
    },
    oauth: {
      createVpsAwareHandlers: (opts) => createVpsAwareOAuthHandlers(opts),
    },
  });
}

export function applyProviderPluginAuthMethodResultConfig(params: {
  config: OpenClawConfig;
  result: ProviderAuthResult;
}): OpenClawConfig {
  const { result } = params;
  let nextConfig = params.config;

  if (result.configPatch) {
    nextConfig = applyProviderAuthConfigPatch(nextConfig, result.configPatch, {
      replaceDefaultModels: result.replaceDefaultModels,
    });
  }

  for (const profile of result.profiles) {
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
  return nextConfig;
}

export async function runProviderPluginAuthMethod(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  method: ProviderAuthMethod;
  agentDir?: string;
  agentId?: string;
  workspaceDir?: string;
  signal?: AbortSignal;
  isRemote?: boolean;
  beforePersistentEffect?: () => void | Promise<void>;
  emitNotes?: boolean;
  secretInputMode?: ProviderAuthOptionBag["secretInputMode"];
  allowSecretRefPrompt?: boolean;
  opts?: Partial<ProviderAuthOptionBag>;
}): Promise<{ config: OpenClawConfig; defaultModel?: string }> {
  const prepared = await prepareProviderPluginAuthMethod(params);
  await prepared.persistAuthProfiles();

  return {
    config: prepared.config,
    ...(prepared.defaultModel ? { defaultModel: prepared.defaultModel } : {}),
  };
}

async function prepareProviderPluginAuthMethod(
  params: Parameters<typeof runProviderPluginAuthMethod>[0],
): Promise<{
  config: OpenClawConfig;
  defaultModel?: string;
  authProfiles: ProviderAuthResult["profiles"];
  persistAuthProfiles: (profiles?: ProviderAuthResult["profiles"]) => Promise<void>;
}> {
  const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
  const agentDir = params.agentDir ?? resolveAgentDir(params.config, agentId);
  const workspaceDir =
    params.workspaceDir ??
    resolveAgentWorkspaceDir(params.config, agentId) ??
    resolveDefaultAgentWorkspaceDir();
  const result = await runProviderPluginAuthMethodUnpersisted({
    config: params.config,
    env: params.env,
    runtime: params.runtime,
    prompter: params.prompter,
    method: params.method,
    agentDir,
    workspaceDir,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.isRemote !== undefined ? { isRemote: params.isRemote } : {}),
    secretInputMode: params.secretInputMode,
    allowSecretRefPrompt: params.allowSecretRefPrompt,
    opts: params.opts,
  });

  if (params.emitNotes !== false && result.notes && result.notes.length > 0) {
    await params.prompter.note(result.notes.join("\n"), "Provider notes");
  }

  const nextConfig = applyProviderPluginAuthMethodResultConfig({
    config: params.config,
    result,
  });
  const defaultModel = result.defaultModel
    ? normalizeAgentModelRefForConfig(result.defaultModel)
    : undefined;

  let profilesPersisted = false;
  const persistAuthProfiles = async (profiles = result.profiles) => {
    if (profilesPersisted) {
      return;
    }
    await params.beforePersistentEffect?.();
    await persistProviderAuthProfileBatch({
      profiles,
      config: nextConfig,
      agentDir,
      ...(params.env ? { env: params.env } : {}),
      ...(params.env?.OPENCLAW_STATE_DIR ? { stateDir: params.env.OPENCLAW_STATE_DIR } : {}),
    });
    profilesPersisted = true;
  };

  return {
    config: nextConfig,
    ...(defaultModel ? { defaultModel } : {}),
    authProfiles: result.profiles,
    persistAuthProfiles,
  };
}

export type ProviderAuthChoicePreparation = {
  config: OpenClawConfig;
  installation?: { pluginId: string; record: PluginInstallRecord };
};

export type PreparedProviderAuthChoiceRuntime = ProviderAuthChoicePreparation &
  (
    | {
        status: "ready";
        choice?: ProviderAuthChoiceMetadata;
        provider: ProviderPlugin;
        method: ProviderAuthMethod;
      }
    | { status: "unavailable" | "blocked" | "retry"; message: string }
  );

/** Install and resolve the selected owner before any plugin can request credentials. */
export async function prepareProviderAuthChoiceRuntime(
  params: Omit<ApplyProviderAuthChoiceParams, "setDefaultModel"> & {
    includeWorkspacePlugins?: boolean;
    promptInstall?: boolean;
    onPrepared?: (preparation: ProviderAuthChoicePreparation) => void | Promise<void>;
  },
): Promise<PreparedProviderAuthChoiceRuntime> {
  const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
  const workspaceDir =
    params.workspaceDir ??
    resolveAgentWorkspaceDir(params.config, agentId) ??
    resolveDefaultAgentWorkspaceDir();
  const catalogParams = {
    config: params.config,
    workspaceDir,
    env: params.env,
    includeUntrustedWorkspacePlugins: false,
    includeWorkspacePlugins: params.includeWorkspacePlugins,
  };
  const prefixedProviderId = /^provider-plugin:([^:]+)/.exec(params.authChoice)?.[1]?.trim();
  await loadProviderSetupAuthChoices(catalogParams);
  const installCatalogEntry = resolveProviderInstallCatalogEntry(params.authChoice, catalogParams);
  const { resolvePluginProviders, resolvePluginSetupProvider, resolveProviderPluginChoice } =
    await loadPluginProviderRuntime();
  // Import the reviewed generation while locked; authentication may outlive the lease.
  return await withPluginLifecycleLease(
    { env: params.env, signal: params.signal },
    async (lease) => {
      let nextConfig = params.config;
      let enabledConfig = params.config;
      let installation: ProviderAuthChoicePreparation["installation"];
      const beforePersistentEffect = async () => {
        params.signal?.throwIfAborted();
        lease.assertOwned();
        await params.beforePersistentEffect?.();
        params.signal?.throwIfAborted();
        lease.assertOwned();
      };
      const readChoice = () =>
        resolveManifestProviderAuthChoice(params.authChoice, {
          ...catalogParams,
          config: nextConfig,
        });
      let manifestAuthChoice = readChoice();
      const choicePlugin = manifestAuthChoice
        ? { pluginId: manifestAuthChoice.pluginId, label: manifestAuthChoice.choiceLabel }
        : installCatalogEntry
          ? { pluginId: installCatalogEntry.pluginId, label: installCatalogEntry.label }
          : undefined;
      if (choicePlugin) {
        const enableResult = await enablePluginWithCapabilityConsent(
          nextConfig,
          choicePlugin.pluginId,
          {
            env: params.env,
            workspaceDir,
            onCapabilityConsent:
              params.promptInstall === false
                ? undefined
                : createPluginCapabilityConsentPrompter(params.prompter, beforePersistentEffect),
            beforePersistentEffect,
          },
        );
        if (!enableResult.enabled) {
          const safeLabel = sanitizeTerminalText(choicePlugin.label);
          const message = `${safeLabel} plugin is disabled (${enableResult.reason ?? "blocked"}).`;
          await params.prompter.note(message, safeLabel);
          return { status: "blocked", config: nextConfig, message };
        }
        enabledConfig = enableResult.config;
      }

      const resolveRuntime = (config: OpenClawConfig) => {
        if (!manifestAuthChoice) {
          // Runtime-only wizard choices are a shipped CLI contract, never a catalog authority.
          return installCatalogEntry
            ? null
            : resolveProviderPluginChoice({
                providers: resolvePluginProviders({
                  config,
                  workspaceDir,
                  env: params.env,
                  mode: "setup",
                  includeUntrustedWorkspacePlugins: false,
                  ...(prefixedProviderId ? { providerRefs: [prefixedProviderId] } : {}),
                }),
                choice: params.authChoice,
              });
        }
        const choice = manifestAuthChoice;
        const select = (provider: ProviderPlugin | undefined) => {
          if (
            !provider ||
            provider.id !== choice.providerId ||
            (provider.pluginId && provider.pluginId !== choice.pluginId)
          ) {
            return null;
          }
          const method = provider.auth.find((candidate) => candidate.id === choice.methodId);
          return method
            ? { provider: withProviderPluginId(provider, choice.pluginId), method }
            : null;
        };
        const setup = select(
          resolvePluginSetupProvider({
            provider: choice.providerId,
            config,
            workspaceDir,
            env: params.env,
            pluginIds: [choice.pluginId],
          }),
        );
        if (setup) {
          return setup;
        }
        const providers = resolvePluginProviders({
          config,
          workspaceDir,
          env: params.env,
          mode: "setup",
          onlyPluginIds: [choice.pluginId],
          includeUntrustedWorkspacePlugins: false,
        });
        for (const provider of providers) {
          const resolved = select(provider);
          if (resolved) {
            return resolved;
          }
        }
        return null;
      };
      let resolved = resolveRuntime(enabledConfig);
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
          beforePersistentEffect,
          promptInstall: params.promptInstall,
        });
        nextConfig = installResult.cfg;
        const record = getPluginInstallRecordMapEntry(
          nextConfig.plugins?.installs,
          installResult.pluginId,
        );
        if (installResult.installed && record) {
          installation = { pluginId: installResult.pluginId, record };
        }
        // Record host-owned installation before a cancelled or invalid plugin import can throw.
        await params.onPrepared?.({
          config: nextConfig,
          ...(installation ? { installation } : {}),
        });
        if (!installResult.installed) {
          return {
            status: "retry",
            config: nextConfig,
            message:
              installResult.error ??
              `Provider plugin installation ${installResult.status}. Retry setup or choose another provider.`,
          };
        }
        manifestAuthChoice = readChoice();
        // The release-bound preview is only a hint. Reconcile the installed identity before auth.
        if (
          manifestAuthChoice?.pluginId === installCatalogEntry.pluginId &&
          manifestAuthChoice.providerId === installCatalogEntry.providerId &&
          manifestAuthChoice.methodId === installCatalogEntry.methodId
        ) {
          resolved = resolveRuntime(nextConfig);
        }
      }
      if (!resolved) {
        const message =
          "The installed plugin does not provide the selected authentication method. Update the plugin or choose another provider.";
        if (choicePlugin) {
          await params.prompter.note(message, sanitizeTerminalText(choicePlugin.label));
        }
        return {
          status: choicePlugin ? "retry" : "unavailable",
          message,
          config: nextConfig,
          ...(installation ? { installation } : {}),
        };
      }
      if (nextConfig === params.config && enabledConfig !== params.config) {
        nextConfig = enabledConfig;
      }

      params.signal?.throwIfAborted();
      lease.assertOwned();
      return {
        status: "ready",
        config: nextConfig,
        choice: manifestAuthChoice,
        ...resolved,
        ...(installation ? { installation } : {}),
      };
    },
  );
}

export async function prepareAuthChoiceLoadedPluginProvider(
  params: ApplyProviderAuthChoiceParams,
): Promise<PreparedApplyProviderAuthChoiceResult | null> {
  const entryConfig = params.config;
  const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
  const workspaceDir =
    params.workspaceDir ??
    resolveAgentWorkspaceDir(params.config, agentId) ??
    resolveDefaultAgentWorkspaceDir();
  const prepared = await prepareProviderAuthChoiceRuntime({ ...params, workspaceDir });
  if (prepared.status !== "ready") {
    return prepared.status === "unavailable" && prepared.config === params.config
      ? null
      : preparedWithoutAuthProfiles({
          config: prepared.config,
          ...(prepared.status === "retry" ? { retrySelection: true } : {}),
        });
  }
  let nextConfig = prepared.config;
  const resolved = prepared;
  const { runProviderModelSelectedHook } = await loadPluginProviderRuntime();

  const applied = await prepareProviderPluginAuthMethod({
    config: nextConfig,
    env: params.env,
    runtime: params.runtime,
    prompter: params.prompter,
    method: resolved.method,
    agentDir: params.agentDir,
    agentId: params.agentId,
    workspaceDir,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.isRemote !== undefined ? { isRemote: params.isRemote } : {}),
    ...(params.beforePersistentEffect
      ? { beforePersistentEffect: params.beforePersistentEffect }
      : {}),
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
      const defaultModelConfig = await applyDefaultModelFromAuthChoice({
        config: nextConfig,
        entryConfig,
        selectedModel,
        selectedModelDisplay,
        preserveExistingDefaultModel: params.preserveExistingDefaultModel,
        prompter: params.prompter,
        runtime: params.runtime,
        workspaceDir,
        beforePersistentEffect: params.beforePersistentEffect,
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
      if (!defaultModelConfig) {
        return preparedWithoutAuthProfiles({
          config: entryConfig,
          retrySelection: true,
        });
      }
      nextConfig = defaultModelConfig;
      return {
        config: nextConfig,
        authProfiles: applied.authProfiles,
        persistAuthProfiles: applied.persistAuthProfiles,
      };
    }
    nextConfig = restoreConfiguredPrimaryModel(nextConfig, params.config);
    agentModelOverride = selectedModel;
  }

  return {
    config: nextConfig,
    agentModelOverride,
    authProfiles: applied.authProfiles,
    persistAuthProfiles: applied.persistAuthProfiles,
  };
}

export async function applyAuthChoiceLoadedPluginProvider(
  params: ApplyProviderAuthChoiceParams,
): Promise<ApplyProviderAuthChoiceResult | null> {
  const prepared = await prepareAuthChoiceLoadedPluginProvider(params);
  if (!prepared) {
    return null;
  }
  await prepared.persistAuthProfiles();
  return {
    config: prepared.config,
    ...(prepared.agentModelOverride ? { agentModelOverride: prepared.agentModelOverride } : {}),
    ...(prepared.retrySelection ? { retrySelection: true } : {}),
  };
}
