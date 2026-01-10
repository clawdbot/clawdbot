import fs from "node:fs";
import path from "node:path";

import {
  getOAuthApiKey,
  type OAuthCredentials,
  type OAuthProvider,
} from "@mariozechner/pi-ai";
import lockfile from "proper-lockfile";

import type { ClawdbotConfig } from "../config/config.js";
import { resolveOAuthPath } from "../config/paths.js";
import type { AuthProfileConfig } from "../config/types.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import { createSubsystemLogger } from "../logging.js";
import { resolveUserPath } from "../utils.js";
import { resolveClawdbotAgentDir } from "./agent-paths.js";
import {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
  writeClaudeCliCredentials,
} from "./cli-credentials.js";
import { normalizeProviderId } from "./model-selection.js";

const AUTH_STORE_VERSION = 1;
const AUTH_PROFILE_FILENAME = "auth-profiles.json";
const LEGACY_AUTH_FILENAME = "auth.json";

export const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";
export const CODEX_CLI_PROFILE_ID = "openai-codex:codex-cli";

const AUTH_STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

const EXTERNAL_CLI_SYNC_TTL_MS = 15 * 60 * 1000;
const EXTERNAL_CLI_NEAR_EXPIRY_MS = 10 * 60 * 1000;

const log = createSubsystemLogger("agents/auth-profiles");

export type ApiKeyCredential = {
  type: "api_key";
  provider: string;
  key: string;
  email?: string;
};

export type TokenCredential = {
  /**
   * Static bearer-style token (often OAuth access token / PAT).
   * Not refreshable by clawdbot (unlike `type: "oauth"`).
   */
  type: "token";
  provider: string;
  token: string;
  /** Optional expiry timestamp (ms since epoch). */
  expires?: number;
  email?: string;
};

export type OAuthCredential = OAuthCredentials & {
  type: "oauth";
  provider: OAuthProvider;
  email?: string;
};

export type AuthProfileCredential =
  | ApiKeyCredential
  | TokenCredential
  | OAuthCredential;

export type AuthProfileFailureReason =
  | "auth"
  | "format"
  | "rate_limit"
  | "billing"
  | "timeout"
  | "unknown";

/** Per-profile usage statistics for round-robin and cooldown tracking */
export type ProfileUsageStats = {
  lastUsed?: number;
  cooldownUntil?: number;
  disabledUntil?: number;
  disabledReason?: AuthProfileFailureReason;
  errorCount?: number;
  failureCounts?: Partial<Record<AuthProfileFailureReason, number>>;
  lastFailureAt?: number;
};

export type AuthProfileStore = {
  version: number;
  profiles: Record<string, AuthProfileCredential>;
  /**
   * Optional per-agent preferred profile order overrides.
   * This lets you lock/override auth rotation for a specific agent without
   * changing the global config.
   */
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
  /** Usage statistics per profile for round-robin rotation */
  usageStats?: Record<string, ProfileUsageStats>;
};

type LegacyAuthStore = Record<string, AuthProfileCredential>;

function resolveAuthStorePath(agentDir?: string): string {
  const resolved = resolveUserPath(agentDir ?? resolveClawdbotAgentDir());
  return path.join(resolved, AUTH_PROFILE_FILENAME);
}

function resolveLegacyAuthStorePath(agentDir?: string): string {
  const resolved = resolveUserPath(agentDir ?? resolveClawdbotAgentDir());
  return path.join(resolved, LEGACY_AUTH_FILENAME);
}

function ensureAuthStoreFile(pathname: string) {
  if (fs.existsSync(pathname)) return;
  const payload: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  saveJsonFile(pathname, payload);
}

function syncAuthProfileStore(
  target: AuthProfileStore,
  source: AuthProfileStore,
): void {
  target.version = source.version;
  target.profiles = source.profiles;
  target.order = source.order;
  target.lastGood = source.lastGood;
  target.usageStats = source.usageStats;
}

