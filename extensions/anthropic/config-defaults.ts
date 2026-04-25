import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS } from "./cli-constants.js";

const ANTHROPIC_PROVIDER_API = "anthropic-messages";

function normalizeLowercaseStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeProviderId(provider: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(provider);
  if (normalized === "bedrock" || normalized === "aws-bedrock") {
    return "amazon-bedrock";
  }
  return normalized;
}

function resolveAnthropicDefaultAuthMode(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): "api_key" | "oauth" | null {
  const profiles = config.auth?.profiles ?? {};
  const anthropicProfiles = Object.entries(profiles).filter(
    ([, profile]) =>
      profile?.provider === "anthropic" || profile?.provider === CLAUDE_CLI_BACKEND_ID,
  );

  const order = [
    ...(config.auth?.order?.anthropic ?? []),
    ...((config.auth?.order as Record<string, string[] | undefined> | undefined)?.[
      CLAUDE_CLI_BACKEND_ID
    ] ?? []),
  ];
  for (const profileId of order) {
    const entry = profiles[profileId];
    if (!entry || (entry.provider !== "anthropic" && entry.provider !== CLAUDE_CLI_BACKEND_ID)) {
      continue;
    }
    if (entry.provider === CLAUDE_CLI_BACKEND_ID) {
      return "oauth";
    }
    if (entry.mode === "api_key") {
      return "api_key";
    }
    if (entry.mode === "oauth" || entry.mode === "token") {
      return "oauth";
    }
  }

  const hasApiKey = anthropicProfiles.some(
    ([, profile]) => profile?.provider === "anthropic" && profile?.mode === "api_key",
  );
  const hasOauth = anthropicProfiles.some(
    ([, profile]) =>
      profile?.provider === CLAUDE_CLI_BACKEND_ID ||
      profile?.mode === "oauth" ||
      profile?.mode === "token",
  );
  if (hasApiKey && !hasOauth) {
    return "api_key";
  }
  if (hasOauth && !hasApiKey) {
    return "oauth";
  }

  if (env.ANTHROPIC_OAUTH_TOKEN?.trim()) {
    return "oauth";
  }
  if (env.ANTHROPIC_API_KEY?.trim()) {
    return "api_key";
  }
  return null;
}

function resolveModelPrimaryValue(
  value: string | { primary?: string; fallbacks?: string[] } | undefined,
): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  const primary = value?.primary;
  if (typeof primary !== "string") {
    return undefined;
  }
  const trimmed = primary.trim();
  return trimmed || undefined;
}

function resolveAnthropicPrimaryModelRef(raw?: string): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const aliasKey = normalizeLowercaseStringOrEmpty(trimmed);
  if (aliasKey === "opus") {
    return "anthropic/claude-opus-4-7";
  }
  if (aliasKey === "sonnet") {
    return "anthropic/claude-sonnet-4-6";
  }
  return trimmed;
}

function parseProviderModelRef(
  raw: string,
  defaultProvider: string,
): { provider: string; model: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0) {
    return { provider: defaultProvider, model: trimmed };
  }
  const provider = trimmed.slice(0, slashIndex).trim();
  const model = trimmed.slice(slashIndex + 1).trim();
  if (!provider || !model) {
    return null;
  }
  return {
    provider: normalizeProviderId(provider),
    model,
  };
}

function isAnthropicCacheRetentionTarget(
  parsed: { provider: string; model: string } | null | undefined,
): parsed is { provider: string; model: string } {
  return Boolean(
    parsed &&
    (parsed.provider === "anthropic" ||
      (parsed.provider === "amazon-bedrock" &&
        normalizeLowercaseStringOrEmpty(parsed.model).includes("anthropic.claude"))),
  );
}

function usesClaudeCliModelSelection(config: OpenClawConfig): boolean {
  if (config.agents?.defaults?.embeddedHarness?.runtime === CLAUDE_CLI_BACKEND_ID) {
    return true;
  }
  const primary = resolveModelPrimaryValue(
    config.agents?.defaults?.model as
      | string
      | { primary?: string; fallbacks?: string[] }
      | undefined,
  );
  const parsedPrimary = primary ? parseProviderModelRef(primary, "anthropic") : null;
  if (parsedPrimary?.provider === CLAUDE_CLI_BACKEND_ID) {
    return true;
  }
  return Object.keys(config.agents?.defaults?.models ?? {}).some((key) => {
    const parsed = parseProviderModelRef(key, "anthropic");
    return parsed?.provider === CLAUDE_CLI_BACKEND_ID;
  });
}

