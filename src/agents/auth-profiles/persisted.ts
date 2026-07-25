/**
 * Persisted auth profile store loading and migration.
 * Normalizes legacy JSON stores, SQLite/raw payloads, runtime state metadata,
 * legacy OAuth files, and merged main/agent stores.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveOAuthPath } from "../../config/paths.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { loadJsonFile } from "../../infra/json-file.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { asBoolean } from "../../utils/boolean.js";
import { AUTH_STORE_VERSION, log } from "./constants.js";
import { isLegacyOAuthRef } from "./legacy-oauth-ref.js";
import {
  hasOAuthIdentity,
  hasUsableOAuthCredential,
  isSafeToAdoptMainStoreOAuthIdentity,
  normalizeAuthEmailToken,
  normalizeAuthIdentityToken,
} from "./oauth-shared.js";
import { resolveLegacyAuthStorePath } from "./paths.js";
import { readPersistedAuthProfileStoreRaw } from "./sqlite.js";
import {
  coerceAuthProfileState,
  loadPersistedAuthProfileState,
  mergeAuthProfileState,
} from "./state.js";
import type {
  AuthProfileCredential,
  AuthProfileSecretsStore,
  AuthProfileStore,
  RuntimeAuthProfileStore,
  OAuthCredential,
  OAuthCredentials,
} from "./types.js";

/** Legacy auth.json store shape before auth-profiles.json/SQLite. */
type LegacyAuthStore = Record<string, AuthProfileCredential>;

type LoadPersistedAuthProfileStoreOptions = {
  allowKeychainPrompt?: boolean;
  database?: OpenClawAgentDatabase;
};

type CredentialRejectReason = "non_object" | "invalid_type" | "missing_provider";
type RejectedCredentialEntry = { key: string; reason: CredentialRejectReason };

const AUTH_PROFILE_TYPES = new Set<AuthProfileCredential["type"]>(["api_key", "oauth", "token"]);

// Persisted credential normalization accepts old field names and SecretRef-ish
// values, then emits the current credential discriminated union.
function normalizeOptionalCredentialString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? value : undefined;
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

// Secret-backed key/token fields may have been stored in the value field by old
// writers. Move them to the ref field so secret values are not treated as text.
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
  const copyToAgents = asBoolean(entry.copyToAgents);
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
  if (entry.type === "apiKey") {
    entry.type = "api_key";
  }
  if (
    !("key" in entry) &&
    !coerceSecretRef(entry["keyRef"]) &&
    typeof entry["apiKey"] === "string"
  ) {
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
    if (keyRef) {
      normalized.keyRef = keyRef;
    } else if (key !== undefined) {
      normalized.key = key;
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
    if (isLegacyOAuthRef(entry.oauthRef)) {
      normalized.oauthRef = entry.oauthRef;
    }
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
  const provider = typed.provider || fallbackProvider;
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

/** Normalizes a single legacy credential entry into a canonical credential. */
export function parseLegacyCredentialEntry(
  raw: unknown,
  fallbackProvider?: string,
): AuthProfileCredential | null {
  const parsed = parseCredentialEntry(raw, fallbackProvider);
  return parsed.ok ? parsed.credential : null;
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
    ...(reasons.invalid_type ? { validTypes: [...AUTH_PROFILE_TYPES] } : {}),
    keys: rejected.slice(0, 10).map((entry) => entry.key),
  });
}

export function coerceLegacyAuthStore(raw: unknown): LegacyAuthStore | null {
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

/** Coerces a persisted auth profile store payload into the current store shape. */
export function coercePersistedAuthProfileStore(raw: unknown): AuthProfileStore | null {
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
    normalized[key] = parsed.credential;
  }
  warnRejectedCredentialEntries("auth-profiles.json", rejected);
  const version = Number(record.version ?? AUTH_STORE_VERSION);
  return {
    version: Number.isFinite(version) && version > 0 ? version : AUTH_STORE_VERSION,
    profiles: normalized,
    ...coerceAuthProfileState(record),
  };
}

// Merge store/state records by key. Undefined means "no persisted record", not
// "empty override", so preserve the other side in that case.
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
  return uniqueStrings(profileIds);
}

function groupProfileIdsByProvider(profiles: AuthProfileStore["profiles"]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const [profileId, credential] of Object.entries(profiles)) {
    const providerKey = normalizeProviderId(credential.provider);
    grouped.set(providerKey, [...(grouped.get(providerKey) ?? []), profileId]);
  }
  return grouped;
}

function findOrderEntryKey(
  order: AuthProfileStore["order"] | undefined,
  providerKey: string,
): string | undefined {
  return Object.keys(order ?? {}).find((key) => normalizeProviderId(key) === providerKey);
}