async function updateAuthProfileStoreWithLock(params: {
  agentDir?: string;
  updater: (store: AuthProfileStore) => boolean;
}): Promise<AuthProfileStore | null> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(authPath, AUTH_STORE_LOCK_OPTIONS);
    const store = ensureAuthProfileStore(params.agentDir);
    const shouldSave = params.updater(store);
    if (shouldSave) {
      saveAuthProfileStore(store, params.agentDir);
    }
    return store;
  } catch {
    return null;
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

function buildOAuthApiKey(
  provider: OAuthProvider,
  credentials: OAuthCredentials,
): string {
  const needsProjectId =
    provider === "google-gemini-cli" || provider === "google-antigravity";
  return needsProjectId
    ? JSON.stringify({
        token: credentials.access,
        projectId: credentials.projectId,
      })
    : credentials.access;
}

async function refreshOAuthTokenWithLock(params: {
  profileId: string;
  provider: OAuthProvider;
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

    const oauthCreds: Record<string, OAuthCredentials> = {
      [cred.provider]: cred,
    };
    const result = await getOAuthApiKey(cred.provider, oauthCreds);
    if (!result) return null;
    store.profiles[params.profileId] = {
      ...cred,
      ...result.newCredentials,
      type: "oauth",
    };
    saveAuthProfileStore(store, params.agentDir);

    // Sync refreshed credentials back to Claude CLI if this is the claude-cli profile
    // This ensures Claude Code continues to work after ClawdBot refreshes the token
    if (
      params.profileId === CLAUDE_CLI_PROFILE_ID &&
      cred.provider === "anthropic"
    ) {
      writeClaudeCliCredentials(result.newCredentials);
    }

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

function coerceLegacyStore(raw: unknown): LegacyAuthStore | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if ("profiles" in record) return null;
  const entries: LegacyAuthStore = {};
  for (const [key, value] of Object.entries(record)) {
    if (!value || typeof value !== "object") continue;
    const typed = value as Partial<AuthProfileCredential>;
    if (
      typed.type !== "api_key" &&
      typed.type !== "oauth" &&
      typed.type !== "token"
    ) {
      continue;
    }
    entries[key] = {
      ...typed,
      provider: typed.provider ?? (key as OAuthProvider),
    } as AuthProfileCredential;
  }
  return Object.keys(entries).length > 0 ? entries : null;
}

function coerceAuthStore(raw: unknown): AuthProfileStore | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (!record.profiles || typeof record.profiles !== "object") return null;
  const profiles = record.profiles as Record<string, unknown>;
  const normalized: Record<string, AuthProfileCredential> = {};
  for (const [key, value] of Object.entries(profiles)) {
    if (!value || typeof value !== "object") continue;
    const typed = value as Partial<AuthProfileCredential>;
    if (
      typed.type !== "api_key" &&
      typed.type !== "oauth" &&
      typed.type !== "token"
    ) {
      continue;
    }
    if (!typed.provider) continue;
    normalized[key] = typed as AuthProfileCredential;
  }
  const order =
    record.order && typeof record.order === "object"
      ? Object.entries(record.order as Record<string, unknown>).reduce(
          (acc, [provider, value]) => {
            if (!Array.isArray(value)) return acc;
            const list = value
              .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
              .filter(Boolean);
            if (list.length === 0) return acc;
            acc[provider] = list;
            return acc;
          },
          {} as Record<string, string[]>,
        )
      : undefined;
  return {
    version: Number(record.version ?? AUTH_STORE_VERSION),
    profiles: normalized,
    order,
    lastGood:
      record.lastGood && typeof record.lastGood === "object"
        ? (record.lastGood as Record<string, string>)
        : undefined,
    usageStats:
      record.usageStats && typeof record.usageStats === "object"
        ? (record.usageStats as Record<string, ProfileUsageStats>)
        : undefined,
  };
}

function mergeOAuthFileIntoStore(store: AuthProfileStore): boolean {
  const oauthPath = resolveOAuthPath();
  const oauthRaw = loadJsonFile(oauthPath);
  if (!oauthRaw || typeof oauthRaw !== "object") return false;
  const oauthEntries = oauthRaw as Record<string, OAuthCredentials>;
  let mutated = false;
  for (const [provider, creds] of Object.entries(oauthEntries)) {
    if (!creds || typeof creds !== "object") continue;
    const profileId = `${provider}:default`;
    if (store.profiles[profileId]) continue;
    store.profiles[profileId] = {
      type: "oauth",
      provider: provider as OAuthProvider,
      ...creds,
    };
    mutated = true;
  }
  return mutated;
}

function shallowEqualOAuthCredentials(
  a: OAuthCredential | undefined,
  b: OAuthCredential,
): boolean {
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

function shallowEqualTokenCredentials(
  a: TokenCredential | undefined,
  b: TokenCredential,
): boolean {
  if (!a) return false;
  if (a.type !== "token") return false;
  return (
    a.provider === b.provider &&
    a.token === b.token &&
    a.expires === b.expires &&
    a.email === b.email
  );
}

function isExternalProfileFresh(
  cred: AuthProfileCredential | undefined,
  now: number,
): boolean {
  if (!cred) return false;
  if (cred.type !== "oauth" && cred.type !== "token") return false;
  if (cred.provider !== "anthropic" && cred.provider !== "openai-codex") {
    return false;
  }
  if (typeof cred.expires !== "number") return true;
  return cred.expires > now + EXTERNAL_CLI_NEAR_EXPIRY_MS;
}

/**
 * Sync OAuth credentials from external CLI tools (Claude CLI, Codex CLI) into the store.
 * This allows clawdbot to use the same credentials as these tools without requiring
 * separate authentication, and keeps credentials in sync when CLI tools refresh tokens.
 *
 * Returns true if any credentials were updated.
 */
function syncExternalCliCredentials(
  store: AuthProfileStore,
  options?: { allowKeychainPrompt?: boolean },
): boolean {
  let mutated = false;
  const now = Date.now();

  // Sync from Claude CLI (supports both OAuth and Token credentials)
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
        (claudeCredsExpires > now &&
          claudeCredsExpires > existingOAuth.expires);
    } else {
      const existingToken = existing?.type === "token" ? existing : undefined;
      isEqual = shallowEqualTokenCredentials(existingToken, claudeCreds);
      // Update if: no existing profile, expired, or CLI has newer token
      shouldUpdate =
        !existingToken ||
        existingToken.provider !== "anthropic" ||
        (existingToken.expires ?? 0) <= now ||
        (claudeCredsExpires > now &&
          claudeCredsExpires > (existingToken.expires ?? 0));
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
    existingCodex.provider !== ("openai-codex" as OAuthProvider) ||
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
      existingOAuth.provider !== ("openai-codex" as unknown as OAuthProvider) ||
      existingOAuth.expires <= now ||
      codexCreds.expires > existingOAuth.expires;

    if (
      shouldUpdate &&
      !shallowEqualOAuthCredentials(existingOAuth, codexCreds)
    ) {
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

export function loadAuthProfileStore(): AuthProfileStore {
  const authPath = resolveAuthStorePath();
  const raw = loadJsonFile(authPath);
  const asStore = coerceAuthStore(raw);
  if (asStore) {
    // Sync from external CLI tools on every load
    const synced = syncExternalCliCredentials(asStore);
    if (synced) {
      saveJsonFile(authPath, asStore);
    }
    return asStore;
  }

  const legacyRaw = loadJsonFile(resolveLegacyAuthStorePath());
  const legacy = coerceLegacyStore(legacyRaw);
  if (legacy) {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {},
    };
    for (const [provider, cred] of Object.entries(legacy)) {
      const profileId = `${provider}:default`;
      if (cred.type === "api_key") {
        store.profiles[profileId] = {
          type: "api_key",
          provider: cred.provider ?? (provider as OAuthProvider),
          key: cred.key,
          ...(cred.email ? { email: cred.email } : {}),
        };
      } else if (cred.type === "token") {
        store.profiles[profileId] = {
          type: "token",
          provider: cred.provider ?? (provider as OAuthProvider),
          token: cred.token,
          ...(typeof cred.expires === "number"
            ? { expires: cred.expires }
            : {}),
          ...(cred.email ? { email: cred.email } : {}),
        };
      } else {
        store.profiles[profileId] = {
          type: "oauth",
          provider: cred.provider ?? (provider as OAuthProvider),
          access: cred.access,
          refresh: cred.refresh,
          expires: cred.expires,
          ...(cred.enterpriseUrl ? { enterpriseUrl: cred.enterpriseUrl } : {}),
          ...(cred.projectId ? { projectId: cred.projectId } : {}),
          ...(cred.accountId ? { accountId: cred.accountId } : {}),
          ...(cred.email ? { email: cred.email } : {}),
        };
      }
    }
    syncExternalCliCredentials(store);
    return store;
  }

  const store: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
  syncExternalCliCredentials(store);
  return store;
}

export function ensureAuthProfileStore(
  agentDir?: string,
  options?: { allowKeychainPrompt?: boolean },
): AuthProfileStore {
  const authPath = resolveAuthStorePath(agentDir);
  const raw = loadJsonFile(authPath);
  const asStore = coerceAuthStore(raw);
  if (asStore) {
    // Sync from external CLI tools on every load
    const synced = syncExternalCliCredentials(asStore, options);
    if (synced) {
      saveJsonFile(authPath, asStore);
    }
    return asStore;
  }

  const legacyRaw = loadJsonFile(resolveLegacyAuthStorePath(agentDir));
  const legacy = coerceLegacyStore(legacyRaw);
  const store: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  if (legacy) {
    for (const [provider, cred] of Object.entries(legacy)) {
      const profileId = `${provider}:default`;
      if (cred.type === "api_key") {
        store.profiles[profileId] = {
          type: "api_key",
          provider: cred.provider ?? (provider as OAuthProvider),
          key: cred.key,
          ...(cred.email ? { email: cred.email } : {}),
        };
      } else if (cred.type === "token") {
        store.profiles[profileId] = {
          type: "token",
          provider: cred.provider ?? (provider as OAuthProvider),
          token: cred.token,
          ...(typeof cred.expires === "number"
            ? { expires: cred.expires }
            : {}),
          ...(cred.email ? { email: cred.email } : {}),
        };
      } else {
        store.profiles[profileId] = {
          type: "oauth",
          provider: cred.provider ?? (provider as OAuthProvider),
          access: cred.access,
          refresh: cred.refresh,
          expires: cred.expires,
          ...(cred.enterpriseUrl ? { enterpriseUrl: cred.enterpriseUrl } : {}),
          ...(cred.projectId ? { projectId: cred.projectId } : {}),
          ...(cred.accountId ? { accountId: cred.accountId } : {}),
          ...(cred.email ? { email: cred.email } : {}),
        };
      }
    }
  }

  const mergedOAuth = mergeOAuthFileIntoStore(store);
  const syncedCli = syncExternalCliCredentials(store, options);
  const shouldWrite = legacy !== null || mergedOAuth || syncedCli;
  if (shouldWrite) {
    saveJsonFile(authPath, store);
  }

  // PR #368: legacy auth.json could get re-migrated from other agent dirs,
  // overwriting fresh OAuth creds with stale tokens (fixes #363). Delete only
  // after we've successfully written auth-profiles.json.
  if (shouldWrite && legacy !== null) {
    const legacyPath = resolveLegacyAuthStorePath(agentDir);
    try {
      fs.unlinkSync(legacyPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log.warn("failed to delete legacy auth.json after migration", {
          err,
          legacyPath,
        });
      }
    }
  }

  return store;
}

export function saveAuthProfileStore(
  store: AuthProfileStore,
  agentDir?: string,
): void {
  const authPath = resolveAuthStorePath(agentDir);
  const payload = {
    version: AUTH_STORE_VERSION,
    profiles: store.profiles,
    order: store.order ?? undefined,
    lastGood: store.lastGood ?? undefined,
    usageStats: store.usageStats ?? undefined,
  } satisfies AuthProfileStore;
  saveJsonFile(authPath, payload);
}

export async function setAuthProfileOrder(params: {
  agentDir?: string;
  provider: string;
  order?: string[] | null;
}): Promise<AuthProfileStore | null> {
  const providerKey = normalizeProviderId(params.provider);
  const sanitized =
    params.order && Array.isArray(params.order)
      ? params.order.map((entry) => String(entry).trim()).filter(Boolean)
      : [];

  const deduped: string[] = [];
  for (const entry of sanitized) {
    if (!deduped.includes(entry)) deduped.push(entry);
  }

  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => {
      store.order = store.order ?? {};
      if (deduped.length === 0) {
        if (!store.order[providerKey]) return false;
        delete store.order[providerKey];
        if (Object.keys(store.order).length === 0) {
          store.order = undefined;
        }
        return true;
      }
      store.order[providerKey] = deduped;
      return true;
    },
  });
}

export function upsertAuthProfile(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): void {
  const store = ensureAuthProfileStore(params.agentDir);
  store.profiles[params.profileId] = params.credential;
  saveAuthProfileStore(store, params.agentDir);
}

export function listProfilesForProvider(
  store: AuthProfileStore,
  provider: string,
): string[] {
  const providerKey = normalizeProviderId(provider);
  return Object.entries(store.profiles)
    .filter(([, cred]) => normalizeProviderId(cred.provider) === providerKey)
    .map(([id]) => id);
}

/**
 * Check if a profile is currently in cooldown (due to rate limiting or errors).
 */
export function isProfileInCooldown(
  store: AuthProfileStore,
  profileId: string,
): boolean {
  const stats = store.usageStats?.[profileId];
  if (!stats) return false;
  const unusableUntil = resolveProfileUnusableUntil(stats);
  return unusableUntil ? Date.now() < unusableUntil : false;
}

/**
 * Mark a profile as successfully used. Resets error count and updates lastUsed.
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
export async function markAuthProfileUsed(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
}): Promise<void> {
  const { store, profileId, agentDir } = params;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      if (!freshStore.profiles[profileId]) return false;
      freshStore.usageStats = freshStore.usageStats ?? {};
      freshStore.usageStats[profileId] = {
        ...freshStore.usageStats[profileId],
        lastUsed: Date.now(),
        errorCount: 0,
        cooldownUntil: undefined,
        disabledUntil: undefined,
        disabledReason: undefined,
        failureCounts: undefined,
      };
      return true;
    },
  });
  if (updated) {
    syncAuthProfileStore(store, updated);
    return;
  }
  if (!store.profiles[profileId]) return;

  store.usageStats = store.usageStats ?? {};
  store.usageStats[profileId] = {
    ...store.usageStats[profileId],
    lastUsed: Date.now(),
    errorCount: 0,
    cooldownUntil: undefined,
    disabledUntil: undefined,
    disabledReason: undefined,
    failureCounts: undefined,
  };
  saveAuthProfileStore(store, agentDir);
}

export function calculateAuthProfileCooldownMs(errorCount: number): number {
  const normalized = Math.max(1, errorCount);
  return Math.min(
    60 * 60 * 1000, // 1 hour max
    60 * 1000 * 5 ** Math.min(normalized - 1, 3),
  );
}

type ResolvedAuthCooldownConfig = {
  billingBackoffMs: number;
  billingMaxMs: number;
  failureWindowMs: number;
};

function resolveAuthCooldownConfig(params: {
  cfg?: ClawdbotConfig;
  providerId: string;
}): ResolvedAuthCooldownConfig {
  const defaults = {
    billingBackoffHours: 5,
    billingMaxHours: 24,
    failureWindowHours: 24,
  } as const;

  const resolveHours = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : fallback;

  const cooldowns = params.cfg?.auth?.cooldowns;
  const billingOverride = (() => {
    const map = cooldowns?.billingBackoffHoursByProvider;
    if (!map) return undefined;
    for (const [key, value] of Object.entries(map)) {
      if (normalizeProviderId(key) === params.providerId) return value;
    }
    return undefined;
  })();

  const billingBackoffHours = resolveHours(
    billingOverride ?? cooldowns?.billingBackoffHours,
    defaults.billingBackoffHours,
  );
  const billingMaxHours = resolveHours(
    cooldowns?.billingMaxHours,
    defaults.billingMaxHours,
  );
  const failureWindowHours = resolveHours(
    cooldowns?.failureWindowHours,
    defaults.failureWindowHours,
  );

  return {
    billingBackoffMs: billingBackoffHours * 60 * 60 * 1000,
    billingMaxMs: billingMaxHours * 60 * 60 * 1000,
    failureWindowMs: failureWindowHours * 60 * 60 * 1000,
  };
}

function calculateAuthProfileBillingDisableMsWithConfig(params: {
  errorCount: number;
  baseMs: number;
  maxMs: number;
}): number {
  const normalized = Math.max(1, params.errorCount);
  const baseMs = Math.max(60_000, params.baseMs);
  const maxMs = Math.max(baseMs, params.maxMs);
  const exponent = Math.min(normalized - 1, 10);
  const raw = baseMs * 2 ** exponent;
  return Math.min(maxMs, raw);
}

function resolveProfileUnusableUntil(stats: ProfileUsageStats): number | null {
  const values = [stats.cooldownUntil, stats.disabledUntil]
    .filter((value): value is number => typeof value === "number")
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return null;
  return Math.max(...values);
}

export function resolveProfileUnusableUntilForDisplay(
  store: AuthProfileStore,
  profileId: string,
): number | null {
  const stats = store.usageStats?.[profileId];
  if (!stats) return null;
  return resolveProfileUnusableUntil(stats);
}

function computeNextProfileUsageStats(params: {
  existing: ProfileUsageStats;
  now: number;
  reason: AuthProfileFailureReason;
  cfgResolved: ResolvedAuthCooldownConfig;
}): ProfileUsageStats {
  const windowMs = params.cfgResolved.failureWindowMs;
  const windowExpired =
    typeof params.existing.lastFailureAt === "number" &&
    params.existing.lastFailureAt > 0 &&
    params.now - params.existing.lastFailureAt > windowMs;

  const baseErrorCount = windowExpired ? 0 : (params.existing.errorCount ?? 0);
  const nextErrorCount = baseErrorCount + 1;
  const failureCounts = windowExpired
    ? {}
    : { ...params.existing.failureCounts };
  failureCounts[params.reason] = (failureCounts[params.reason] ?? 0) + 1;

  const updatedStats: ProfileUsageStats = {
    ...params.existing,
    errorCount: nextErrorCount,
    failureCounts,
    lastFailureAt: params.now,
  };

  if (params.reason === "billing") {
    const billingCount = failureCounts.billing ?? 1;
    const backoffMs = calculateAuthProfileBillingDisableMsWithConfig({
      errorCount: billingCount,
      baseMs: params.cfgResolved.billingBackoffMs,
      maxMs: params.cfgResolved.billingMaxMs,
    });
    updatedStats.disabledUntil = params.now + backoffMs;
    updatedStats.disabledReason = "billing";
  } else {
    const backoffMs = calculateAuthProfileCooldownMs(nextErrorCount);
    updatedStats.cooldownUntil = params.now + backoffMs;
  }

  return updatedStats;
}

/**
 * Mark a profile as failed for a specific reason. Billing failures are treated
 * as "disabled" (longer backoff) vs the regular cooldown window.
 */
export async function markAuthProfileFailure(params: {
  store: AuthProfileStore;
  profileId: string;
  reason: AuthProfileFailureReason;
  cfg?: ClawdbotConfig;
  agentDir?: string;
}): Promise<void> {
  const { store, profileId, reason, agentDir, cfg } = params;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      const profile = freshStore.profiles[profileId];
      if (!profile) return false;
      freshStore.usageStats = freshStore.usageStats ?? {};
      const existing = freshStore.usageStats[profileId] ?? {};

      const now = Date.now();
      const providerKey = normalizeProviderId(profile.provider);
      const cfgResolved = resolveAuthCooldownConfig({
        cfg,
        providerId: providerKey,
      });

      freshStore.usageStats[profileId] = computeNextProfileUsageStats({
        existing,
        now,
        reason,
        cfgResolved,
      });
      return true;
    },
  });
  if (updated) {
    syncAuthProfileStore(store, updated);
    return;
  }
  if (!store.profiles[profileId]) return;

  store.usageStats = store.usageStats ?? {};
  const existing = store.usageStats[profileId] ?? {};
  const now = Date.now();
  const providerKey = normalizeProviderId(
    store.profiles[profileId]?.provider ?? "",
  );
  const cfgResolved = resolveAuthCooldownConfig({
    cfg,
    providerId: providerKey,
  });

  store.usageStats[profileId] = computeNextProfileUsageStats({
    existing,
    now,
    reason,
    cfgResolved,
  });
  saveAuthProfileStore(store, agentDir);
}

