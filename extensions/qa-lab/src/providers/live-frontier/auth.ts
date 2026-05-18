import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyAuthProfileConfig,
  coerceSecretRef,
  isKnownEnvApiKeyMarker,
  isNonSecretApiKeyMarker,
  normalizeOptionalSecretInput,
  readCodexCliCredentialsCached,
  resolveEnvApiKey,
  validateAnthropicSetupToken,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveQaAgentAuthDir, writeQaAuthProfiles } from "../shared/auth-store.js";

export const QA_LIVE_ANTHROPIC_SETUP_TOKEN_ENV = "OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN";
export const QA_LIVE_SETUP_TOKEN_VALUE_ENV = "OPENCLAW_LIVE_SETUP_TOKEN_VALUE";
const QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE_ENV = "OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE";
const QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE_ID = "anthropic:qa-setup-token";
const QA_LIVE_API_KEY_AGENT_IDS = Object.freeze(["main", "qa"] as const);
const QA_OPENAI_PROVIDER_ID = "openai";
const QA_OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const QA_LIVE_API_KEY_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  anthropic: ["OPENCLAW_LIVE_ANTHROPIC_KEY"],
  gemini: ["OPENCLAW_LIVE_GEMINI_KEY"],
  openai: ["OPENCLAW_LIVE_OPENAI_KEY", "OPENAI_API_KEY"],
  "openai-codex": [
    "CODEX_API_KEY",
    "OPENCLAW_LIVE_CODEX_API_KEY",
    "OPENCLAW_LIVE_OPENAI_KEY",
    "OPENAI_API_KEY",
  ],
});

function buildQaLiveApiKeyProfileId(provider: string): string {
  return `qa-live-${provider.replaceAll(/[^a-z0-9_-]/giu, "-")}-env`;
}

function normalizeQaLiveProviderIds(providerIds: readonly string[]) {
  return [...new Set(providerIds.map((providerId) => providerId.trim()))]
    .filter((providerId) => providerId.length > 0)
    .toSorted();
}

function isQaLiveOfficialOpenAiBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return true;
  }
  try {
    const url = new URL(baseUrl.trim());
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "api.openai.com" &&
      (url.pathname === "" ||
        url.pathname === "/" ||
        url.pathname === "/v1" ||
        url.pathname === "/v1/")
    );
  } catch {
    return false;
  }
}

function qaLiveOpenAiUsesCodexByDefault(cfg: OpenClawConfig): boolean {
  return isQaLiveOfficialOpenAiBaseUrl(
    resolveQaLiveProviderConfig({ cfg, providerId: "openai" })?.baseUrl,
  );
}

function expandQaLiveApiKeyProviderIds(params: {
  cfg: OpenClawConfig;
  providerIds: readonly string[];
}) {
  const expanded = new Set(normalizeQaLiveProviderIds(params.providerIds));
  if (
    expanded.has(QA_OPENAI_CODEX_PROVIDER_ID) ||
    (expanded.has(QA_OPENAI_PROVIDER_ID) && qaLiveOpenAiUsesCodexByDefault(params.cfg))
  ) {
    expanded.add(QA_OPENAI_PROVIDER_ID);
    expanded.add(QA_OPENAI_CODEX_PROVIDER_ID);
  }
  return [...expanded].toSorted();
}

function resolveQaLiveEnvApiKey(params: {
  providerId: string;
  env: NodeJS.ProcessEnv;
  cfg: OpenClawConfig;
}) {
  const resolved = resolveEnvApiKey(params.providerId, params.env, { config: params.cfg });
  if (resolved?.apiKey) {
    return resolved;
  }
  for (const aliasEnv of QA_LIVE_API_KEY_ALIASES[params.providerId] ?? []) {
    const aliasValue = params.env[aliasEnv]?.trim();
    if (aliasValue) {
      return { apiKey: aliasValue, source: `env: ${aliasEnv}` };
    }
  }
  return null;
}

