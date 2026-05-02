import { resolveOAuthPath } from "../../config/paths.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { loadJsonFile } from "../../infra/json-file.js";
import { normalizeProviderId } from "../provider-id.js";
import { AUTH_STORE_VERSION, log } from "./constants.js";
import {
  hasOAuthIdentity,
  hasUsableOAuthCredential,
  isSafeToAdoptMainStoreOAuthIdentity,
  normalizeAuthEmailToken,
  normalizeAuthIdentityToken,
} from "./oauth-shared.js";
import { resolveAuthStorePath, resolveLegacyAuthStorePath } from "./paths.js";
import {
  coerceAuthProfileState,
  loadPersistedAuthProfileState,
  mergeAuthProfileState,
} from "./state.js";
import type {
  AuthProfileCredential,
  AuthProfileSecretsStore,
  AuthProfileStore,
  OAuthCredential,
  OAuthCredentials,
} from "./types.js";

export type LegacyAuthStore = Record<string, AuthProfileCredential>;

type CredentialRejectReason = "non_object" | "invalid_type" | "missing_provider";
type RejectedCredentialEntry = { key: string; reason: CredentialRejectReason };

const AUTH_PROFILE_TYPES = new Set<AuthProfileCredential["type"]>(["api_key", "oauth", "token"]);

function normalizeSecretBackedField(params: {
  entry: Record<string, unknown>;
  valueField: "key" | "token";
  refField: "keyRef" | "tokenRef";
}): void {
  const value = params.entry[params.valueField];
  if (value == null || typeof value === "string") {
    return;
  }
  const ref = coerceSecretRef(value);
  if (ref && !coerceSecretRef(params.entry[params.refField])) {
    params.entry[params.refField] = ref;
  }
  delete params.entry[params.valueField];
}

function normalizeRawCredentialEntry(raw: Record<string, unknown>): Partial<AuthProfileCredential> {
  const entry = { ...raw } as Record<string, unknown>;
  if (!("type" in entry) && typeof entry["mode"] === "string") {
    entry["type"] = entry["mode"];
  }
  if (!("key" in entry) && typeof entry["apiKey"] === "string") {
    entry["key"] = entry["apiKey"];
  }
  normalizeSecretBackedField({ entry, valueField: "key", refField: "keyRef" });
  normalizeSecretBackedField({ entry, valueField: "token", refField: "tokenRef" });
  return entry as Partial<AuthProfileCredential>;
}

function parseCredentialEntry(
  raw: unknown,
  fallbackProvider?: string,
): { ok: true; credential: AuthProfileCredential } | { ok: false; reason: CredentialRejectReason } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "non_object" };
  }
  const typed = normalizeRawCredentialEntry(raw as Record<string, unknown>);
  if (!AUTH_PROFILE_TYPES.has(typed.type as AuthProfileCredential["type"])) {
    return { ok: false, reason: "invalid_type" };
  }
  const provider = typed.provider ?? fallbackProvider;
  if (typeof provider !== "string" || provider.trim().length === 0) {
    return { ok: false, reason: "missing_provider" };
  }
  return {
    ok: true,
    credential: {
      ...typed,
      provider,
    } as AuthProfileCredential,
  };
}

function warnRejectedCredentialEntries(source: string, rejected: RejectedCredentialEntry[]): void {
  if (rejected.length === 0) {
    return;
  }
  const reasons = rejected.reduce<Partial<Record<CredentialRejectReason, number>>>(
    (acc, current) => {
      acc[current.reason] = (acc[current.reason] ?? 0) + 1;
      return acc;
    },
    {},
  );
  log.warn("ignored invalid auth profile entries during store load", {
    source,
    dropped: rejected.length,
    reasons,
    keys: rejected.slice(0, 10).map((entry) => entry.key),
  });
}