function toCanonicalAnthropicModelRef(ref: string): string {
  return ref.startsWith(`${CLAUDE_CLI_BACKEND_ID}/`)
    ? `anthropic/${ref.slice(CLAUDE_CLI_BACKEND_ID.length + 1)}`
    : ref;
}

export function normalizeAnthropicProviderConfig<T extends { api?: string; models?: unknown[] }>(
  providerConfig: T,
): T {
  if (
    providerConfig.api ||
    !Array.isArray(providerConfig.models) ||
    providerConfig.models.length === 0
  ) {
    return providerConfig;
  }
  return { ...providerConfig, api: ANTHROPIC_PROVIDER_API };
}

export function normalizeAnthropicProviderConfigForProvider<
  T extends { api?: string; models?: unknown[] },
>(params: { provider: string; providerConfig: T }): T {
  const provider = normalizeProviderId(params.provider);
  if (provider !== "anthropic" && provider !== CLAUDE_CLI_BACKEND_ID) {
    return params.providerConfig;
  }
  return normalizeAnthropicProviderConfig(params.providerConfig);
}

export function applyAnthropicConfigDefaults(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): OpenClawConfig {
  const defaults = params.config.agents?.defaults;
  if (!defaults) {
    return params.config;
  }

  const authMode = resolveAnthropicDefaultAuthMode(params.config, params.env);
  if (!authMode) {
    return params.config;
  }

  let mutated = false;
  const nextDefaults = { ...defaults };
  const contextPruning = defaults.contextPruning ?? {};
  const heartbeat = defaults.heartbeat ?? {};

  if (defaults.contextPruning?.mode === undefined) {
    nextDefaults.contextPruning = {
      ...contextPruning,
      mode: "cache-ttl",
      ttl: defaults.contextPruning?.ttl ?? "1h",
    };
    mutated = true;
  }

  if (defaults.heartbeat?.every === undefined) {
    nextDefaults.heartbeat = {
      ...heartbeat,
      every: authMode === "oauth" ? "1h" : "30m",
    };
    mutated = true;
  }

  if (authMode === "api_key") {
    const nextModels = defaults.models ? { ...defaults.models } : {};
    let modelsMutated = false;

    for (const [key, entry] of Object.entries(nextModels)) {
      const parsed = parseProviderModelRef(key, "anthropic");
      if (!isAnthropicCacheRetentionTarget(parsed)) {
        continue;
      }
      const current = entry ?? {};
      const paramsValue = (current as { params?: Record<string, unknown> }).params ?? {};
      if (typeof paramsValue.cacheRetention === "string") {
        continue;
      }
      nextModels[key] = {
        ...(current as Record<string, unknown>),
        params: { ...paramsValue, cacheRetention: "short" },
      };
      modelsMutated = true;
    }

    const primary = resolveAnthropicPrimaryModelRef(
      resolveModelPrimaryValue(
        defaults.model as string | { primary?: string; fallbacks?: string[] } | undefined,
      ),
    );
    if (primary) {
      const parsedPrimary = parseProviderModelRef(primary, "anthropic");
      if (parsedPrimary && isAnthropicCacheRetentionTarget(parsedPrimary)) {
        const key = `${parsedPrimary.provider}/${parsedPrimary.model}`;
        const entry = nextModels[key];
        const current = entry ?? {};
        const paramsValue = (current as { params?: Record<string, unknown> }).params ?? {};
        if (typeof paramsValue.cacheRetention !== "string") {
          nextModels[key] = {
            ...(current as Record<string, unknown>),
            params: { ...paramsValue, cacheRetention: "short" },
          };
          modelsMutated = true;
        }
      }
    }

    if (modelsMutated) {
      nextDefaults.models = nextModels;
      mutated = true;
    }
  }

  if (authMode === "oauth" && usesClaudeCliModelSelection(params.config)) {
    const nextModels = defaults.models ? { ...defaults.models } : {};
    let modelsMutated = false;
    for (const rawRef of CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS) {
      const ref = toCanonicalAnthropicModelRef(rawRef);
      if (ref in nextModels) {
        continue;
      }
      nextModels[ref] = {};
      modelsMutated = true;
    }
    if (modelsMutated) {
      nextDefaults.models = nextModels;
      mutated = true;
    }
  }

  if (!mutated) {
    return params.config;
  }

  return {
    ...params.config,
    agents: {
      ...params.config.agents,
      defaults: nextDefaults,
    },
  };
}