/**
 * Mark a profile as failed/rate-limited. Applies exponential backoff cooldown.
 * Cooldown times: 1min, 5min, 25min, max 1 hour.
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
export async function markAuthProfileCooldown(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
}): Promise<void> {
  await markAuthProfileFailure({
    store: params.store,
    profileId: params.profileId,
    reason: "unknown",
    agentDir: params.agentDir,
  });
}

/**
 * Clear cooldown for a profile (e.g., manual reset).
 * Uses store lock to avoid overwriting concurrent usage updates.
 */
export async function clearAuthProfileCooldown(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
}): Promise<void> {
  const { store, profileId, agentDir } = params;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      if (!freshStore.usageStats?.[profileId]) return false;

      freshStore.usageStats[profileId] = {
        ...freshStore.usageStats[profileId],
        errorCount: 0,
        cooldownUntil: undefined,
      };
      return true;
    },
  });
  if (updated) {
    syncAuthProfileStore(store, updated);
    return;
  }
  if (!store.usageStats?.[profileId]) return;

  store.usageStats[profileId] = {
    ...store.usageStats[profileId],
    errorCount: 0,
    cooldownUntil: undefined,
  };
  saveAuthProfileStore(store, agentDir);
}

export function resolveAuthProfileOrder(params: {
  cfg?: ClawdbotConfig;
  store: AuthProfileStore;
  provider: string;
  preferredProfile?: string;
}): string[] {
  const { cfg, store, provider, preferredProfile } = params;
  const providerKey = normalizeProviderId(provider);
  const storedOrder = (() => {
    const order = store.order;
    if (!order) return undefined;
    for (const [key, value] of Object.entries(order)) {
      if (normalizeProviderId(key) === providerKey) return value;
    }
    return undefined;
  })();
  const configuredOrder = (() => {
    const order = cfg?.auth?.order;
    if (!order) return undefined;
    for (const [key, value] of Object.entries(order)) {
      if (normalizeProviderId(key) === providerKey) return value;
    }
    return undefined;
  })();
  const explicitOrder = storedOrder ?? configuredOrder;
  const explicitProfiles = cfg?.auth?.profiles
    ? Object.entries(cfg.auth.profiles)
        .filter(
          ([, profile]) =>
            normalizeProviderId(profile.provider) === providerKey,
        )
        .map(([profileId]) => profileId)
    : [];
  const baseOrder =
    explicitOrder ??
    (explicitProfiles.length > 0
      ? explicitProfiles
      : listProfilesForProvider(store, providerKey));
  if (baseOrder.length === 0) return [];

  const filtered = baseOrder.filter((profileId) => {
    const cred = store.profiles[profileId];
    return cred ? normalizeProviderId(cred.provider) === providerKey : true;
  });
  const deduped: string[] = [];
  for (const entry of filtered) {
    if (!deduped.includes(entry)) deduped.push(entry);
  }

  // If user specified explicit order (store override or config), respect it
  // exactly, but still apply cooldown sorting to avoid repeatedly selecting
  // known-bad/rate-limited keys as the first candidate.
  if (explicitOrder && explicitOrder.length > 0) {
    // ...but still respect cooldown tracking to avoid repeatedly selecting a
    // known-bad/rate-limited key as the first candidate.
    const now = Date.now();
    const available: string[] = [];
    const inCooldown: Array<{ profileId: string; cooldownUntil: number }> = [];

    for (const profileId of deduped) {
      const cooldownUntil =
        resolveProfileUnusableUntil(store.usageStats?.[profileId] ?? {}) ?? 0;
      if (
        typeof cooldownUntil === "number" &&
        Number.isFinite(cooldownUntil) &&
        cooldownUntil > 0 &&
        now < cooldownUntil
      ) {
        inCooldown.push({ profileId, cooldownUntil });
      } else {
        available.push(profileId);
      }
    }

    const cooldownSorted = inCooldown
      .sort((a, b) => a.cooldownUntil - b.cooldownUntil)
      .map((entry) => entry.profileId);

    const ordered = [...available, ...cooldownSorted];

    // Still put preferredProfile first if specified
    if (preferredProfile && ordered.includes(preferredProfile)) {
      return [
        preferredProfile,
        ...ordered.filter((e) => e !== preferredProfile),
      ];
    }
    return ordered;
  }

  // Otherwise, use round-robin: sort by lastUsed (oldest first)
  // preferredProfile goes first if specified (for explicit user choice)
  // lastGood is NOT prioritized - that would defeat round-robin
  const sorted = orderProfilesByMode(deduped, store);

  if (preferredProfile && sorted.includes(preferredProfile)) {
    return [preferredProfile, ...sorted.filter((e) => e !== preferredProfile)];
  }

  return sorted;
}