function resolveQaLiveConfiguredApiKey(params: {
  providerId: string;
  env: NodeJS.ProcessEnv;
  cfg: OpenClawConfig;
}) {
  const providerConfig = resolveQaLiveProviderConfig(params);
  const apiKey = providerConfig?.apiKey;
  const secretRef = coerceSecretRef(apiKey);
  if (secretRef) {
    const envVarName = secretRef.id.trim();
    const envValue = normalizeOptionalSecretInput(params.env[envVarName]);
    return secretRef.source === "env" && envValue
      ? { apiKey: envValue, source: `env: ${envVarName} (models.json secretref)` }
      : null;
  }
  const normalized = normalizeOptionalSecretInput(apiKey);
  if (!normalized) {
    return null;
  }
  if (
    isKnownEnvApiKeyMarker(normalized) ||
    QA_LIVE_API_KEY_ALIASES[params.providerId]?.includes(normalized)
  ) {
    const envValue = normalizeOptionalSecretInput(params.env[normalized]);
    return envValue
      ? { apiKey: envValue, source: `env: ${normalized} (models.json marker)` }
      : null;
  }
  if (isNonSecretApiKeyMarker(normalized)) {
    return null;
  }
  return { apiKey: normalized, source: "models.json" };
}

function resolveQaLiveApiKey(params: {
  providerId: string;
  env: NodeJS.ProcessEnv;
  cfg: OpenClawConfig;
}) {
  return resolveQaLiveEnvApiKey(params) ?? resolveQaLiveConfiguredApiKey(params);
}

function resolveQaLiveProviderConfig(params: { cfg: OpenClawConfig; providerId: string }) {
  const providers = params.cfg.models?.providers;
  if (!providers) {
    return undefined;
  }
  return (
    providers[params.providerId] ??
    Object.entries(providers).find(([providerId]) => providerId.trim() === params.providerId)?.[1]
  );
}

function hasQaLiveStagedApiKeyProfile(params: { cfg: OpenClawConfig; providerId: string }) {
  return Boolean(params.cfg.auth?.profiles?.[buildQaLiveApiKeyProfileId(params.providerId)]);
}

function qaLiveRequiresCodexAuth(params: {
  cfg: OpenClawConfig;
  providerIds: readonly string[];
  env: NodeJS.ProcessEnv;
}) {
  const providerIds = normalizeQaLiveProviderIds(params.providerIds);
  if (providerIds.includes(QA_OPENAI_CODEX_PROVIDER_ID)) {
    return true;
  }
  if (!providerIds.includes(QA_OPENAI_PROVIDER_ID)) {
    return false;
  }
  const forcedRuntime = params.env.OPENCLAW_QA_FORCE_RUNTIME?.trim().toLowerCase();
  if (forcedRuntime === "pi") {
    return false;
  }
  if (forcedRuntime === "codex") {
    return true;
  }
  return qaLiveOpenAiUsesCodexByDefault(params.cfg);
}

function resolveQaLiveAnthropicSetupToken(env: NodeJS.ProcessEnv = process.env) {
  const token = (
    env[QA_LIVE_ANTHROPIC_SETUP_TOKEN_ENV]?.trim() ||
    env[QA_LIVE_SETUP_TOKEN_VALUE_ENV]?.trim() ||
    ""
  ).replaceAll(/\s+/g, "");
  if (!token) {
    return null;
  }
  const tokenError = validateAnthropicSetupToken(token);
  if (tokenError) {
    throw new Error(`Invalid QA Anthropic setup-token: ${tokenError}`);
  }
  const profileId =
    env[QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE_ENV]?.trim() ||
    QA_LIVE_ANTHROPIC_SETUP_TOKEN_PROFILE_ID;
  return { token, profileId };
}

