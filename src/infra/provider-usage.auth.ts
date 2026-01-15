import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CLAUDE_CLI_PROFILE_ID,
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
} from "../agents/auth-profiles.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "../agents/model-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { loadConfig } from "../config/config.js";
import type { UsageProviderId } from "./provider-usage.types.js";

export type ProviderAuth = {
  provider: UsageProviderId;
  token: string;
  accountId?: string;
};

function parseGoogleToken(apiKey: string): { token: string } | null {
  if (!apiKey) return null;
  try {
    const parsed = JSON.parse(apiKey) as { token?: unknown };
    if (parsed && typeof parsed.token === "string") {
      return { token: parsed.token };
    }
  } catch {
    // ignore
  }
  return null;
}

function resolveZaiApiKey(): string | undefined {
  const envDirect = process.env.ZAI_API_KEY?.trim() || process.env.Z_AI_API_KEY?.trim();
  if (envDirect) return envDirect;

  const envResolved = resolveEnvApiKey("zai");
  if (envResolved?.apiKey) return envResolved.apiKey;

  const cfg = loadConfig();
  const key = getCustomProviderApiKey(cfg, "zai") || getCustomProviderApiKey(cfg, "z-ai");
  if (key) return key;

  const store = ensureAuthProfileStore();
  const apiProfile = [
    ...listProfilesForProvider(store, "zai"),
    ...listProfilesForProvider(store, "z-ai"),
  ].find((id) => store.profiles[id]?.type === "api_key");
  if (apiProfile) {
    const cred = store.profiles[apiProfile];
    if (cred?.type === "api_key" && cred.key?.trim()) {
      return cred.key.trim();
    }
  }

  try {
    const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
    if (!fs.existsSync(authPath)) return undefined;
    const data = JSON.parse(fs.readFileSync(authPath, "utf-8")) as Record<
      string,
      { access?: string }
    >;
    return data["z-ai"]?.access || data.zai?.access;
  } catch {
    return undefined;
  }
}

function resolveMinimaxApiKey(): string | undefined {
  const envDirect =
    process.env.MINIMAX_CODE_PLAN_KEY?.trim() || process.env.MINIMAX_API_KEY?.trim();
  if (envDirect) return envDirect;

  const envResolved = resolveEnvApiKey("minimax");
  if (envResolved?.apiKey) return envResolved.apiKey;

  const cfg = loadConfig();
  const key = getCustomProviderApiKey(cfg, "minimax");
  if (key) return key;

  const store = ensureAuthProfileStore();
  const apiProfile = listProfilesForProvider(store, "minimax").find((id) => {
    const cred = store.profiles[id];
    return cred?.type === "api_key" || cred?.type === "token";
  });
  if (!apiProfile) return undefined;
  const cred = store.profiles[apiProfile];
  if (cred?.type === "api_key" && cred.key?.trim()) {
    return cred.key.trim();
  }
  if (cred?.type === "token" && cred.token?.trim()) {
    return cred.token.trim();
  }
  return undefined;
}

async function resolveOAuthToken(params: {
  provider: UsageProviderId;
  agentDir?: string;
}): Promise<ProviderAuth | null> {
  const cfg = loadConfig();
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const order = resolveAuthProfileOrder({
    cfg,
    store,
    provider: params.provider,
  });

  // Claude Code CLI creds are the only Anthropic tokens that reliably include the
  // `user:profile` scope required for the OAuth usage endpoint.
  const candidates = params.provider === "anthropic" ? [CLAUDE_CLI_PROFILE_ID, ...order] : order;
  const deduped: string[] = [];
  for (const entry of candidates) {
    if (!deduped.includes(entry)) deduped.push(entry);
  }

  for (const profileId of deduped) {
    const cred = store.profiles[profileId];
    if (!cred || (cred.type !== "oauth" && cred.type !== "token")) continue;
    try {
      const resolved = await resolveApiKeyForProfile({
        // Usage snapshots should work even if config profile metadata is stale.
        // (e.g. config says api_key but the store has a token profile.)
        cfg: undefined,
        store,
        profileId,
        agentDir: params.agentDir,
      });
      if (!resolved?.apiKey) continue;
      let token = resolved.apiKey;
      if (params.provider === "google-gemini-cli" || params.provider === "google-antigravity") {
        const parsed = parseGoogleToken(resolved.apiKey);
        token = parsed?.token ?? resolved.apiKey;
      }
      return {
        provider: params.provider,
        token,
        accountId:
          cred.type === "oauth" && "accountId" in cred
            ? (cred as { accountId?: string }).accountId
            : undefined,
      };
    } catch {
      // ignore
    }
  }

  return null;
}

function resolveOAuthProviders(agentDir?: string): UsageProviderId[] {
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const cfg = loadConfig();
  const providers = [
    "anthropic",
    "github-copilot",
    "google-gemini-cli",
    "google-antigravity",
    "openai-codex",
  ] satisfies UsageProviderId[];
  const isOAuthLikeCredential = (id: string) => {
    const cred = store.profiles[id];
    return cred?.type === "oauth" || cred?.type === "token";
  };
  return providers.filter((provider) => {
    const profiles = listProfilesForProvider(store, provider).filter(isOAuthLikeCredential);
    if (profiles.length > 0) return true;
    const normalized = normalizeProviderId(provider);
    const configuredProfiles = Object.entries(cfg.auth?.profiles ?? {})
      .filter(([, profile]) => normalizeProviderId(profile.provider) === normalized)
      .map(([id]) => id)
      .filter(isOAuthLikeCredential);
    return configuredProfiles.length > 0;
  });
}

export async function resolveProviderAuths(params: {
  providers: UsageProviderId[];
  auth?: ProviderAuth[];
  agentDir?: string;
}): Promise<ProviderAuth[]> {
  if (params.auth) return params.auth;

  const oauthProviders = resolveOAuthProviders(params.agentDir);
  const auths: ProviderAuth[] = [];

  for (const provider of params.providers) {
    if (provider === "zai") {
      const apiKey = resolveZaiApiKey();
      if (apiKey) auths.push({ provider, token: apiKey });
      continue;
    }
    if (provider === "minimax") {
      const apiKey = resolveMinimaxApiKey();
      if (apiKey) auths.push({ provider, token: apiKey });
      continue;
    }

    if (!oauthProviders.includes(provider)) continue;
    const auth = await resolveOAuthToken({
      provider,
      agentDir: params.agentDir,
    });
    if (auth) auths.push(auth);
  }

  return auths;
}
