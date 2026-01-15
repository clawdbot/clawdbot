import {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
} from "../cli-credentials.js";
import {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  EXTERNAL_CLI_NEAR_EXPIRY_MS,
  EXTERNAL_CLI_SYNC_TTL_MS,
  log,
} from "./constants.js";
import type {
  AuthProfileCredential,
  AuthProfileStore,
  OAuthCredential,
  TokenCredential,
} from "./types.js";

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

function shallowEqualTokenCredentials(a: TokenCredential | undefined, b: TokenCredential): boolean {
  if (!a) return false;
  if (a.type !== "token") return false;
  return (
    a.provider === b.provider &&
    a.token === b.token &&
    a.expires === b.expires &&
    a.email === b.email
  );
}

function isExternalProfileFresh(cred: AuthProfileCredential | undefined, now: number): boolean {
  if (!cred) return false;
  if (cred.type !== "oauth" && cred.type !== "token") return false;
  if (cred.provider !== "anthropic" && cred.provider !== "openai-codex") {
    return false;
  }
  if (typeof cred.expires !== "number") return true;
  return cred.expires > now + EXTERNAL_CLI_NEAR_EXPIRY_MS;
}

/**
 * Sync OAuth credentials from external CLI tools (Claude Code CLI, Codex CLI) into the store.
 * This allows clawdbot to use the same credentials as these tools without requiring
 * separate authentication, and keeps credentials in sync when CLI tools refresh tokens.
 *
 * Returns true if any credentials were updated.
 */
export function syncExternalCliCredentials(
  store: AuthProfileStore,
  options?: { allowKeychainPrompt?: boolean },
): boolean {
  let mutated = false;
  const now = Date.now();

  // Sync from Claude Code CLI (supports both OAuth and Token credentials)
  const existingClaude = store.profiles[CLAUDE_CLI_PROFILE_ID];
  const shouldSyncClaude =
    !existingClaude ||
    existingClaude.provider !== "anthropic" ||
    existingClaude.type === "token" ||
    !isExternalProfileFresh(existingClaude, now);
  const claudeCreds = shouldSyncClaude
    ? readClaudeCliCredentialsCached({
        allowKeychainPrompt: options?.allowKeychainPrompt,
        ttlMs: EXTERNAL_CLI_SYNC_TTL_MS,
      })
    : null;
  if (claudeCreds) {
    const existing = store.profiles[CLAUDE_CLI_PROFILE_ID];
    const claudeCredsExpires = claudeCreds.expires ?? 0;

    // Determine if we should update based on credential comparison
    let shouldUpdate = false;
    let isEqual = false;

    if (claudeCreds.type === "oauth") {
      const existingOAuth = existing?.type === "oauth" ? existing : undefined;
      isEqual = shallowEqualOAuthCredentials(existingOAuth, claudeCreds);
      // Update if: no existing profile, type changed to oauth, expired, or CLI has newer token
      shouldUpdate =
        !existingOAuth ||
        existingOAuth.provider !== "anthropic" ||
        existingOAuth.expires <= now ||
        (claudeCredsExpires > now && claudeCredsExpires > existingOAuth.expires);
    } else {
      const existingToken = existing?.type === "token" ? existing : undefined;
      isEqual = shallowEqualTokenCredentials(existingToken, claudeCreds);
      // Update if: no existing profile, expired, or CLI has newer token
      shouldUpdate =
        !existingToken ||
        existingToken.provider !== "anthropic" ||
        (existingToken.expires ?? 0) <= now ||
        (claudeCredsExpires > now && claudeCredsExpires > (existingToken.expires ?? 0));
    }

    // Also update if credential type changed (token -> oauth upgrade)
    if (existing && existing.type !== claudeCreds.type) {
      // Prefer oauth over token (enables auto-refresh)
      if (claudeCreds.type === "oauth") {
        shouldUpdate = true;
        isEqual = false;
      }
    }

    // Avoid downgrading from oauth to token-only credentials.
    if (existing?.type === "oauth" && claudeCreds.type === "token") {
      shouldUpdate = false;
    }

    if (shouldUpdate && !isEqual) {
      store.profiles[CLAUDE_CLI_PROFILE_ID] = claudeCreds;
      mutated = true;
      log.info("synced anthropic credentials from claude cli", {
        profileId: CLAUDE_CLI_PROFILE_ID,
        type: claudeCreds.type,
        expires:
          typeof claudeCreds.expires === "number"
            ? new Date(claudeCreds.expires).toISOString()
            : "unknown",
      });
    }
  }

  // Sync from Codex CLI
  const existingCodex = store.profiles[CODEX_CLI_PROFILE_ID];
  const shouldSyncCodex =
    !existingCodex ||
    existingCodex.provider !== "openai-codex" ||
    !isExternalProfileFresh(existingCodex, now);
  const codexCreds = shouldSyncCodex
    ? readCodexCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS })
    : null;
  if (codexCreds) {
    const existing = store.profiles[CODEX_CLI_PROFILE_ID];
    const existingOAuth = existing?.type === "oauth" ? existing : undefined;

    // Codex creds don't carry expiry; use file mtime heuristic for freshness.
    const shouldUpdate =
      !existingOAuth ||
      existingOAuth.provider !== "openai-codex" ||
      existingOAuth.expires <= now ||
      codexCreds.expires > existingOAuth.expires;

    if (shouldUpdate && !shallowEqualOAuthCredentials(existingOAuth, codexCreds)) {
      store.profiles[CODEX_CLI_PROFILE_ID] = codexCreds;
      mutated = true;
      log.info("synced openai-codex credentials from codex cli", {
        profileId: CODEX_CLI_PROFILE_ID,
        expires: new Date(codexCreds.expires).toISOString(),
      });
    }
  }

  return mutated;
}