function orderProfilesByMode(
  order: string[],
  store: AuthProfileStore,
): string[] {
  const now = Date.now();

  // Partition into available and in-cooldown
  const available: string[] = [];
  const inCooldown: string[] = [];

  for (const profileId of order) {
    if (isProfileInCooldown(store, profileId)) {
      inCooldown.push(profileId);
    } else {
      available.push(profileId);
    }
  }

  // Sort available profiles by lastUsed (oldest first = round-robin)
  // Then by lastUsed (oldest first = round-robin within type)
  const scored = available.map((profileId) => {
    const type = store.profiles[profileId]?.type;
    const typeScore =
      type === "oauth" ? 0 : type === "token" ? 1 : type === "api_key" ? 2 : 3;
    const lastUsed = store.usageStats?.[profileId]?.lastUsed ?? 0;
    return { profileId, typeScore, lastUsed };
  });

  // Primary sort: type preference (oauth > token > api_key).
  // Secondary sort: lastUsed (oldest first for round-robin within type).
  const sorted = scored
    .sort((a, b) => {
      // First by type (oauth > token > api_key)
      if (a.typeScore !== b.typeScore) return a.typeScore - b.typeScore;
      // Then by lastUsed (oldest first)
      return a.lastUsed - b.lastUsed;
    })
    .map((entry) => entry.profileId);

  // Append cooldown profiles at the end (sorted by cooldown expiry, soonest first)
  const cooldownSorted = inCooldown
    .map((profileId) => ({
      profileId,
      cooldownUntil:
        resolveProfileUnusableUntil(store.usageStats?.[profileId] ?? {}) ?? now,
    }))
    .sort((a, b) => a.cooldownUntil - b.cooldownUntil)
    .map((entry) => entry.profileId);

  return [...sorted, ...cooldownSorted];
}

