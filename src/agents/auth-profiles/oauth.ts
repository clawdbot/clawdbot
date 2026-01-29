import { getOAuthApiKey, type OAuthCredentials, type OAuthProvider } from "@mariozechner/pi-ai";
import lockfile from "proper-lockfile";

import type { MoltbotConfig } from "../../config/config.js";
import { refreshChutesTokens } from "../chutes-oauth.js";
import { refreshQwenPortalCredentials } from "../../providers/qwen-portal-oauth.js";
import { readClaudeCliCredentials, writeClaudeCliCredentials } from "../cli-credentials.js";
import { AUTH_STORE_LOCK_OPTIONS, CLAUDE_CLI_PROFILE_ID, log } from "./constants.js";
import { AUTH_STORE_LOCK_OPTIONS, log } from "./constants.js";
import { formatAuthDoctorHint } from "./doctor.js";
import { ensureAuthStoreFile, resolveAuthStorePath } from "./paths.js";
import { suggestOAuthProfileIdForLegacyDefault } from "./repair.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./store.js";
import type { AuthProfileStore } from "./types.js";

function buildOAuthApiKey(provider: string, credentials: OAuthCredentials): string {
  const needsProjectId = provider === "google-gemini-cli" || provider === "google-antigravity";
  return needsProjectId
    ? JSON.stringify({
        token: credentials.access,
        projectId: credentials.projectId,
      })
    : credentials.access;
}

async function refreshOAuthTokenWithLock(params: {
  profileId: string;
  agentDir?: string;
}): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(authPath, {
      ...AUTH_STORE_LOCK_OPTIONS,
    });

    const store = ensureAuthProfileStore(params.agentDir);
    const cred = store.profiles[params.profileId];
    if (!cred || cred.type !== "oauth") return null;

    if (Date.now() < cred.expires) {
      return {
        apiKey: buildOAuthApiKey(cred.provider, cred),
        newCredentials: cred,
      };
    }

    // Fix for OAuth race condition (#2036): Before attempting refresh with potentially
    // stale credentials, check if Claude Code CLI keychain has fresher tokens.
    // This prevents failures when Claude Code CLI has already refreshed the token
    // (invalidating the old refresh token) but Clawdbot hasn't synced yet.
    if (params.profileId === CLAUDE_CLI_PROFILE_ID && cred.provider === "anthropic") {
      const keychainCreds = readClaudeCliCredentials({ allowKeychainPrompt: true });
      if (keychainCreds?.type === "oauth" && keychainCreds.expires > Date.now()) {
        log.info("using fresher credentials from claude cli keychain instead of refreshing", {
          profileId: params.profileId,
          keychainExpires: new Date(keychainCreds.expires).toISOString(),
          storedExpires: new Date(cred.expires).toISOString(),
        });
        const newCredentials: OAuthCredentials = {
          access: keychainCreds.access,
          refresh: keychainCreds.refresh,
          expires: keychainCreds.expires,
        };
        // Update store with keychain credentials
        store.profiles[params.profileId] = {
          ...cred,
          ...newCredentials,
          type: "oauth",
        };
        saveAuthProfileStore(store, params.agentDir);
        return {
          apiKey: buildOAuthApiKey(cred.provider, newCredentials),
          newCredentials,
        };
      }
    }

    const oauthCreds: Record<string, OAuthCredentials> = {
      [cred.provider]: cred,
    };

    const result =
      String(cred.provider) === "chutes"
        ? await (async () => {
            const newCredentials = await refreshChutesTokens({
              credential: cred,
            });
            return { apiKey: newCredentials.access, newCredentials };
          })()
        : String(cred.provider) === "qwen-portal"
          ? await (async () => {
              const newCredentials = await refreshQwenPortalCredentials(cred);
              return { apiKey: newCredentials.access, newCredentials };
            })()
          : await getOAuthApiKey(cred.provider as OAuthProvider, oauthCreds);
    if (!result) return null;
    store.profiles[params.profileId] = {
      ...cred,
      ...result.newCredentials,
      type: "oauth",
    };
    saveAuthProfileStore(store, params.agentDir);

    return result;
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        // ignore unlock errors
      }
    }
  }
}

async function tryResolveOAuthProfile(params: {
  cfg?: MoltbotConfig;
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
}): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred || cred.type !== "oauth") return null;
  const profileConfig = cfg?.auth?.profiles?.[profileId];
  if (profileConfig && profileConfig.provider !== cred.provider) return null;
  if (profileConfig && profileConfig.mode !== cred.type) return null;

  if (Date.now() < cred.expires) {
    return {
      apiKey: buildOAuthApiKey(cred.provider, cred),
      provider: cred.provider,
      email: cred.email,
    };
  }

  const refreshed = await refreshOAuthTokenWithLock({
    profileId,
    agentDir: params.agentDir,
  });
  if (!refreshed) return null;
  return {
    apiKey: refreshed.apiKey,
    provider: cred.provider,
    email: cred.email,
  };
}

