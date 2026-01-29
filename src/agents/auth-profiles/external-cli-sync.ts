import {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
  readQwenCliCredentialsCached,
} from "../cli-credentials.js";
import {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  EXTERNAL_CLI_NEAR_EXPIRY_MS,
  EXTERNAL_CLI_SYNC_TTL_MS,
  QWEN_CLI_PROFILE_ID,
  log,
} from "./constants.js";
import type { AuthProfileCredential, AuthProfileStore, OAuthCredential } from "./types.js";

function shallowEqualOAuthCredentials(a: OAuthCredential | undefined, b: OAuthCredential): boolean {
  if (!a) return false;
  if (a.type !== "oauth") return false;
  return (
    a.provider === b.provider &&
    a.access === b.access &&
    a.refresh === b.refresh &&
    a.expires === b.expires &&
    a.email === b.email &&
    a.enterpriseUrl === b.enterpriseUrl &&
    a.projectId === b.projectId &&
    a.accountId === b.accountId
  );
}

function isExternalProfileFresh(
  cred: AuthProfileCredential | undefined,
  now: number,
  provider?: string,
): boolean {
  if (!cred) return false;
  if (cred.type !== "oauth" && cred.type !== "token") return false;
  if (provider && cred.provider !== provider) {
    return false;
  }
  if (typeof cred.expires !== "number") return true;
  return cred.expires > now + EXTERNAL_CLI_NEAR_EXPIRY_MS;
}

/**
 * Sync Claude Code CLI credentials into the store.
 * Called on refresh failure to attempt recovery.
 *
 * Returns the synced credential if successful, null otherwise.
 */
export function trySyncClaudeCliCredentialsOnRefreshFailure(
  store: AuthProfileStore,
): OAuthCredential | null {
  const now = Date.now();
  const creds = readClaudeCliCredentialsCached({ ttlMs: 0 }); // Force fresh read

  if (!creds) {
    log.debug("no claude cli credentials found for recovery sync");
    return null;
  }

  // Only sync if CLI credentials are fresh (not expired)
  if (creds.expires <= now) {
    log.debug("claude cli credentials are expired, skipping recovery sync", {
      expires: new Date(creds.expires).toISOString(),
    });
    return null;
  }

  const existing = store.profiles[CLAUDE_CLI_PROFILE_ID];
  const existingOAuth = existing?.type === "oauth" ? existing : undefined;

  // Check if CLI credentials are newer than what we have
  if (existingOAuth && existingOAuth.expires >= creds.expires) {
    log.debug("stored credentials are not older than claude cli, skipping recovery sync");
    return null;
  }

  // Convert Claude CLI credential to OAuthCredential format
  if (creds.type === "oauth") {
    const oauthCred: OAuthCredential = {
      type: "oauth",
      provider: "anthropic",
      access: creds.access,
      refresh: creds.refresh,
      expires: creds.expires,
    };

    if (!shallowEqualOAuthCredentials(existingOAuth, oauthCred)) {
      store.profiles[CLAUDE_CLI_PROFILE_ID] = oauthCred;
      log.info("synced anthropic credentials from claude cli after refresh failure", {
        profileId: CLAUDE_CLI_PROFILE_ID,
        expires: new Date(creds.expires).toISOString(),
      });
      return oauthCred;
    }
  }

  return null;
}

/**
 * Sync Codex CLI credentials into the store.
 * Called on refresh failure to attempt recovery.
 *
 * Returns the synced credential if successful, null otherwise.
 */
export function trySyncCodexCliCredentialsOnRefreshFailure(
  store: AuthProfileStore,
): OAuthCredential | null {
  const now = Date.now();
  const creds = readCodexCliCredentialsCached({ ttlMs: 0 }); // Force fresh read

  if (!creds) {
    log.debug("no codex cli credentials found for recovery sync");
    return null;
  }

  // Only sync if CLI credentials are fresh (not expired)
  if (creds.expires <= now) {
    log.debug("codex cli credentials are expired, skipping recovery sync", {
      expires: new Date(creds.expires).toISOString(),
    });
    return null;
  }

  const existing = store.profiles[CODEX_CLI_PROFILE_ID];
  const existingOAuth = existing?.type === "oauth" ? existing : undefined;

  // Check if CLI credentials are newer than what we have
  if (existingOAuth && existingOAuth.expires >= creds.expires) {
    log.debug("stored credentials are not older than codex cli, skipping recovery sync");
    return null;
  }

  const oauthCred: OAuthCredential = {
    type: "oauth",
    provider: creds.provider,
    access: creds.access,
    refresh: creds.refresh,
    expires: creds.expires,
    accountId: creds.accountId,
  };

  if (!shallowEqualOAuthCredentials(existingOAuth, oauthCred)) {
    store.profiles[CODEX_CLI_PROFILE_ID] = oauthCred;
    log.info("synced openai-codex credentials from codex cli after refresh failure", {
      profileId: CODEX_CLI_PROFILE_ID,
      expires: new Date(creds.expires).toISOString(),
    });
    return oauthCred;
  }

  return null;
}

/**
 * Sync OAuth credentials from external CLI tools (Qwen Code CLI) into the store.
 *
 * Returns true if any credentials were updated.
 */
export function syncExternalCliCredentials(store: AuthProfileStore): boolean {
  let mutated = false;
  const now = Date.now();

  // Sync from Qwen Code CLI
  const existingQwen = store.profiles[QWEN_CLI_PROFILE_ID];
  const shouldSyncQwen =
    !existingQwen ||
    existingQwen.provider !== "qwen-portal" ||
    !isExternalProfileFresh(existingQwen, now);
  const qwenCreds = shouldSyncQwen
    ? readQwenCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS })
    : null;
  if (qwenCreds) {
    const existing = store.profiles[QWEN_CLI_PROFILE_ID];
    const existingOAuth = existing?.type === "oauth" ? existing : undefined;
    const shouldUpdate =
      !existingOAuth ||
      existingOAuth.provider !== "qwen-portal" ||
      existingOAuth.expires <= now ||
      qwenCreds.expires > existingOAuth.expires;

    if (shouldUpdate && !shallowEqualOAuthCredentials(existingOAuth, qwenCreds)) {
      store.profiles[QWEN_CLI_PROFILE_ID] = qwenCreds;
      mutated = true;
      log.info("synced qwen credentials from qwen cli", {
        profileId: QWEN_CLI_PROFILE_ID,
        expires: new Date(qwenCreds.expires).toISOString(),
      });
    }
  }

  return mutated;
}