export async function resolveApiKeyForProfile(params: {
  cfg?: ClawdbotConfig;
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
      provider: cred.provider,
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

export async function markAuthProfileGood(params: {
  store: AuthProfileStore;
  provider: string;
  profileId: string;
  agentDir?: string;
}): Promise<void> {
  const { store, provider, profileId, agentDir } = params;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      const profile = freshStore.profiles[profileId];
      if (!profile || profile.provider !== provider) return false;
      freshStore.lastGood = { ...freshStore.lastGood, [provider]: profileId };
      return true;
    },
  });
  if (updated) {
    syncAuthProfileStore(store, updated);
    return;
  }
  const profile = store.profiles[profileId];
  if (!profile || profile.provider !== provider) return;
  store.lastGood = { ...store.lastGood, [provider]: profileId };
  saveAuthProfileStore(store, agentDir);
}

export function resolveAuthStorePathForDisplay(agentDir?: string): string {
  const pathname = resolveAuthStorePath(agentDir);
  return pathname.startsWith("~") ? pathname : resolveUserPath(pathname);
}

export function resolveAuthProfileDisplayLabel(params: {
  cfg?: ClawdbotConfig;
  store: AuthProfileStore;
  profileId: string;
}): string {
  const { cfg, store, profileId } = params;
  const profile = store.profiles[profileId];
  const configEmail = cfg?.auth?.profiles?.[profileId]?.email?.trim();
  const email = configEmail || profile?.email?.trim();
  if (email) return `${profileId} (${email})`;
  return profileId;
}

