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
import { resolveUserPath } from "../utils.js";
import { resolveClawdbotAgentDir } from "./agent-paths.js";

const AUTH_STORE_VERSION = 1;
const AUTH_PROFILE_FILENAME = "auth-profiles.json";
const LEGACY_AUTH_FILENAME = "auth.json";

export type ApiKeyCredential = {
  type: "api_key";
  provider: string;
  key: string;
  email?: string;
};

export type OAuthCredential = OAuthCredentials & {
  type: "oauth";
  provider: OAuthProvider;
  email?: string;
};

export type AuthProfileCredential = ApiKeyCredential | OAuthCredential;

/** Per-profile usage statistics for round-robin and cooldown tracking */
export type ProfileUsageStats = {
  lastUsed?: number;
  cooldownUntil?: number;
  errorCount?: number;
};

export type AuthProfileStore = {
  version: number;
  profiles: Record<string, AuthProfileCredential>;
  lastGood?: Record<string, string>;
  /** Usage statistics per profile for round-robin rotation */
  usageStats?: Record<string, ProfileUsageStats>;
};

type LegacyAuthStore = Record<string, AuthProfileCredential>;

function resolveAuthStorePath(): string {
  const agentDir = resolveClawdbotAgentDir();
  return path.join(agentDir, AUTH_PROFILE_FILENAME);
}

function resolveLegacyAuthStorePath(): string {
  const agentDir = resolveClawdbotAgentDir();
  return path.join(agentDir, LEGACY_AUTH_FILENAME);
}