function coerceLegacyAuthStore(raw: unknown): LegacyAuthStore | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if ("profiles" in record) {
    return null;
  }
  const entries: LegacyAuthStore = {};
  const rejected: RejectedCredentialEntry[] = [];
  for (const [key, value] of Object.entries(record)) {
    const parsed = parseCredentialEntry(value, key);
    if (!parsed.ok) {
      rejected.push({ key, reason: parsed.reason });
      continue;
    }
    entries[key] = parsed.credential;
  }
  warnRejectedCredentialEntries("auth.json", rejected);
  return Object.keys(entries).length > 0 ? entries : null;
}

export function coercePersistedAuthProfileStore(raw: unknown): AuthProfileStore | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (!record.profiles || typeof record.profiles !== "object") {
    return null;
  }
  const profiles = record.profiles as Record<string, unknown>;
  const normalized: Record<string, AuthProfileCredential> = {};
  const rejected: RejectedCredentialEntry[] = [];
  for (const [key, value] of Object.entries(profiles)) {
    const parsed = parseCredentialEntry(value);
    if (!parsed.ok) {
      rejected.push({ key, reason: parsed.reason });
      continue;
    }
    normalized[key] = parsed.credential;
  }
  warnRejectedCredentialEntries("auth-profiles.json", rejected);
  return {
    version: Number(record.version ?? AUTH_STORE_VERSION),
    profiles: normalized,
    ...coerceAuthProfileState(record),
  };
}

function mergeRecord<T>(
  base?: Record<string, T>,
  override?: Record<string, T>,
): Record<string, T> | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!base) {
    return { ...override };
  }
  if (!override) {
    return { ...base };
  }
  return { ...base, ...override };
}

function dedupeMergedProfileOrder(profileIds: string[]): string[] {
  return Array.from(new Set(profileIds));
}

function hasComparableOAuthIdentityConflict(
  existing: OAuthCredential,
  candidate: OAuthCredential,
): boolean {
  const existingAccountId = normalizeAuthIdentityToken(existing.accountId);
  const candidateAccountId = normalizeAuthIdentityToken(candidate.accountId);
  if (
    existingAccountId !== undefined &&
    candidateAccountId !== undefined &&
    existingAccountId !== candidateAccountId
  ) {
    return true;
  }

  const existingEmail = normalizeAuthEmailToken(existing.email);
  const candidateEmail = normalizeAuthEmailToken(candidate.email);
  return (
    existingEmail !== undefined && candidateEmail !== undefined && existingEmail !== candidateEmail
  );
}

function isLegacyDefaultOAuthProfile(profileId: string, credential: OAuthCredential): boolean {
  return profileId === `${normalizeProviderId(credential.provider)}:default`;
}

function isNewerUsableOAuthCredential(
  existing: OAuthCredential,
  candidate: OAuthCredential,
): boolean {
  if (!hasUsableOAuthCredential(candidate)) {
    return false;
  }
  if (!hasUsableOAuthCredential(existing)) {
    return true;
  }
  return (
    Number.isFinite(candidate.expires) &&
    (!Number.isFinite(existing.expires) || candidate.expires > existing.expires)
  );
}

function findMainStoreOAuthReplacement(params: {
  base: AuthProfileStore;
  legacyProfileId: string;
  legacyCredential: OAuthCredential;
}): string | undefined {
  const providerKey = normalizeProviderId(params.legacyCredential.provider);
  const candidates = Object.entries(params.base.profiles)
    .flatMap(([profileId, credential]): Array<[string, OAuthCredential]> => {
      if (
        profileId === params.legacyProfileId ||
        credential.type !== "oauth" ||
        normalizeProviderId(credential.provider) !== providerKey
      ) {
        return [];
      }
      return [[profileId, credential]];
    })
    .filter(([, credential]) => isNewerUsableOAuthCredential(params.legacyCredential, credential))
    .toSorted(([leftId, leftCredential], [rightId, rightCredential]) => {
      const leftExpires = Number.isFinite(leftCredential.expires) ? leftCredential.expires : 0;
      const rightExpires = Number.isFinite(rightCredential.expires) ? rightCredential.expires : 0;
      if (rightExpires !== leftExpires) {
        return rightExpires - leftExpires;
      }
      return leftId.localeCompare(rightId);
    });

  const exactIdentityCandidates = candidates.filter(([, credential]) =>
    isSafeToAdoptMainStoreOAuthIdentity(params.legacyCredential, credential),
  );
  if (exactIdentityCandidates.length > 0) {
    if (!hasOAuthIdentity(params.legacyCredential) && exactIdentityCandidates.length > 1) {
      return undefined;
    }
    return exactIdentityCandidates[0]?.[0];
  }

  if (hasUsableOAuthCredential(params.legacyCredential)) {
    return undefined;
  }
  const fallbackCandidates = candidates.filter(
    ([, credential]) => !hasComparableOAuthIdentityConflict(params.legacyCredential, credential),
  );
  if (fallbackCandidates.length !== 1) {
    return undefined;
  }
  return fallbackCandidates[0]?.[0];
}

