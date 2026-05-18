import { createHash } from "node:crypto";
import { resolveOAuthPath } from "../../config/paths.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { loadJsonFile } from "../../infra/json-file.js";
import { normalizeProviderId } from "../provider-id.js";
import { AUTH_STORE_VERSION, log } from "./constants.js";
import {
  isLegacyOAuthRef,
  loadLegacyOAuthSidecarMaterial,
  type LegacyOAuthSecretMaterial,
} from "./legacy-oauth-sidecar.js";
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
  AuthProfileFailureReason,
  AuthProfileSecretsStore,
  AuthProfileStore,
  OAuthCredential,
  OAuthCredentials,
  ProfileUsageStats,
} from "./types.js";

export type LegacyAuthStore = Record<string, AuthProfileCredential>;

type LoadPersistedAuthProfileStoreOptions = {
  allowKeychainPrompt?: boolean;
  resolveLegacyOAuthSidecars?: boolean;
};

type CredentialRejectReason = "non_object" | "invalid_type" | "missing_provider";
type RejectedCredentialEntry = { key: string; reason: CredentialRejectReason };

const AUTH_PROFILE_TYPES = new Set<AuthProfileCredential["type"]>(["api_key", "oauth", "token"]);
const LEGACY_OAUTH_REF_PROVIDER = "openai-codex";
const runtimeLegacyOAuthSidecarCredentials = new WeakSet<OAuthCredential>();
const runtimeLegacyOAuthSidecarMaterialFingerprints = new Map<string, string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalCredentialString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? value : undefined;
}

function hasInlineOAuthTokenMaterial(credential: OAuthCredential): boolean {
  return [credential.access, credential.refresh, credential.idToken].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

function buildRuntimeLegacyOAuthSidecarFingerprintKey(params: {
  storeKey?: string;
  profileId: string;
}): string {
  return `${params.storeKey ?? ""}\0${params.profileId}`;
}

function buildLegacyOAuthSecretMaterialFingerprint(
  material: Pick<OAuthCredential, "access" | "refresh" | "idToken">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([material.access ?? null, material.refresh ?? null, material.idToken ?? null]),
    )
    .digest("hex");
}

function normalizeOptionalCredentialBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeExpiryField(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeCredentialMetadata(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      metadata[key] = entry;
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

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

function normalizeCommonCredentialFields(entry: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    provider: typeof entry.provider === "string" ? normalizeProviderId(entry.provider) : "",
  };
  const copyToAgents = normalizeOptionalCredentialBoolean(entry.copyToAgents);
  if (copyToAgents !== undefined) {
    normalized.copyToAgents = copyToAgents;
  }
  const email = normalizeOptionalCredentialString(entry.email);
  if (email !== undefined) {
    normalized.email = email;
  }
  const displayName = normalizeOptionalCredentialString(entry.displayName);
  if (displayName !== undefined) {
    normalized.displayName = displayName;
  }
  return normalized;
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
  if (entry.type === "api_key") {
    const normalized: Record<string, unknown> = {
      type: "api_key",
      ...normalizeCommonCredentialFields(entry),
    };
    const key = normalizeOptionalCredentialString(entry.key);
    const keyRef = coerceSecretRef(entry.keyRef);
    const metadata = normalizeCredentialMetadata(entry.metadata);
    if (key !== undefined) {
      normalized.key = key;
    }
    if (keyRef) {
      normalized.keyRef = keyRef;
    }
    if (metadata) {
      normalized.metadata = metadata;
    }
    return normalized as Partial<AuthProfileCredential>;
  }
  if (entry.type === "token") {
    const normalized: Record<string, unknown> = {
      type: "token",
      ...normalizeCommonCredentialFields(entry),
    };
    const token = normalizeOptionalCredentialString(entry.token);
    const tokenRef = coerceSecretRef(entry.tokenRef);
    const expires = normalizeExpiryField(entry.expires);
    if (token !== undefined) {
      normalized.token = token;
    }
    if (tokenRef) {
      normalized.tokenRef = tokenRef;
    }
    if (expires !== undefined) {
      normalized.expires = expires;
    }
    return normalized as Partial<AuthProfileCredential>;
  }
  if (entry.type === "oauth") {
    const normalized: Record<string, unknown> = {
      type: "oauth",
      ...normalizeCommonCredentialFields(entry),
    };
    for (const field of [
      "access",
      "refresh",
      "idToken",
      "clientId",
      "enterpriseUrl",
      "projectId",
      "accountId",
      "chatgptPlanType",
    ] as const) {
      const value = normalizeOptionalCredentialString(entry[field]);
      if (value !== undefined) {
        normalized[field] = value;
      }
    }
    const expires = normalizeExpiryField(entry.expires);
    if (expires !== undefined) {
      normalized.expires = expires;
    }
    return normalized;
  }
  return entry as Partial<AuthProfileCredential>;
}

function parseCredentialEntry(
  raw: unknown,
  fallbackProvider?: string,
): { ok: true; credential: AuthProfileCredential } | { ok: false; reason: CredentialRejectReason } {
  if (!isRecord(raw)) {
    return { ok: false, reason: "non_object" };
  }
  const typed = normalizeRawCredentialEntry(raw);
  if (!AUTH_PROFILE_TYPES.has(typed.type as AuthProfileCredential["type"])) {
    return { ok: false, reason: "invalid_type" };
  }
  const provider = typed.provider ?? fallbackProvider;
  const normalizedProvider = typeof provider === "string" ? normalizeProviderId(provider) : "";
  if (!normalizedProvider) {
    return { ok: false, reason: "missing_provider" };
  }
  return {
    ok: true,
    credential: {
      ...typed,
      provider: normalizedProvider,
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

function resolveLegacyOAuthSidecarCredential(params: {
  profileId: string;
  raw: unknown;
  credential: AuthProfileCredential;
  storeKey?: string;
  options?: LoadPersistedAuthProfileStoreOptions;
}): AuthProfileCredential {
  if (
    params.credential.type !== "oauth" ||
    normalizeProviderId(params.credential.provider) !== LEGACY_OAUTH_REF_PROVIDER ||
    hasInlineOAuthTokenMaterial(params.credential) ||
    !isRecord(params.raw) ||
    !isLegacyOAuthRef(params.raw.oauthRef)
  ) {
    return params.credential;
  }
  // Read-only compatibility for #79006 sidecar OAuth profiles. Do not add
  // new writers or OS-level Keychain creation here; doctor remains the path
  // that migrates users back to canonical inline OAuth credentials.
  const material = loadLegacyOAuthSidecarMaterial({
    ref: params.raw.oauthRef,
    profileId: params.profileId,
    provider: params.credential.provider,
    allowKeychainPrompt: params.options?.allowKeychainPrompt,
  });
  if (!material) {
    return params.credential;
  }
  const credential = {
    ...params.credential,
    ...(material.access ? { access: material.access } : {}),
    ...(material.refresh ? { refresh: material.refresh } : {}),
    ...(material.idToken ? { idToken: material.idToken } : {}),
  };
  runtimeLegacyOAuthSidecarCredentials.add(credential);
  runtimeLegacyOAuthSidecarMaterialFingerprints.set(
    buildRuntimeLegacyOAuthSidecarFingerprintKey({
      storeKey: params.storeKey,
      profileId: params.profileId,
    }),
    buildLegacyOAuthSecretMaterialFingerprint(credential),
  );
  return credential;
}

export function isRuntimeLegacyOAuthSidecarCredential(
  credential: AuthProfileCredential | undefined,
): boolean {
  return credential?.type === "oauth" && runtimeLegacyOAuthSidecarCredentials.has(credential);
}

export function matchesRuntimeLegacyOAuthSidecarMaterial(params: {
  authPath?: string;
  profileId: string;
  credential: AuthProfileCredential | undefined;
}): boolean {
  if (params.credential?.type !== "oauth") {
    return false;
  }
  if (runtimeLegacyOAuthSidecarCredentials.has(params.credential)) {
    return true;
  }
  const fingerprint = runtimeLegacyOAuthSidecarMaterialFingerprints.get(
    buildRuntimeLegacyOAuthSidecarFingerprintKey({
      storeKey: params.authPath,
      profileId: params.profileId,
    }),
  );
  return (
    fingerprint !== undefined &&
    fingerprint === buildLegacyOAuthSecretMaterialFingerprint(params.credential)
  );
}

function coerceLegacyAuthStore(raw: unknown): LegacyAuthStore | null {
  if (!isRecord(raw)) {
    return null;
  }
  const record = raw;
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

export function coercePersistedAuthProfileStore(
  raw: unknown,
  options?: LoadPersistedAuthProfileStoreOptions,
  storeKey?: string,
): AuthProfileStore | null {
  if (!isRecord(raw)) {
    return null;
  }
  const record = raw;
  if (!isRecord(record.profiles)) {
    return null;
  }
  const profiles = record.profiles;
  const normalized: Record<string, AuthProfileCredential> = {};
  const rejected: RejectedCredentialEntry[] = [];
  for (const [key, value] of Object.entries(profiles)) {
    const parsed = parseCredentialEntry(value);
    if (!parsed.ok) {
      rejected.push({ key, reason: parsed.reason });
      continue;
    }
    normalized[key] =
      options?.resolveLegacyOAuthSidecars === true
        ? resolveLegacyOAuthSidecarCredential({
            profileId: key,
            raw: value,
            credential: parsed.credential,
            storeKey,
            options,
          })
        : parsed.credential;
  }
  warnRejectedCredentialEntries("auth-profiles.json", rejected);
  const version = Number(record.version ?? AUTH_STORE_VERSION);
  return {
    version: Number.isFinite(version) && version > 0 ? version : AUTH_STORE_VERSION,
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

const AUTH_INVALIDATION_REASONS = new Set<AuthProfileFailureReason>([
  "auth",
  "auth_permanent",
  "session_expired",
]);

function hasAuthInvalidationSignal(stats: ProfileUsageStats | undefined): boolean {
  if (!stats) {
    return false;
  }
  if (
    (stats.cooldownReason && AUTH_INVALIDATION_REASONS.has(stats.cooldownReason)) ||
    (stats.disabledReason && AUTH_INVALIDATION_REASONS.has(stats.disabledReason))
  ) {
    return true;
  }
  return Object.entries(stats.failureCounts ?? {}).some(
    ([reason, count]) =>
      AUTH_INVALIDATION_REASONS.has(reason as AuthProfileFailureReason) &&
      typeof count === "number" &&
      count > 0,
  );
}

function isProfileReferencedByAuthState(store: AuthProfileStore, profileId: string): boolean {
  if (Object.values(store.order ?? {}).some((profileIds) => profileIds.includes(profileId))) {
    return true;
  }
  return Object.values(store.lastGood ?? {}).some((value) => value === profileId);
}

function resolveProviderAuthStateValue<T>(
  values: Record<string, T> | undefined,
  providerKey: string,
): T | undefined {
  if (!values) {
    return undefined;
  }
  for (const [key, value] of Object.entries(values)) {
    if (normalizeProviderId(key) === providerKey) {
      return value;
    }
  }
  return undefined;
}

function findMainStoreOAuthReplacementForInvalidatedProfile(params: {
  base: AuthProfileStore;
  override: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
}): string | undefined {
  const providerKey = normalizeProviderId(params.credential.provider);
  if (
    providerKey !== "openai-codex" ||
    !isProfileReferencedByAuthState(params.override, params.profileId) ||
    !hasAuthInvalidationSignal(params.override.usageStats?.[params.profileId])
  ) {
    return undefined;
  }

  const candidates = Object.entries(params.base.profiles)
    .flatMap(([profileId, credential]): Array<[string, OAuthCredential]> => {
      if (
        profileId === params.profileId ||
        credential.type !== "oauth" ||
        normalizeProviderId(credential.provider) !== providerKey ||
        !hasUsableOAuthCredential(credential)
      ) {
        return [];
      }
      return [[profileId, credential]];
    })
    .toSorted(([leftId, leftCredential], [rightId, rightCredential]) => {
      const leftExpires = Number.isFinite(leftCredential.expires) ? leftCredential.expires : 0;
      const rightExpires = Number.isFinite(rightCredential.expires) ? rightCredential.expires : 0;
      if (rightExpires !== leftExpires) {
        return rightExpires - leftExpires;
      }
      return leftId.localeCompare(rightId);
    });
  if (candidates.length === 0) {
    return undefined;
  }

  const candidateIds = new Set(candidates.map(([profileId]) => profileId));
  const orderedProfileId = resolveProviderAuthStateValue(params.base.order, providerKey)?.find(
    (profileId) => candidateIds.has(profileId),
  );
  if (orderedProfileId) {
    return orderedProfileId;
  }

  const lastGoodProfileId = resolveProviderAuthStateValue(params.base.lastGood, providerKey);
  if (lastGoodProfileId && candidateIds.has(lastGoodProfileId)) {
    return lastGoodProfileId;
  }

  return candidates.length === 1 ? candidates[0]?.[0] : undefined;
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
    if (credential.type !== "oauth") {
      continue;
    }
    const replacementProfileId = isLegacyDefaultOAuthProfile(profileId, credential)
      ? findMainStoreOAuthReplacement({
          base: params.base,
          legacyProfileId: profileId,
          legacyCredential: credential,
        })
      : findMainStoreOAuthReplacementForInvalidatedProfile({
          base: params.base,
          override: params.override,
          profileId,
          credential,
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
  options?: {
    existingRaw?: unknown;
    runtimeLegacyOAuthSidecarProfileIds?: ReadonlySet<string>;
  },
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

  const payload: AuthProfileSecretsStore = {
    version: AUTH_STORE_VERSION,
    profiles,
  };
  return preserveLegacyOAuthRefsForDoctorMigration(payload, options);
}

function preserveLegacyOAuthRefsForDoctorMigration(
  payload: AuthProfileSecretsStore,
  options:
    | {
        existingRaw?: unknown;
        runtimeLegacyOAuthSidecarProfileIds?: ReadonlySet<string>;
      }
    | undefined,
): AuthProfileSecretsStore {
  const existingRaw = options?.existingRaw;
  if (!isRecord(existingRaw) || !isRecord(existingRaw.profiles)) {
    return payload;
  }
  let profiles: AuthProfileSecretsStore["profiles"] | undefined;
  for (const [profileId, rawProfile] of Object.entries(existingRaw.profiles)) {
    if (!isRecord(rawProfile) || !isLegacyOAuthRef(rawProfile.oauthRef)) {
      continue;
    }
    const credential = payload.profiles[profileId];
    if (
      credential?.type !== "oauth" ||
      normalizeProviderId(credential.provider) !== LEGACY_OAUTH_REF_PROVIDER
    ) {
      continue;
    }
    if (hasInlineOAuthTokenMaterial(credential)) {
      const isRuntimeSidecarMaterial =
        options?.runtimeLegacyOAuthSidecarProfileIds?.has(profileId) === true;
      // Untracked inline material may be a real token refresh. Only reread the
      // sidecar then, and never use Keychain from this save-path check.
      if (
        !isRuntimeSidecarMaterial &&
        !isUnchangedLegacyOAuthSidecarMaterial({ profileId, rawProfile, credential })
      ) {
        continue;
      }
    }
    // Removal-only retention for #79006: ordinary runtime saves must not turn
    // rehydrated sidecar tokens into inline credentials. Doctor remains the
    // explicit migration path that creates backups and removes sidecars.
    profiles ??= { ...payload.profiles };
    const sanitized = { ...credential } as Record<string, unknown>;
    delete sanitized.access;
    delete sanitized.refresh;
    delete sanitized.idToken;
    profiles[profileId] = {
      ...sanitized,
      oauthRef: rawProfile.oauthRef,
    } as unknown as AuthProfileCredential;
  }
  return profiles ? { ...payload, profiles } : payload;
}

function isUnchangedLegacyOAuthSidecarMaterial(params: {
  profileId: string;
  rawProfile: Record<string, unknown>;
  credential: OAuthCredential;
}): boolean {
  if (!isLegacyOAuthRef(params.rawProfile.oauthRef)) {
    return false;
  }
  const material = loadLegacyOAuthSidecarMaterial({
    ref: params.rawProfile.oauthRef,
    profileId: params.profileId,
    provider: params.credential.provider,
    allowKeychainPrompt: false,
  });
  if (!material) {
    return false;
  }
  return isSameLegacyOAuthSecretMaterial(params.credential, material);
}

function isSameLegacyOAuthSecretMaterial(
  credential: OAuthCredential,
  material: LegacyOAuthSecretMaterial,
): boolean {
  return (["access", "refresh", "idToken"] as const).every(
    (field) => (credential[field] ?? undefined) === (material[field] ?? undefined),
  );
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

export function loadPersistedAuthProfileStore(
  agentDir?: string,
  options?: LoadPersistedAuthProfileStoreOptions,
): AuthProfileStore | null {
  const authPath = resolveAuthStorePath(agentDir);
  const raw = loadJsonFile(authPath);
  const store = coercePersistedAuthProfileStore(raw, options, authPath);
  if (!store) {
    return null;
  }
  const merged = {
    ...store,
    ...mergeAuthProfileState(coerceAuthProfileState(raw), loadPersistedAuthProfileState(agentDir)),
  };
  return merged;
}

export function loadLegacyAuthProfileStore(agentDir?: string): LegacyAuthStore | null {
  return coerceLegacyAuthStore(loadJsonFile(resolveLegacyAuthStorePath(agentDir)));
}