export async function stageQaLiveAnthropicSetupToken(params: {
  cfg: OpenClawConfig;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<OpenClawConfig> {
  const resolved = resolveQaLiveAnthropicSetupToken(params.env);
  if (!resolved) {
    return params.cfg;
  }
  await writeQaAuthProfiles({
    agentDir: resolveQaAgentAuthDir({ stateDir: params.stateDir, agentId: "main" }),
    profiles: {
      [resolved.profileId]: {
        type: "token",
        provider: "anthropic",
        token: resolved.token,
      },
    },
  });
  return applyAuthProfileConfig(params.cfg, {
    profileId: resolved.profileId,
    provider: "anthropic",
    mode: "token",
    displayName: "QA setup-token",
  });
}

export async function stageQaLiveApiKeyProfiles(params: {
  cfg: OpenClawConfig;
  stateDir: string;
  providerIds: readonly string[];
  env?: NodeJS.ProcessEnv;
  agentIds?: readonly string[];
}): Promise<OpenClawConfig> {
  const env = params.env ?? process.env;
  const providerIds = [...new Set(params.providerIds.map((providerId) => providerId.trim()))]
    .filter((providerId) => providerId.length > 0)
    .toSorted();
  const profiles: Record<
    string,
    {
      type: "api_key";
      provider: string;
      key: string;
      displayName: string;
    }
  > = {};
  let next = params.cfg;
  for (const providerId of expandQaLiveApiKeyProviderIds({ cfg: next, providerIds })) {
    const resolved = resolveQaLiveApiKey({ providerId, env, cfg: next });
    if (!resolved?.apiKey) {
      continue;
    }
    const profileId = buildQaLiveApiKeyProfileId(providerId);
    const displayName = `QA live ${providerId} env credential`;
    profiles[profileId] = {
      type: "api_key",
      provider: providerId,
      key: resolved.apiKey,
      displayName,
    };
    next = applyAuthProfileConfig(next, {
      profileId,
      provider: providerId,
      mode: "api_key",
      displayName,
    });
  }
  if (Object.keys(profiles).length === 0) {
    return next;
  }
  const agentIds = [...new Set(params.agentIds ?? QA_LIVE_API_KEY_AGENT_IDS)];
  await Promise.all(
    agentIds.map((agentId) =>
      writeQaAuthProfiles({
        agentDir: resolveQaAgentAuthDir({ stateDir: params.stateDir, agentId }),
        profiles,
      }),
    ),
  );
  return next;
}

export function assertQaLiveCodexAuthAvailable(params: {
  cfg: OpenClawConfig;
  providerIds: readonly string[];
  env?: NodeJS.ProcessEnv;
  readCodexCredentials?: typeof readCodexCliCredentialsCached;
}): void {
  const env = params.env ?? process.env;
  if (!qaLiveRequiresCodexAuth({ cfg: params.cfg, providerIds: params.providerIds, env })) {
    return;
  }
  if (
    resolveQaLiveEnvApiKey({ providerId: QA_OPENAI_PROVIDER_ID, env, cfg: params.cfg })?.apiKey ||
    resolveQaLiveEnvApiKey({ providerId: QA_OPENAI_CODEX_PROVIDER_ID, env, cfg: params.cfg })
      ?.apiKey ||
    hasQaLiveStagedApiKeyProfile({ cfg: params.cfg, providerId: QA_OPENAI_PROVIDER_ID }) ||
    hasQaLiveStagedApiKeyProfile({ cfg: params.cfg, providerId: QA_OPENAI_CODEX_PROVIDER_ID })
  ) {
    return;
  }
  const readCodexCredentials = params.readCodexCredentials ?? readCodexCliCredentialsCached;
  const codexHome = env.CODEX_HOME?.trim();
  const codexCredential = readCodexCredentials({
    ...(codexHome ? { codexHome } : {}),
    allowKeychainPrompt: false,
    ttlMs: 5_000,
  });
  if (codexCredential) {
    return;
  }
  throw new Error(
    [
      "QA live-frontier cannot run Codex-backed OpenAI models inside an isolated QA agent because no portable Codex auth is available.",
      "Set OPENAI_API_KEY or OPENCLAW_LIVE_OPENAI_KEY for an API-key fallback, or set CODEX_HOME to a logged-in Codex CLI home.",
      "Host OpenClaw OAuth refresh profiles are not copied into QA temp stores.",
    ].join(" "),
  );
}