function replaceMergedProfileReferences(params: {
  store: AuthProfileStore;
  base: AuthProfileStore;
  replacements: Map<string, string>;
}): AuthProfileStore {
  const { store, base, replacements } = params;
  if (replacements.size === 0) {
    return store;
  }

  const profiles = { ...store.profiles };
  for (const [legacyProfileId, replacementProfileId] of replacements) {
    const baseCredential = base.profiles[legacyProfileId];
    if (baseCredential) {
      profiles[legacyProfileId] = baseCredential;
    } else {
      delete profiles[legacyProfileId];
    }
    const replacementBaseCredential = base.profiles[replacementProfileId];
    const replacementCredential = profiles[replacementProfileId];
    if (
      replacementBaseCredential &&
      (!replacementCredential ||
        (replacementCredential.type === "oauth" &&
          replacementBaseCredential.type === "oauth" &&
          isNewerUsableOAuthCredential(replacementCredential, replacementBaseCredential)))
    ) {
      profiles[replacementProfileId] = replacementBaseCredential;
    }
  }

  const order = store.order
    ? Object.fromEntries(
        Object.entries(store.order).map(([provider, profileIds]) => [
          provider,
          dedupeMergedProfileOrder(
            profileIds.map((profileId) => replacements.get(profileId) ?? profileId),
          ),
        ]),
      )
    : undefined;

  const lastGood = store.lastGood
    ? Object.fromEntries(
        Object.entries(store.lastGood).map(([provider, profileId]) => [
          provider,
          replacements.get(profileId) ?? profileId,
        ]),
      )
    : undefined;

  const usageStats = store.usageStats ? { ...store.usageStats } : undefined;
  if (usageStats) {
    for (const legacyProfileId of replacements.keys()) {
      const baseStats = base.usageStats?.[legacyProfileId];
      if (baseStats) {
        usageStats[legacyProfileId] = baseStats;
      } else {
        delete usageStats[legacyProfileId];
      }
    }
  }

  return {
    ...store,
    profiles,
    ...(order && Object.keys(order).length > 0 ? { order } : { order: undefined }),
    ...(lastGood && Object.keys(lastGood).length > 0 ? { lastGood } : { lastGood: undefined }),
    ...(usageStats && Object.keys(usageStats).length > 0
      ? { usageStats }
      : { usageStats: undefined }),
  };
}

function reconcileMainStoreOAuthProfileDrift(params: {
  base: AuthProfileStore;
  override: AuthProfileStore;
  merged: AuthProfileStore;
}): AuthProfileStore {
  const replacements = new Map<string, string>();
  for (const [profileId, credential] of Object.entries(params.override.profiles)) {
    if (credential.type !== "oauth" || !isLegacyDefaultOAuthProfile(profileId, credential)) {
      continue;
    }
    const replacementProfileId = findMainStoreOAuthReplacement({
      base: params.base,
      legacyProfileId: profileId,
      legacyCredential: credential,
    });
    if (replacementProfileId) {
      replacements.set(profileId, replacementProfileId);
    }
  }
  return replaceMergedProfileReferences({
    store: params.merged,
    base: params.base,
    replacements,
  });
}