function mergeProfileRecordsWithOverridePrecedence(
  base: AuthProfileStore["profiles"],
  override: AuthProfileStore["profiles"],
): AuthProfileStore["profiles"] {
  const overrideProfileIds = new Set(Object.keys(override));
  return Object.fromEntries([
    ...Object.entries(override),
    ...Object.entries(base).filter(([profileId]) => !overrideProfileIds.has(profileId)),
  ]);
}

function mergeProfileOrderWithOverridePrecedence(params: {
  baseOrder: AuthProfileStore["order"] | undefined;
  overrideOrder: AuthProfileStore["order"] | undefined;
  overrideProfiles: AuthProfileStore["profiles"];
}): AuthProfileStore["order"] | undefined {
  const mergedOrder = mergeRecord(params.baseOrder, params.overrideOrder);
  if (!mergedOrder) {
    return undefined;
  }

  for (const [providerKey, overrideProfileIds] of groupProfileIdsByProvider(
    params.overrideProfiles,
  )) {
    const baseOrderKey = findOrderEntryKey(params.baseOrder, providerKey);
    const overrideOrderKey = findOrderEntryKey(params.overrideOrder, providerKey);
    const mergedOrderKey = overrideOrderKey ?? baseOrderKey;
    if (!mergedOrderKey) {
      continue;
    }
    for (const provider of Object.keys(mergedOrder)) {
      if (provider !== mergedOrderKey && normalizeProviderId(provider) === providerKey) {
        delete mergedOrder[provider];
      }
    }
    if (overrideOrderKey) {
      mergedOrder[mergedOrderKey] = dedupeMergedProfileOrder(
        params.overrideOrder?.[overrideOrderKey] ?? [],
      );
      continue;
    }
    const baseOrderIds = baseOrderKey ? (params.baseOrder?.[baseOrderKey] ?? []) : [];
    mergedOrder[mergedOrderKey] = dedupeMergedProfileOrder([
      ...overrideProfileIds,
      ...baseOrderIds,
      ...(mergedOrder[mergedOrderKey] ?? []),
    ]);
  }

  return mergedOrder;
}

// Legacy OAuth profiles may be replaced by safer main-store profiles when the
// main store has a newer compatible credential for the same provider identity.
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
    if (credential.type !== "oauth") {
      continue;
    }
    const replacementProfileId = isLegacyDefaultOAuthProfile(profileId, credential)
      ? findMainStoreOAuthReplacement({
          base: params.base,
          legacyProfileId: profileId,
          legacyCredential: credential,
        })
      : undefined;
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