export async function resolveApiKeyForProfile(params: {
  cfg?: MoltbotConfig;
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
}): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred) return null;
  const profileConfig = cfg?.auth?.profiles?.[profileId];
  if (profileConfig && profileConfig.provider !== cred.provider) return null;
  if (profileConfig && profileConfig.mode !== cred.type) {
    // Compatibility: treat "oauth" config as compatible with stored token profiles.
    if (!(profileConfig.mode === "oauth" && cred.type === "token")) return null;
  }

  if (cred.type === "api_key") {
    return { apiKey: cred.key, provider: cred.provider, email: cred.email };
  }
  if (cred.type === "token") {
    const token = cred.token?.trim();
    if (!token) return null;
    if (
      typeof cred.expires === "number" &&
      Number.isFinite(cred.expires) &&
      cred.expires > 0 &&
      Date.now() >= cred.expires
    ) {
      return null;
    }
    return { apiKey: token, provider: cred.provider, email: cred.email };
  }
  if (Date.now() < cred.expires) {
    return {
      apiKey: buildOAuthApiKey(cred.provider, cred),
      provider: cred.provider,
      email: cred.email,
    };
  }

  try {
    const result = await refreshOAuthTokenWithLock({
      profileId,
      agentDir: params.agentDir,
    });
    if (!result) return null;
    return {
      apiKey: result.apiKey,
      provider: cred.provider,
      email: cred.email,
    };
  } catch (error) {
    const refreshedStore = ensureAuthProfileStore(params.agentDir);
    const refreshed = refreshedStore.profiles[profileId];
    if (refreshed?.type === "oauth" && Date.now() < refreshed.expires) {
      return {
        apiKey: buildOAuthApiKey(refreshed.provider, refreshed),
        provider: refreshed.provider,
        email: refreshed.email ?? cred.email,
      };
    }

    // Fix for OAuth race condition (#2036): When refresh fails, try one more time
    // to read fresher credentials from Claude Code CLI keychain. This handles the case
    // where Claude Code refreshed its tokens (invalidating our refresh token) between
    // when we checked and when we tried to refresh.
    if (profileId === CLAUDE_CLI_PROFILE_ID && cred.provider === "anthropic") {
      const keychainCreds = readClaudeCliCredentials({ allowKeychainPrompt: true });
      if (keychainCreds?.type === "oauth" && keychainCreds.expires > Date.now()) {
        log.info("refresh failed but found valid credentials in claude cli keychain", {
          profileId,
          keychainExpires: new Date(keychainCreds.expires).toISOString(),
        });
        // Update store with keychain credentials for future use
        refreshedStore.profiles[profileId] = {
          ...cred,
          access: keychainCreds.access,
          refresh: keychainCreds.refresh,
          expires: keychainCreds.expires,
          type: "oauth",
        };
        saveAuthProfileStore(refreshedStore, params.agentDir);
        return {
          apiKey: keychainCreds.access,
          provider: cred.provider,
          email: cred.email,
        };
      }
    }

    const fallbackProfileId = suggestOAuthProfileIdForLegacyDefault({
      cfg,
      store: refreshedStore,
      provider: cred.provider,
      legacyProfileId: profileId,
    });
    if (fallbackProfileId && fallbackProfileId !== profileId) {
      try {
        const fallbackResolved = await tryResolveOAuthProfile({
          cfg,
          store: refreshedStore,
          profileId: fallbackProfileId,
          agentDir: params.agentDir,
        });
        if (fallbackResolved) return fallbackResolved;
      } catch {
        // keep original error
      }
    }

    // Fallback: if this is a secondary agent, try using the main agent's credentials
    if (params.agentDir) {
      try {
        const mainStore = ensureAuthProfileStore(undefined); // main agent (no agentDir)
        const mainCred = mainStore.profiles[profileId];
        if (mainCred?.type === "oauth" && Date.now() < mainCred.expires) {
          // Main agent has fresh credentials - copy them to this agent and use them
          refreshedStore.profiles[profileId] = { ...mainCred };
          saveAuthProfileStore(refreshedStore, params.agentDir);
          log.info("inherited fresh OAuth credentials from main agent", {
            profileId,
            agentDir: params.agentDir,
            expires: new Date(mainCred.expires).toISOString(),
          });
          return {
            apiKey: buildOAuthApiKey(mainCred.provider, mainCred),
            provider: mainCred.provider,
            email: mainCred.email,
          };
        }
      } catch {
        // keep original error if main agent fallback also fails
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    const hint = formatAuthDoctorHint({
      cfg,
      store: refreshedStore,
      provider: cred.provider,
      profileId,
    });
    throw new Error(
      `OAuth token refresh failed for ${cred.provider}: ${message}. ` +
        "Please try again or re-authenticate." +
        (hint ? `\n\n${hint}` : ""),
    );
  }
}