export function mergeAuthProfileStores(
  base: AuthProfileStore,
  override: AuthProfileStore,
): AuthProfileStore {
  if (
    Object.keys(override.profiles).length === 0 &&
    !override.order &&
    !override.lastGood &&
    !override.usageStats
  ) {
    return base;
  }
  const merged = {
    version: Math.max(base.version, override.version ?? base.version),
    profiles: { ...base.profiles, ...override.profiles },
    order: mergeRecord(base.order, override.order),
    lastGood: mergeRecord(base.lastGood, override.lastGood),
    usageStats: mergeRecord(base.usageStats, override.usageStats),
  };
  return reconcileMainStoreOAuthProfileDrift({ base, override, merged });
}

export function buildPersistedAuthProfileSecretsStore(
  store: AuthProfileStore,
  shouldPersistProfile?: (params: {
    profileId: string;
    credential: AuthProfileCredential;
  }) => boolean,
): AuthProfileSecretsStore {
  const profiles = Object.fromEntries(
    Object.entries(store.profiles).flatMap(([profileId, credential]) => {
      if (shouldPersistProfile && !shouldPersistProfile({ profileId, credential })) {
        return [];
      }
      if (credential.type === "api_key" && credential.keyRef && credential.key !== undefined) {
        const sanitized = { ...credential } as Record<string, unknown>;
        delete sanitized.key;
        return [[profileId, sanitized]];
      }
      if (credential.type === "token" && credential.tokenRef && credential.token !== undefined) {
        const sanitized = { ...credential } as Record<string, unknown>;
        delete sanitized.token;
        return [[profileId, sanitized]];
      }
      return [[profileId, credential]];
    }),
  ) as AuthProfileSecretsStore["profiles"];

  return {
    version: AUTH_STORE_VERSION,
    profiles,
  };
}

export function applyLegacyAuthStore(store: AuthProfileStore, legacy: LegacyAuthStore): void {
  for (const [provider, cred] of Object.entries(legacy)) {
    const profileId = `${provider}:default`;
    const credentialProvider = cred.provider ?? provider;
    if (cred.type === "api_key") {
      store.profiles[profileId] = {
        type: "api_key",
        provider: credentialProvider,
        key: cred.key,
        ...(cred.email ? { email: cred.email } : {}),
      };
      continue;
    }
    if (cred.type === "token") {
      store.profiles[profileId] = {
        type: "token",
        provider: credentialProvider,
        token: cred.token,
        ...(typeof cred.expires === "number" ? { expires: cred.expires } : {}),
        ...(cred.email ? { email: cred.email } : {}),
      };
      continue;
    }
    store.profiles[profileId] = {
      type: "oauth",
      provider: credentialProvider,
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

export function mergeOAuthFileIntoStore(store: AuthProfileStore): boolean {
  const oauthPath = resolveOAuthPath();
  const oauthRaw = loadJsonFile(oauthPath);
  if (!oauthRaw || typeof oauthRaw !== "object") {
    return false;
  }
  const oauthEntries = oauthRaw as Record<string, OAuthCredentials>;
  let mutated = false;
  for (const [provider, creds] of Object.entries(oauthEntries)) {
    if (!creds || typeof creds !== "object") {
      continue;
    }
    const profileId = `${provider}:default`;
    if (store.profiles[profileId]) {
      continue;
    }
    store.profiles[profileId] = {
      type: "oauth",
      provider,
      ...creds,
    };
    mutated = true;
  }
  return mutated;
}

export function loadPersistedAuthProfileStore(agentDir?: string): AuthProfileStore | null {
  const authPath = resolveAuthStorePath(agentDir);
  const raw = loadJsonFile(authPath);
  const store = coercePersistedAuthProfileStore(raw);
  if (!store) {
    return null;
  }
  return {
    ...store,
    ...mergeAuthProfileState(coerceAuthProfileState(raw), loadPersistedAuthProfileState(agentDir)),
  };
}

export function loadLegacyAuthProfileStore(agentDir?: string): LegacyAuthStore | null {
  return coerceLegacyAuthStore(loadJsonFile(resolveLegacyAuthStorePath(agentDir)));
}
