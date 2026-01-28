import { resolveMoltbotAgentDir } from "../agents/agent-paths.js";
import {
  resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace.js";
import type { MoltbotConfig } from "../config/config.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { resolvePluginProviders } from "../plugins/providers.js";
import type { ProviderAuthMethod, ProviderPlugin } from "../plugins/types.js";
import type { ApplyAuthChoiceParams, ApplyAuthChoiceResult } from "./auth-choice.apply.js";
import { applyAuthProfileConfig } from "./onboard-auth.js";
import { openUrl } from "./onboard-helpers.js";
import { createVpsAwareOAuthHandlers } from "./oauth-flow.js";
import { isRemoteEnvironment } from "./oauth-env.js";

export type PluginProviderAuthChoiceOptions = {
  authChoice: string;
  pluginId: string;
  providerId: string;
  methodId?: string;
  label: string;
};

function resolveProviderMatch(
  providers: ProviderPlugin[],
  rawProvider: string,
): ProviderPlugin | null {
  const normalized = normalizeProviderId(rawProvider);
  return (
    providers.find((provider) => normalizeProviderId(provider.id) === normalized) ??
    providers.find(
      (provider) =>
        provider.aliases?.some((alias) => normalizeProviderId(alias) === normalized) ?? false,
    ) ??
    null
  );
}

function pickAuthMethod(provider: ProviderPlugin, rawMethod?: string): ProviderAuthMethod | null {
  const raw = rawMethod?.trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  return (
    provider.auth.find((method) => method.id.toLowerCase() === normalized) ??
    provider.auth.find((method) => method.label.toLowerCase() === normalized) ??
    null
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeConfigPatch<T>(base: T, patch: unknown): T {
  if (!isPlainRecord(base) || !isPlainRecord(patch)) {
    return patch as T;
  }

  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = next[key];
    if (isPlainRecord(existing) && isPlainRecord(value)) {
      next[key] = mergeConfigPatch(existing, value);
    } else {
      next[key] = value;
    }
  }
  return next as T;
}

function applyDefaultModel(cfg: MoltbotConfig, model: string): MoltbotConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[model] = models[model] ?? {};

  const existingModel = cfg.agents?.defaults?.model;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
        model: {
          ...(existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
            ? { fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks }
            : undefined),
          primary: model,
        },
      },
    },
  };
}

export async function applyAuthChoicePluginProvider(
  params: ApplyAuthChoiceParams,
  options: PluginProviderAuthChoiceOptions,
): Promise<ApplyAuthChoiceResult | null> {
  if (params.authChoice !== options.authChoice) return null;

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
    (agentId === defaultAgentId ? resolveMoltbotAgentDir() : resolveAgentDir(nextConfig, agentId));
  const workspaceDir =
    resolveAgentWorkspaceDir(nextConfig, agentId) ?? resolveDefaultAgentWorkspaceDir();

  const providers = resolvePluginProviders({ config: nextConfig, workspaceDir });
  const provider = resolveProviderMatch(providers, options.providerId);
  if (!provider) {
    await params.prompter.note(
      `${options.label} auth plugin is not available. Enable it and re-run the wizard.`,
      options.label,
    );
    return { config: nextConfig };
  }

  const method = pickAuthMethod(provider, options.methodId) ?? provider.auth[0];
  if (!method) {
    await params.prompter.note(`${options.label} auth method missing.`, options.label);
    return { config: nextConfig };
  }

  const isRemote = isRemoteEnvironment();
  const result = await method.run({
    config: nextConfig,
    agentDir,
    workspaceDir,
    prompter: params.prompter,
    runtime: params.runtime,
    isRemote,
    openUrl: async (url) => {
      await openUrl(url);
    },
    oauth: {
      createVpsAwareHandlers: (opts) => createVpsAwareOAuthHandlers(opts),
    },
  });

  if (result.configPatch) {
    nextConfig = mergeConfigPatch(nextConfig, result.configPatch);
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
    });
  }

  let agentModelOverride: string | undefined;
  if (result.defaultModel) {
    if (params.setDefaultModel) {
      nextConfig = applyDefaultModel(nextConfig, result.defaultModel);
      await params.prompter.note(`Default model set to ${result.defaultModel}`, "Model configured");
    } else if (params.agentId) {
      agentModelOverride = result.defaultModel;
      await params.prompter.note(
        `Default model set to ${result.defaultModel} for agent "${params.agentId}".`,
        "Model configured",
      );
    }
  }

  if (result.notes && result.notes.length > 0) {
    await params.prompter.note(result.notes.join("\n"), "Provider notes");
  }

  return { config: nextConfig, agentModelOverride };
}
