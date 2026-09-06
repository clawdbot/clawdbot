// Configure wizard model/auth selection and gateway auth config helpers.
import { resolveMutableAgentEntry } from "../agents/agent-scope-config.js";
import { resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig, GatewayAuthConfig } from "../config/config.js";
import { isSecretRef, type SecretInput } from "../config/types.secrets.js";
import { isInvalidGatewayToken } from "../gateway/known-weak-gateway-secrets.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { promptAuthChoiceGrouped } from "./auth-choice-prompt.js";
import { applyAuthChoice, resolvePreferredProviderForAuthChoice } from "./auth-choice.js";
import {
  applyModelAllowlist,
  applyModelFallbacksFromSelection,
  promptDefaultModel,
  promptModelAllowlist,
} from "./model-picker.js";
import { loadStaticManifestCatalogRowsForList } from "./models/list.manifest-catalog.js";
import {
  applyAgentModelDefaults,
  applyOnboardingPrimaryModel,
  resolveOnboardingAgentTarget,
} from "./onboard-agent-target.js";
import type { OnboardingAgentTarget } from "./onboard-agent-target.js";
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

function resolveCanonicalOpenAISelectionForLegacyCodexPrimary(
  cfg: OpenClawConfig,
  target: OnboardingAgentTarget,
  selectedModels: readonly string[],
): string | undefined {
  const currentModel =
    resolveMutableAgentEntry(cfg, target.agentId)?.model ?? cfg.agents?.defaults?.model;
  const primary =
    typeof currentModel === "string"
      ? currentModel.trim()
      : currentModel && typeof currentModel === "object" && typeof currentModel.primary === "string"
        ? currentModel.primary.trim()
        : undefined;
  const modelId = primary?.startsWith("codex/") ? primary.slice("codex/".length).trim() : "";
  if (!modelId) {
    return undefined;
  }
  const canonical = `openai/${modelId}`;
  return selectedModels.find((model) => model.trim() === canonical);
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

/** Preserve unrelated auth policy; replace mode-owned credentials and proxy settings. */
export function buildGatewayAuthConfig(params: {
  existing?: GatewayAuthConfig;
  mode: GatewayAuthChoice;
  token?: SecretInput;
  password?: string;
  trustedProxy?: GatewayAuthConfig["trustedProxy"];
}): GatewayAuthConfig | undefined {
  const base: GatewayAuthConfig = { ...params.existing };
  delete base.token;
  delete base.password;
  delete base.trustedProxy;

  if (params.mode === "token") {
    if (isSecretRef(params.token)) {
      return { ...base, mode: "token", token: params.token };
    }
    // Keep token mode always valid: treat empty/undefined/"undefined"/"null" as missing and generate a token.
    const token =
      typeof params.token === "string" && !isInvalidGatewayToken(params.token)
        ? params.token.trim()
        : randomToken();
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

/** Prompt for model provider credentials and explicit default model policy settings. */
export async function promptAuthConfig(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  target: OnboardingAgentTarget = resolveOnboardingAgentTarget(cfg),
): Promise<OpenClawConfig> {
  let next = cfg;
  let authChoice = "skip";
  let preferredProvider: string | undefined;
  while (true) {
    authChoice = await promptAuthChoiceGrouped({
      prompter,
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
      const customResult = await promptCustomApiConfig({
        prompter,
        runtime,
        config: next,
        target,
        setAsPrimary: !resolveAgentEffectiveModelPrimary(next, target.agentId),
      });
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
        agentId: target.agentId,
        agentDir: target.agentDir,
        workspaceDir: target.workspaceDir,
        runtime,
      });
      if (modelSelection.config) {
        next = modelSelection.config;
      }
      if (modelSelection.model) {
        next = applyOnboardingPrimaryModel(next, target, modelSelection.model);
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
      agentId: target.agentId,
      agentDir: target.agentDir,
      setDefaultModel: false,
      preserveExistingDefaultModel: true,
    });
    next = applied.config;
    // Auth recommendations initialize an unset primary; reauth must not replace
    // the target's explicit or inherited model.
    if (
      applied.agentModelOverride &&
      !resolveAgentEffectiveModelPrimary(beforeAuthConfig, target.agentId)
    ) {
      next = applyOnboardingPrimaryModel(next, target, applied.agentModelOverride);
    }
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
      workspaceDir: target.workspaceDir,
      env: process.env,
    });
    const promptProvider =
      modelPrompt?.provider ?? preferredProvider ?? resolveSingleConfiguredProvider(next);
    const hasPromptProviderConfiguredModels = hasConfiguredProviderModels(next, promptProvider);
    const hasPromptProviderStaticManifestRows = hasStaticManifestCatalogRows(next, promptProvider);
    const shouldLoadModelCatalog =
      modelPrompt?.loadCatalog ??
      (hasPromptProviderConfiguredModels || hasPromptProviderStaticManifestRows);
    const useProviderScopedCatalog = Boolean(
      promptProvider &&
      shouldLoadModelCatalog &&
      (modelPrompt?.loadCatalog === true || hasPromptProviderConfiguredModels),
    );
    const allowlistSelection = await promptModelAllowlist({
      config: next,
      prompter,
      agentId: target.agentId,
      agentDir: target.agentDir,
      workspaceDir: target.workspaceDir,
      env: process.env,
      allowedKeys: modelPrompt?.allowedKeys,
      initialSelections: modelPrompt?.initialSelections,
      message: modelPrompt?.message,
      preferredProvider: promptProvider,
      providerScopedCatalog: useProviderScopedCatalog,
      loadCatalog: shouldLoadModelCatalog,
    });
    if (allowlistSelection.models) {
      const selectedModels = allowlistSelection.models;
      const canonicalPrimary = resolveCanonicalOpenAISelectionForLegacyCodexPrimary(
        next,
        target,
        selectedModels,
      );
      if (canonicalPrimary) {
        next = applyOnboardingPrimaryModel(next, target, canonicalPrimary);
      }
      next = applyAgentModelDefaults(next, target, (projected) =>
        applyModelAllowlist(
          applyModelFallbacksFromSelection(projected, selectedModels, {
            scopeKeys: allowlistSelection.scopeKeys,
          }),
          selectedModels,
          { scopeKeys: allowlistSelection.scopeKeys },
        ),
      );
    }
  }

  return next;
}
