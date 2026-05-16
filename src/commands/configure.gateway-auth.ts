import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig, GatewayAuthConfig } from "../config/config.js";
import { isSecretRef, type SecretInput } from "../config/types.secrets.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { promptAuthChoiceGrouped } from "./auth-choice-prompt.js";
import { applyAuthChoice, resolvePreferredProviderForAuthChoice } from "./auth-choice.js";
import {
  applyModelAllowlist,
  applyModelFallbacksFromSelection,
  applyPrimaryModel,
  promptDefaultModel,
  promptModelAllowlist,
} from "./model-picker.js";
import { loadStaticManifestCatalogRowsForList } from "./models/list.manifest-catalog.js";
import { promptCustomApiConfig } from "./onboard-custom.js";
import { randomToken } from "./random-token.js";

type GatewayAuthChoice = "token" | "password" | "trusted-proxy";
type ProviderChoiceModelPrompt = {
  provider?: string;
  allowedKeys?: string[];
  initialSelections?: string[];
  message?: string;
  loadCatalog?: boolean;
};

/** Reject undefined, empty, and common JS string-coercion artifacts for token auth. */
function sanitizeTokenValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") {
    return undefined;
  }
  return trimmed;
}

async function resolveProviderChoiceModelPrompt(params: {
  authChoice: string;
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ProviderChoiceModelPrompt | undefined> {
  const { resolvePluginProviders, resolveProviderPluginChoice } =
    await import("../plugins/provider-auth-choice.runtime.js");
  const providers = resolvePluginProviders({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    mode: "setup",
  });
  const resolved = resolveProviderPluginChoice({
    providers,
    choice: params.authChoice,
  });
  const wizard = resolved?.provider.wizard?.setup;
  if (!wizard) {
    return resolved?.provider.id ? { provider: resolved.provider.id } : undefined;
  }
  return {
    provider: resolved.provider.id,
    ...wizard.modelAllowlist,
    ...(wizard.modelSelection?.promptWhenAuthChoiceProvided === true ? { loadCatalog: true } : {}),
  };
}

function hasConfiguredProviderModels(cfg: OpenClawConfig, provider: string | undefined): boolean {
  if (!provider) {
    return false;
  }
  if ((cfg.models?.providers?.[provider]?.models?.length ?? 0) > 0) {
    return true;
  }
  const providerPrefix = `${provider}/`;
  return Object.keys(cfg.agents?.defaults?.models ?? {}).some((key) =>
    key.trim().startsWith(providerPrefix),
  );
}

function hasStaticManifestCatalogRows(cfg: OpenClawConfig, provider: string | undefined): boolean {
  if (!provider) {
    return false;
  }
  return (
    loadStaticManifestCatalogRowsForList({
      cfg,
      providerFilter: provider,
    }).length > 0
  );
}

function listConfiguredModelProviders(cfg: OpenClawConfig): string[] {
  return Object.entries(cfg.models?.providers ?? {})
    .filter(([, provider]) => (provider.models?.length ?? 0) > 0)
    .map(([provider]) => provider);
}

function resolveSingleConfiguredProvider(cfg: OpenClawConfig): string | undefined {
  const configuredProviders = listConfiguredModelProviders(cfg);
  return configuredProviders.length === 1 ? configuredProviders[0] : undefined;
}

function resolveProviderFromModelRef(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  const slashIndex = trimmed?.indexOf("/") ?? -1;
  return slashIndex > 0 ? trimmed?.slice(0, slashIndex) : undefined;
}

function resolveConfiguredProviderFromAuthChange(params: {
  before: OpenClawConfig;
  after: OpenClawConfig;
  preferredProvider?: string;
}): string | undefined {
  if (hasConfiguredProviderModels(params.after, params.preferredProvider)) {
    return params.preferredProvider;
  }

  const beforeProviders = params.before.models?.providers ?? {};
  const configuredProviders = listConfiguredModelProviders(params.after);
  const changedProviders = configuredProviders.filter((provider) => {
    const beforeCount = beforeProviders[provider]?.models?.length ?? 0;
    const afterCount = params.after.models?.providers?.[provider]?.models?.length ?? 0;
    return afterCount > beforeCount;
  });

  if (changedProviders.length === 1) {
    return changedProviders[0];
  }

  return (
    params.preferredProvider ??
    (configuredProviders.length === 1 ? configuredProviders[0] : undefined)
  );
}

export function buildGatewayAuthConfig(params: {
  existing?: GatewayAuthConfig;
  mode: GatewayAuthChoice;
  token?: SecretInput;
  password?: string;
  trustedProxy?: {
    userHeader: string;
    requiredHeaders?: string[];
    allowUsers?: string[];
  };
}): GatewayAuthConfig | undefined {
  const allowTailscale = params.existing?.allowTailscale;
  const base: GatewayAuthConfig = {};
  if (typeof allowTailscale === "boolean") {
    base.allowTailscale = allowTailscale;
  }

  if (params.mode === "token") {
    if (isSecretRef(params.token)) {
      return { ...base, mode: "token", token: params.token };
    }
    // Keep token mode always valid: treat empty/undefined/"undefined"/"null" as missing and generate a token.
    const token = sanitizeTokenValue(params.token) ?? randomToken();
    return { ...base, mode: "token", token };
  }
  if (params.mode === "password") {
    const password = params.password?.trim();
    return { ...base, mode: "password", ...(password && { password }) };
  }
  if (params.mode === "trusted-proxy") {
    if (!params.trustedProxy) {
      throw new Error(
        `trustedProxy config is required when mode is trusted-proxy. Run ${formatCliCommand("openclaw configure --section gateway")} to configure Gateway auth interactively.`,
      );
    }
    return { ...base, mode: "trusted-proxy", trustedProxy: params.trustedProxy };
  }
  return base;
}

export async function promptAuthConfig(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  let next = cfg;
  let authChoice: string = "skip";
  let preferredProvider: string | undefined;
  while (true) {
    authChoice = await promptAuthChoiceGrouped({
      prompter,
      store: ensureAuthProfileStore(undefined, {
        allowKeychainPrompt: false,
      }),
      includeSkip: true,
      config: next,
    });

    preferredProvider =
      authChoice === "skip"
        ? undefined
        : await resolvePreferredProviderForAuthChoice({
            choice: authChoice,
            config: next,
          });

    if (authChoice === "custom-api-key") {
      const customResult = await promptCustomApiConfig({ prompter, runtime, config: next });
      next = customResult.config;
      break;
    }

    if (authChoice === "skip") {
      const modelSelection = await promptDefaultModel({
        config: next,
        prompter,
        allowKeep: true,
        ignoreAllowlist: true,
        includeProviderPluginSetups: false,
        loadCatalog: true,
        browseCatalogOnDemand: true,
        preferredProvider,
        workspaceDir: resolveDefaultAgentWorkspaceDir(),
        runtime,
      });
      if (modelSelection.config) {
        next = modelSelection.config;
      }
      if (modelSelection.model) {
        next = applyPrimaryModel(next, modelSelection.model);
        preferredProvider = resolveProviderFromModelRef(modelSelection.model) ?? preferredProvider;
      }
      break;
    }

    const beforeAuthConfig = next;
    const applied = await applyAuthChoice({
      authChoice,
      config: next,
      prompter,
      runtime,
      setDefaultModel: true,
      preserveExistingDefaultModel: true,
    });
    next = applied.config;
    preferredProvider = resolveConfiguredProviderFromAuthChange({
      before: beforeAuthConfig,
      after: next,
      preferredProvider,
    });
    if (applied.retrySelection) {
      continue;
    }
    break;
  }

  if (authChoice !== "custom-api-key") {
    const modelPrompt = await resolveProviderChoiceModelPrompt({
      authChoice,
      config: next,
      workspaceDir: resolveDefaultAgentWorkspaceDir(),
      env: process.env,
    });
    const promptProvider =
      modelPrompt?.provider ?? preferredProvider ?? resolveSingleConfiguredProvider(next);
    const allowlistSelection = await promptModelAllowlist({
      config: next,
      prompter,
      workspaceDir: resolveDefaultAgentWorkspaceDir(),
      env: process.env,
      allowedKeys: modelPrompt?.allowedKeys,
      initialSelections: modelPrompt?.initialSelections,
      message: modelPrompt?.message,
      preferredProvider: promptProvider,
      loadCatalog:
        modelPrompt?.loadCatalog ??
        (hasConfiguredProviderModels(next, promptProvider) ||
          hasStaticManifestCatalogRows(next, promptProvider)),
    });
    if (allowlistSelection.models) {
      next = applyModelFallbacksFromSelection(next, allowlistSelection.models, {
        scopeKeys: allowlistSelection.scopeKeys,
      });
      next = applyModelAllowlist(next, allowlistSelection.models, {
        scopeKeys: allowlistSelection.scopeKeys,
      });
    }
  }

  return next;
}