async function tryResolveOAuthProfile(params: {
  cfg?: ClawdbotConfig;
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
    provider: cred.provider,
    agentDir: params.agentDir,
  });
  if (!refreshed) return null;
  return {
    apiKey: refreshed.apiKey,
    provider: cred.provider,
    email: cred.email,
  };
}

function getProfileSuffix(profileId: string): string {
  const idx = profileId.indexOf(":");
  if (idx < 0) return "";
  return profileId.slice(idx + 1);
}

function isEmailLike(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return trimmed.includes("@") && trimmed.includes(".");
}

export function suggestOAuthProfileIdForLegacyDefault(params: {
  cfg?: ClawdbotConfig;
  store: AuthProfileStore;
  provider: string;
  legacyProfileId: string;
}): string | null {
  const providerKey = normalizeProviderId(params.provider);
  const legacySuffix = getProfileSuffix(params.legacyProfileId);
  if (legacySuffix !== "default") return null;

  const legacyCfg = params.cfg?.auth?.profiles?.[params.legacyProfileId];
  if (
    legacyCfg &&
    normalizeProviderId(legacyCfg.provider) === providerKey &&
    legacyCfg.mode !== "oauth"
  ) {
    return null;
  }

  const oauthProfiles = listProfilesForProvider(
    params.store,
    providerKey,
  ).filter((id) => params.store.profiles[id]?.type === "oauth");
  if (oauthProfiles.length === 0) return null;

  const configuredEmail = legacyCfg?.email?.trim();
  if (configuredEmail) {
    const byEmail = oauthProfiles.find((id) => {
      const cred = params.store.profiles[id];
      if (!cred || cred.type !== "oauth") return false;
      const email = cred.email?.trim();
      return (
        email === configuredEmail || id === `${providerKey}:${configuredEmail}`
      );
    });
    if (byEmail) return byEmail;
  }

  const lastGood =
    params.store.lastGood?.[providerKey] ??
    params.store.lastGood?.[params.provider];
  if (lastGood && oauthProfiles.includes(lastGood)) return lastGood;

  const nonLegacy = oauthProfiles.filter((id) => id !== params.legacyProfileId);
  if (nonLegacy.length === 1) return nonLegacy[0] ?? null;

  const emailLike = nonLegacy.filter((id) => isEmailLike(getProfileSuffix(id)));
  if (emailLike.length === 1) return emailLike[0] ?? null;

  return null;
}