function loadJsonFile(pathname: string): unknown {
  try {
    if (!fs.existsSync(pathname)) return undefined;
    const raw = fs.readFileSync(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function saveJsonFile(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(pathname, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.chmodSync(pathname, 0o600);
}

function ensureAuthStoreFile(pathname: string) {
  if (fs.existsSync(pathname)) return;
  const payload: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  saveJsonFile(pathname, payload);
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
}): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const authPath = resolveAuthStorePath();
  ensureAuthStoreFile(authPath);

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(authPath, {
      retries: {
        retries: 10,
        factor: 2,
        minTimeout: 100,
        maxTimeout: 10_000,
        randomize: true,
      },
      stale: 30_000,
    });

    const store = ensureAuthProfileStore();
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
    saveAuthProfileStore(store);
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
    if (typed.type !== "api_key" && typed.type !== "oauth") continue;
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
    if (typed.type !== "api_key" && typed.type !== "oauth") continue;
    if (!typed.provider) continue;
    normalized[key] = typed as AuthProfileCredential;
  }
  return {
    version: Number(record.version ?? AUTH_STORE_VERSION),
    profiles: normalized,
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

export function loadAuthProfileStore(): AuthProfileStore {
  const authPath = resolveAuthStorePath();
  const raw = loadJsonFile(authPath);
  const asStore = coerceAuthStore(raw);
  if (asStore) return asStore;

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
    return store;
  }

  return { version: AUTH_STORE_VERSION, profiles: {} };
}

export function ensureAuthProfileStore(): AuthProfileStore {
  const authPath = resolveAuthStorePath();
  const raw = loadJsonFile(authPath);
  const asStore = coerceAuthStore(raw);
  if (asStore) return asStore;

  const legacyRaw = loadJsonFile(resolveLegacyAuthStorePath());
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
  const shouldWrite = legacy !== null || mergedOAuth;
  if (shouldWrite) {
    saveJsonFile(authPath, store);
  }
  return store;
}

export function saveAuthProfileStore(store: AuthProfileStore): void {
  const authPath = resolveAuthStorePath();
  const payload = {
    version: AUTH_STORE_VERSION,
    profiles: store.profiles,
    lastGood: store.lastGood ?? undefined,
    usageStats: store.usageStats ?? undefined,
  } satisfies AuthProfileStore;
  saveJsonFile(authPath, payload);
}

export function upsertAuthProfile(params: {
  profileId: string;
  credential: AuthProfileCredential;
}): void {
  const store = ensureAuthProfileStore();
  store.profiles[params.profileId] = params.credential;
  saveAuthProfileStore(store);
}

export function listProfilesForProvider(
  store: AuthProfileStore,
  provider: string,
): string[] {
  return Object.entries(store.profiles)
    .filter(([, cred]) => cred.provider === provider)
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
  if (!stats?.cooldownUntil) return false;
  return Date.now() < stats.cooldownUntil;
}

/**
 * Mark a profile as successfully used. Resets error count and updates lastUsed.
 */
export function markAuthProfileUsed(params: {
  store: AuthProfileStore;
  profileId: string;
}): void {
  const { store, profileId } = params;
  if (!store.profiles[profileId]) return;

  store.usageStats = store.usageStats ?? {};
  store.usageStats[profileId] = {
    ...store.usageStats[profileId],
    lastUsed: Date.now(),
    errorCount: 0,
    cooldownUntil: undefined,
  };
  saveAuthProfileStore(store);
}

export function calculateAuthProfileCooldownMs(errorCount: number): number {
  const normalized = Math.max(1, errorCount);
  return Math.min(
    60 * 60 * 1000, // 1 hour max
    60 * 1000 * 5 ** Math.min(normalized - 1, 3),
  );
}

/**
 * Mark a profile as failed/rate-limited. Applies exponential backoff cooldown.
 * Cooldown times: 1min, 5min, 25min, max 1 hour.
 */
export function markAuthProfileCooldown(params: {
  store: AuthProfileStore;
  profileId: string;
}): void {
  const { store, profileId } = params;
  if (!store.profiles[profileId]) return;

  store.usageStats = store.usageStats ?? {};
  const existing = store.usageStats[profileId] ?? {};
  const errorCount = (existing.errorCount ?? 0) + 1;

  // Exponential backoff: 1min, 5min, 25min, capped at 1h
  const backoffMs = calculateAuthProfileCooldownMs(errorCount);

  store.usageStats[profileId] = {
    ...existing,
    errorCount,
    cooldownUntil: Date.now() + backoffMs,
  };
  saveAuthProfileStore(store);
}

/**
 * Clear cooldown for a profile (e.g., manual reset).
 */
export function clearAuthProfileCooldown(params: {
  store: AuthProfileStore;
  profileId: string;
}): void {
  const { store, profileId } = params;
  if (!store.usageStats?.[profileId]) return;

  store.usageStats[profileId] = {
    ...store.usageStats[profileId],
    errorCount: 0,
    cooldownUntil: undefined,
  };
  saveAuthProfileStore(store);
}

export function resolveAuthProfileOrder(params: {
  cfg?: ClawdbotConfig;
  store: AuthProfileStore;
  provider: string;
  preferredProfile?: string;
}): string[] {
  const { cfg, store, provider, preferredProfile } = params;
  const configuredOrder = cfg?.auth?.order?.[provider];
  const explicitProfiles = cfg?.auth?.profiles
    ? Object.entries(cfg.auth.profiles)
        .filter(([, profile]) => profile.provider === provider)
        .map(([profileId]) => profileId)
    : [];
  const baseOrder =
    configuredOrder ??
    (explicitProfiles.length > 0
      ? explicitProfiles
      : listProfilesForProvider(store, provider));
  if (baseOrder.length === 0) return [];

  const filtered = baseOrder.filter((profileId) => {
    const cred = store.profiles[profileId];
    return cred ? cred.provider === provider : true;
  });
  const deduped: string[] = [];
  for (const entry of filtered) {
    if (!deduped.includes(entry)) deduped.push(entry);
  }

  // If user specified explicit order in config, respect it exactly
  if (configuredOrder && configuredOrder.length > 0) {
    // Still put preferredProfile first if specified
    if (preferredProfile && deduped.includes(preferredProfile)) {
      return [
        preferredProfile,
        ...deduped.filter((e) => e !== preferredProfile),
      ];
    }
    return deduped;
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
  // Then by type (oauth preferred over api_key)
  const scored = available.map((profileId) => {
    const type = store.profiles[profileId]?.type;
    const typeScore = type === "oauth" ? 0 : type === "api_key" ? 1 : 2;
    const lastUsed = store.usageStats?.[profileId]?.lastUsed ?? 0;
    return { profileId, typeScore, lastUsed };
  });

  // Primary sort: lastUsed (oldest first for round-robin)
  // Secondary sort: type preference (oauth > api_key)
  const sorted = scored
    .sort((a, b) => {
      // First by lastUsed (oldest first)
      if (a.lastUsed !== b.lastUsed) return a.lastUsed - b.lastUsed;
      // Then by type
      return a.typeScore - b.typeScore;
    })
    .map((entry) => entry.profileId);

  // Append cooldown profiles at the end (sorted by cooldown expiry, soonest first)
  const cooldownSorted = inCooldown
    .map((profileId) => ({
      profileId,
      cooldownUntil: store.usageStats?.[profileId]?.cooldownUntil ?? now,
    }))
    .sort((a, b) => a.cooldownUntil - b.cooldownUntil)
    .map((entry) => entry.profileId);

  return [...sorted, ...cooldownSorted];
}

export async function resolveApiKeyForProfile(params: {
  cfg?: ClawdbotConfig;
  store: AuthProfileStore;
  profileId: string;
}): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred) return null;
  const profileConfig = cfg?.auth?.profiles?.[profileId];
  if (profileConfig && profileConfig.provider !== cred.provider) return null;
  if (profileConfig && profileConfig.mode !== cred.type) return null;

  if (cred.type === "api_key") {
    return { apiKey: cred.key, provider: cred.provider, email: cred.email };
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
    });
    if (!result) return null;
    return {
      apiKey: result.apiKey,
      provider: cred.provider,
      email: cred.email,
    };
  } catch (error) {
    const refreshedStore = ensureAuthProfileStore();
    const refreshed = refreshedStore.profiles[profileId];
    if (refreshed?.type === "oauth" && Date.now() < refreshed.expires) {
      return {
        apiKey: buildOAuthApiKey(refreshed.provider, refreshed),
        provider: refreshed.provider,
        email: refreshed.email ?? cred.email,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OAuth token refresh failed for ${cred.provider}: ${message}. ` +
        "Please try again or re-authenticate.",
    );
  }
}

export function markAuthProfileGood(params: {
  store: AuthProfileStore;
  provider: string;
  profileId: string;
}): void {
  const { store, provider, profileId } = params;
  const profile = store.profiles[profileId];
  if (!profile || profile.provider !== provider) return;
  store.lastGood = { ...store.lastGood, [provider]: profileId };
  saveAuthProfileStore(store);
}

export function resolveAuthStorePathForDisplay(): string {
  const pathname = resolveAuthStorePath();
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
