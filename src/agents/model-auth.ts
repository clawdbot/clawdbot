import { type Api, getEnvApiKey, type Model } from "@mariozechner/pi-ai";
import type { ClawdbotConfig } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.js";
import { getShellEnvAppliedKeys } from "../infra/shell-env.js";
import {
  type AuthProfileStore,
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";

export {
  ensureAuthProfileStore,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";

export function getCustomProviderApiKey(
  cfg: ClawdbotConfig | undefined,
  provider: string,
): string | undefined {
  const providers = cfg?.models?.providers ?? {};
  const entry = providers[provider] as ModelProviderConfig | undefined;
  const key = entry?.apiKey?.trim();
  return key || undefined;
}

export async function resolveApiKeyForProvider(params: {
  provider: string;
  cfg?: ClawdbotConfig;
  profileId?: string;
  preferredProfile?: string;
  store?: AuthProfileStore;
}): Promise<{ apiKey: string; profileId?: string; source: string }> {
  const { provider, cfg, profileId, preferredProfile } = params;
  const store = params.store ?? ensureAuthProfileStore();

  if (profileId) {
    const resolved = await resolveApiKeyForProfile({
      cfg,
      store,
      profileId,
    });
    if (!resolved) {
      throw new Error(`No credentials found for profile "${profileId}".`);
    }
    return {
      apiKey: resolved.apiKey,
      profileId,
      source: `profile:${profileId}`,
    };
  }

  const order = resolveAuthProfileOrder({
    cfg,
    store,
    provider,
    preferredProfile,
  });
  for (const candidate of order) {
    try {
      const resolved = await resolveApiKeyForProfile({
        cfg,
        store,
        profileId: candidate,
      });
      if (resolved) {
        return {
          apiKey: resolved.apiKey,
          profileId: candidate,
          source: `profile:${candidate}`,
        };
      }
    } catch {}
  }

  const envResolved = resolveEnvApiKey(provider);
  if (envResolved) {
    return { apiKey: envResolved.apiKey, source: envResolved.source };
  }

  const customKey = getCustomProviderApiKey(cfg, provider);
  if (customKey) {
    return { apiKey: customKey, source: "models.json" };
  }

  if (provider === "openai") {
    const hasCodex = listProfilesForProvider(store, "openai-codex").length > 0;
    if (hasCodex) {
      throw new Error(
        'No API key found for provider "openai". You are authenticated with OpenAI Codex OAuth. Use openai-codex/gpt-5.2 (ChatGPT OAuth) or set OPENAI_API_KEY for openai/gpt-5.2.',
      );
    }
  }

  throw new Error(`No API key found for provider "${provider}".`);
}

export type EnvApiKeyResult = { apiKey: string; source: string };

export function resolveEnvApiKey(provider: string): EnvApiKeyResult | null {
  const applied = new Set(getShellEnvAppliedKeys());
  const pick = (envVar: string): EnvApiKeyResult | null => {
    const value = process.env[envVar]?.trim();
    if (!value) return null;
    const source = applied.has(envVar)
      ? `shell env: ${envVar}`
      : `env: ${envVar}`;
    return { apiKey: value, source };
  };

  if (provider === "github-copilot") {
    return (
      pick("COPILOT_GITHUB_TOKEN") ?? pick("GH_TOKEN") ?? pick("GITHUB_TOKEN")
    );
  }

  if (provider === "anthropic") {
    return pick("ANTHROPIC_OAUTH_TOKEN") ?? pick("ANTHROPIC_API_KEY");
  }

  if (provider === "google-vertex") {
    const envKey = getEnvApiKey(provider);
    if (!envKey) return null;
    return { apiKey: envKey, source: "gcloud adc" };
  }

  const envMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    google: "GEMINI_API_KEY",
    groq: "GROQ_API_KEY",
    cerebras: "CEREBRAS_API_KEY",
    xai: "XAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    zai: "ZAI_API_KEY",
    mistral: "MISTRAL_API_KEY",
  };
  const envVar = envMap[provider];
  if (!envVar) return null;
  return pick(envVar);
}

export async function getApiKeyForModel(params: {
  model: Model<Api>;
  cfg?: ClawdbotConfig;
  profileId?: string;
  preferredProfile?: string;
  store?: AuthProfileStore;
}): Promise<{ apiKey: string; profileId?: string; source: string }> {
  return resolveApiKeyForProvider({
    provider: params.model.provider,
    cfg: params.cfg,
    profileId: params.profileId,
    preferredProfile: params.preferredProfile,
    store: params.store,
  });
}