export type AuthProfileIdRepairResult = {
  config: ClawdbotConfig;
  changes: string[];
  migrated: boolean;
  fromProfileId?: string;
  toProfileId?: string;
};

export function repairOAuthProfileIdMismatch(params: {
  cfg: ClawdbotConfig;
  store: AuthProfileStore;
  provider: string;
  legacyProfileId?: string;
}): AuthProfileIdRepairResult {
  const legacyProfileId =
    params.legacyProfileId ?? `${normalizeProviderId(params.provider)}:default`;
  const legacyCfg = params.cfg.auth?.profiles?.[legacyProfileId];
  if (!legacyCfg) {
    return { config: params.cfg, changes: [], migrated: false };
  }
  if (legacyCfg.mode !== "oauth") {
    return { config: params.cfg, changes: [], migrated: false };
  }
  if (
    normalizeProviderId(legacyCfg.provider) !==
    normalizeProviderId(params.provider)
  ) {
    return { config: params.cfg, changes: [], migrated: false };
  }

  const toProfileId = suggestOAuthProfileIdForLegacyDefault({
    cfg: params.cfg,
    store: params.store,
    provider: params.provider,
    legacyProfileId,
  });
  if (!toProfileId || toProfileId === legacyProfileId) {
    return { config: params.cfg, changes: [], migrated: false };
  }

  const toCred = params.store.profiles[toProfileId];
  const toEmail = toCred?.type === "oauth" ? toCred.email?.trim() : undefined;

  const nextProfiles = {
    ...(params.cfg.auth?.profiles as
      | Record<string, AuthProfileConfig>
      | undefined),
  } as Record<string, AuthProfileConfig>;
  delete nextProfiles[legacyProfileId];
  nextProfiles[toProfileId] = {
    ...legacyCfg,
    ...(toEmail ? { email: toEmail } : {}),
  };

  const providerKey = normalizeProviderId(params.provider);
  const nextOrder = (() => {
    const order = params.cfg.auth?.order;
    if (!order) return undefined;
    const resolvedKey = Object.keys(order).find(
      (key) => normalizeProviderId(key) === providerKey,
    );
    if (!resolvedKey) return order;
    const existing = order[resolvedKey];
    if (!Array.isArray(existing)) return order;
    const replaced = existing
      .map((id) => (id === legacyProfileId ? toProfileId : id))
      .filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
      );
    const deduped: string[] = [];
    for (const entry of replaced) {
      if (!deduped.includes(entry)) deduped.push(entry);
    }
    return { ...order, [resolvedKey]: deduped };
  })();

  const nextCfg: ClawdbotConfig = {
    ...params.cfg,
    auth: {
      ...params.cfg.auth,
      profiles: nextProfiles,
      ...(nextOrder ? { order: nextOrder } : {}),
    },
  };

  const changes = [
    `Auth: migrate ${legacyProfileId} → ${toProfileId} (OAuth profile id)`,
  ];

  return {
    config: nextCfg,
    changes,
    migrated: true,
    fromProfileId: legacyProfileId,
    toProfileId,
  };
}