/** Merges two auth profile stores, preserving valid runtime external profile metadata. */
export function mergeAuthProfileStores(
  base: RuntimeAuthProfileStore,
  override: RuntimeAuthProfileStore,
  options?: { preserveBaseRuntimeExternalProfiles?: boolean },
): RuntimeAuthProfileStore {
  if (
    Object.keys(override.profiles).length === 0 &&
    !override.order &&
    !override.lastGood &&
    !override.usageStats &&
    override.runtimePersistedProfileIds === undefined &&
    override.runtimeLocalProfileIds === undefined &&
    override.runtimeInheritsMainState === undefined &&
    override.runtimeExternalProfileIds === undefined &&
    override.runtimeExternalProfileIdsAuthoritative !== true
  ) {
    return base;
  }
  const overrideProfileIds = new Set(Object.keys(override.profiles));
  const overrideRuntimeExternalProfileIds = new Set(override.runtimeExternalProfileIds ?? []);
  const removedRuntimeExternalProfileIds = new Set(
    override.runtimeExternalProfileIdsAuthoritative === true &&
      options?.preserveBaseRuntimeExternalProfiles !== true
      ? (base.runtimeExternalProfileIds ?? []).filter(
          (profileId) =>
            !overrideRuntimeExternalProfileIds.has(profileId) && !overrideProfileIds.has(profileId),
        )
      : [],
  );
  const profiles = mergeProfileRecordsWithOverridePrecedence(base.profiles, override.profiles);
  // Authoritative runtime snapshots may remove stale external profiles that are
  // no longer observed, unless the caller is intentionally preserving base ones.
  for (const profileId of removedRuntimeExternalProfileIds) {
    delete profiles[profileId];
  }
  const mergedOrder = mergeProfileOrderWithOverridePrecedence({
    baseOrder: base.order,
    overrideOrder: override.order,
    overrideProfiles: override.profiles,
  });
  const order = mergedOrder
    ? Object.fromEntries(
        Object.entries(mergedOrder)
          .map(([provider, profileIds]) => [
            provider,
            profileIds.filter(
              (profileId) =>
                profiles[profileId] || !removedRuntimeExternalProfileIds.has(profileId),
            ),
          ])
          .filter(([, profileIds]) => Array.isArray(profileIds) && profileIds.length > 0),
      )
    : undefined;
  const mergedLastGood = mergeRecord(base.lastGood, override.lastGood);
  const lastGood = mergedLastGood
    ? Object.fromEntries(
        Object.entries(mergedLastGood).filter(([, profileId]) => profiles[profileId]),
      )
    : undefined;
  const mergedUsageStats = mergeRecord(base.usageStats, override.usageStats);
  const usageStats = mergedUsageStats
    ? Object.fromEntries(
        Object.entries(mergedUsageStats).filter(([profileId]) => profiles[profileId]),
      )
    : undefined;
  const merged = {
    version: Math.max(base.version, override.version ?? base.version),
    profiles,
    order,
    lastGood,
    usageStats,
  };
  const runtimePersistedProfileIds = [
    ...(base.runtimePersistedProfileIds ?? []).filter(
      (profileId) => !overrideProfileIds.has(profileId),
    ),
    ...(override.runtimePersistedProfileIds ?? []),
  ]
    .filter((profileId) => merged.profiles[profileId])
    .toSorted();
  const runtimeLocalProfileIds = override.runtimeLocalProfileIds
    ?.filter((profileId) => merged.profiles[profileId])
    .toSorted();
  const baseRuntimeExternalProfileIds =
    override.runtimeExternalProfileIdsAuthoritative === true &&
    options?.preserveBaseRuntimeExternalProfiles !== true
      ? []
      : (base.runtimeExternalProfileIds ?? []).filter(
          (profileId) => !overrideProfileIds.has(profileId),
        );
  const runtimeExternalProfileIds = [
    ...baseRuntimeExternalProfileIds,
    ...(override.runtimeExternalProfileIds ?? []),
  ]
    .filter((profileId) => merged.profiles[profileId])
    .toSorted();
  const runtimeExternalProfileIdsAuthoritative =
    base.runtimeExternalProfileIdsAuthoritative === true ||
    override.runtimeExternalProfileIdsAuthoritative === true;
  const runtimeExternalProfileMetadata =
    runtimeExternalProfileIds.length > 0 || runtimeExternalProfileIdsAuthoritative
      ? {
          runtimeExternalProfileIds: [...new Set(runtimeExternalProfileIds)],
          ...(runtimeExternalProfileIdsAuthoritative
            ? { runtimeExternalProfileIdsAuthoritative: true }
            : {}),
        }
      : {};
  return reconcileMainStoreOAuthProfileDrift({
    base,
    override,
    merged: {
      ...merged,
      ...(runtimePersistedProfileIds.length > 0
        ? { runtimePersistedProfileIds: [...new Set(runtimePersistedProfileIds)] }
        : {}),
      ...(runtimeLocalProfileIds ? { runtimeLocalProfileIds } : {}),
      ...(override.runtimeInheritsMainState !== undefined
        ? { runtimeInheritsMainState: override.runtimeInheritsMainState }
        : {}),
      ...runtimeExternalProfileMetadata,
    },
  }) as RuntimeAuthProfileStore;
}

/** Builds the persisted secrets store, stripping resolved literals when refs exist. */
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

/** Applies legacy auth.json credentials into an auth profile store. */
export function applyLegacyAuthStore(store: AuthProfileStore, legacy: LegacyAuthStore): void {
  for (const [provider, cred] of Object.entries(legacy)) {
    store.profiles[`${provider}:default`] = {
      ...cred,
      provider: cred.provider ?? provider,
    };
  }
}

/** Imports the legacy oauth.json file into missing default OAuth profiles. */
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

/** Loads the persisted auth profile store and merges runtime state. */
export function loadPersistedAuthProfileStore(
  agentDir?: string,
  options?: LoadPersistedAuthProfileStoreOptions,
): AuthProfileStore | null {
  const raw = readPersistedAuthProfileStoreRaw(agentDir, options?.database);
  const store = coercePersistedAuthProfileStore(raw);
  if (!store) {
    return null;
  }
  const merged = {
    ...store,
    ...mergeAuthProfileState(
      coerceAuthProfileState(raw),
      loadPersistedAuthProfileState(agentDir, options?.database),
    ),
  };
  return merged;
}

/** Loads the legacy auth.json auth profile store if present. */
export function loadLegacyAuthProfileStore(agentDir?: string): LegacyAuthStore | null {
  return coerceLegacyAuthStore(loadJsonFile(resolveLegacyAuthStorePath(agentDir)));
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