export function formatAuthDoctorHint(params: {
  cfg?: ClawdbotConfig;
  store: AuthProfileStore;
  provider: string;
  profileId?: string;
}): string {
  const providerKey = normalizeProviderId(params.provider);
  if (providerKey !== "anthropic") return "";

  const legacyProfileId = params.profileId ?? "anthropic:default";
  const suggested = suggestOAuthProfileIdForLegacyDefault({
    cfg: params.cfg,
    store: params.store,
    provider: providerKey,
    legacyProfileId,
  });
  if (!suggested || suggested === legacyProfileId) return "";

  const storeOauthProfiles = listProfilesForProvider(params.store, providerKey)
    .filter((id) => params.store.profiles[id]?.type === "oauth")
    .join(", ");

  const cfgMode = params.cfg?.auth?.profiles?.[legacyProfileId]?.mode;
  const cfgProvider = params.cfg?.auth?.profiles?.[legacyProfileId]?.provider;

  return [
    "Doctor hint (for GitHub issue):",
    `- provider: ${providerKey}`,
    `- config: ${legacyProfileId}${cfgProvider || cfgMode ? ` (provider=${cfgProvider ?? "?"}, mode=${cfgMode ?? "?"})` : ""}`,
    `- auth store oauth profiles: ${storeOauthProfiles || "(none)"}`,
    `- suggested profile: ${suggested}`,
    'Fix: run "clawdbot doctor --yes"',
  ].join("\n");
}
