import { createHash } from "node:crypto";
/** Doctor repairs for legacy auth profile JSON stores and OpenAI provider-id migrations. */
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString as readNonEmptyString } from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import {
  clearAuthProfileMigrationDiagnostics,
  listLegacyAuthProfileArchives,
  resolveLegacyOAuthPath,
} from "../agents/auth-profiles/legacy-source-diagnostic.js";
import {
  areOAuthCredentialsEquivalent,
  hasMatchingOAuthIdentity,
} from "../agents/auth-profiles/oauth-shared.js";
import { isInheritedMainOAuthCredentialFromStores } from "../agents/auth-profiles/ownership.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "../agents/auth-profiles/path-resolve.js";
import {
  applyLegacyAuthStore,
  coerceLegacyAuthStore,
  coercePersistedAuthProfileStore,
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
  parseLegacyCredentialEntry,
} from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import {
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  inspectPersistedSharedAuthProfileStateRaw,
  inspectPersistedSharedAuthProfileStoreRaw,
  readPersistedAuthProfileStateRaw,
  readPersistedSharedAuthProfileStateRaw,
  resolveAuthProfileDatabasePath,
  runAuthProfileWriteTransaction,
  type AuthProfileDatabase,
} from "../agents/auth-profiles/sqlite.js";
import { coerceAuthProfileState } from "../agents/auth-profiles/state.js";
import { saveAuthProfileStoreWithPreparedOwner } from "../agents/auth-profiles/store.js";
import type {
  AuthProfileCredential,
  AuthProfileState,
  AuthProfileStore,
} from "../agents/auth-profiles/types.js";
import { resolveLegacyInheritedAuthAgentDir } from "../agents/legacy-inherited-auth-dir.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { AuthProfileConfig } from "../config/types.auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { loadJsonFileThroughSymlink } from "../infra/json-file.js";
import { readLegacyMigrationReceipt } from "../infra/state-migrations.receipts.js";
import { shortenHomePath } from "../utils.js";
import {
  listAuthProfileRepairCandidates,
  resolveLegacyAuthProfilesPath as resolveAuthStorePath,
  resolveLegacyAuthStatePath as resolveAuthStatePath,
  resolveLegacyFlatAuthPath as resolveLegacyAuthStorePath,
  type AuthProfileRepairCandidate,
} from "./doctor-auth-legacy-paths.js";
import {
  acquireAuthProfileMigrationSourceLocks,
  archiveAuthProfileMigrationSource,
  createAuthProfileMigrationSourceReceipt,
  digestAuthProfileMigrationValue,
  finalizeAuthProfileMigrationSource,
  hasTerminalAuthProfileMigrationReceipt,
  resumePendingAuthProfileMigrationArchives,
  type AuthProfileMigrationSourceReceipt,
} from "./doctor-auth-migration-receipts.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type AuthProfileSqliteMigrationCandidate = AuthProfileRepairCandidate & {
  statePath: string;
  legacyPath: string;
};

function resolveMigrationTargetDatabasePath(
  agentDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return agentDir ? resolveAuthProfileDatabasePath(agentDir) : resolveSharedAuthStorePath(env);
}

type AwsSdkProfileMarker = {
  profileId: string;
  provider: string;
  email?: string;
  displayName?: string;
};

type AwsSdkAuthProfileMarkerStore = {
  agentDir?: string;
  authPath: string;
  raw: Record<string, unknown>;
  profiles: AwsSdkProfileMarker[];
};

class AuthProfileMigrationVerificationError extends Error {
  constructor(readonly detail: string | null) {
    super("auth profile SQLite verification failed");
    this.name = "AuthProfileMigrationVerificationError";
  }
}

type RawAuthProfileImportStore = {
  version: number;
  profiles: Record<string, Record<string, unknown>>;
  order?: Record<string, string[]>;
};

type LegacyFlatAuthProfileRepairResult = {
  detected: string[];
  changes: string[];
  configChanged?: boolean;
  warnings: string[];
};

const UNSAFE_LEGACY_AUTH_PROFILE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeLegacyProviderKey(key: string): boolean {
  return key.trim().length > 0 && !UNSAFE_LEGACY_AUTH_PROFILE_KEYS.has(key);
}

function extractProviderFromProfileId(profileId: string): string | undefined {
  const colon = profileId.indexOf(":");
  if (colon <= 0) {
    return undefined;
  }
  return readNonEmptyString(profileId.slice(0, colon));
}

function extractProviderFromModelRef(modelRef: string): string | undefined {
  const { model } = splitTrailingAuthProfile(modelRef);
  const slash = model.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  return readNonEmptyString(model.slice(0, slash));
}

function collectLegacyConfigAuthProfileProviderHints(
  cfg: OpenClawConfig,
): ReadonlyMap<string, string> {
  const hints = new Map<string, string>();
  const conflicted = new Set<string>();
  const addHint = (profileId: string, provider: string): void => {
    const existing = hints.get(profileId);
    if (existing && existing !== provider) {
      hints.delete(profileId);
      conflicted.add(profileId);
      return;
    }
    if (!conflicted.has(profileId)) {
      hints.set(profileId, provider);
    }
  };
  const addModelHints = (models: unknown): void => {
    if (!isRecord(models)) {
      return;
    }
    for (const [modelRef, rawModel] of Object.entries(models)) {
      const provider = extractProviderFromModelRef(modelRef);
      if (!provider || !isSafeLegacyProviderKey(provider) || !isRecord(rawModel)) {
        continue;
      }
      const agentRuntime = isRecord(rawModel.agentRuntime) ? rawModel.agentRuntime : null;
      const authProfileId = agentRuntime
        ? readNonEmptyString(agentRuntime.authProfileId)
        : undefined;
      if (authProfileId) {
        addHint(authProfileId, provider);
      }
    }
  };

  for (const { value } of collectConfiguredModelRefs(cfg)) {
    const { profile } = splitTrailingAuthProfile(value);
    const provider = extractProviderFromModelRef(value);
    if (profile && provider && isSafeLegacyProviderKey(provider)) {
      addHint(profile, provider);
    }
  }

  const root: Record<string, unknown> = cfg;
  const auth = isRecord(root.auth) ? root.auth : null;
  const order = auth && isRecord(auth.order) ? auth.order : null;
  if (order) {
    for (const [provider, profileIds] of Object.entries(order)) {
      if (!isSafeLegacyProviderKey(provider) || !Array.isArray(profileIds)) {
        continue;
      }
      for (const profileId of profileIds) {
        const normalizedProfileId = readNonEmptyString(profileId);
        if (normalizedProfileId) {
          addHint(normalizedProfileId, provider);
        }
      }
    }
  }
  const agents = isRecord(root.agents) ? root.agents : null;
  const defaults = agents && isRecord(agents.defaults) ? agents.defaults : null;
  addModelHints(defaults?.models);
  const agentList = agents && Array.isArray(agents.list) ? agents.list : [];
  for (const agent of agentList) {
    if (isRecord(agent)) {
      addModelHints(agent.models);
    }
  }
  return hints;
}

function inferLegacyCredentialType(
  record: Record<string, unknown>,
): AuthProfileCredential["type"] | undefined {
  const explicit = readNonEmptyString(record.type) ?? readNonEmptyString(record.mode);
  if (explicit === "api_key" || explicit === "token" || explicit === "oauth") {
    return explicit;
  }
  if (readNonEmptyString(record.key) ?? readNonEmptyString(record.apiKey)) {
    return "api_key";
  }
  if (coerceSecretRef(record.keyRef)) {
    return "api_key";
  }
  if (readNonEmptyString(record.token)) {
    return "token";
  }
  if (coerceSecretRef(record.tokenRef)) {
    return "token";
  }
  if (
    readNonEmptyString(record.access) &&
    readNonEmptyString(record.refresh) &&
    typeof record.expires === "number"
  ) {
    return "oauth";
  }
  return undefined;
}

function coerceLegacyFlatCredential(
  providerId: string,
  raw: unknown,
): AuthProfileCredential | null {
  if (!isRecord(raw)) {
    return null;
  }
  const type = inferLegacyCredentialType(raw);
  if (!type) {
    return null;
  }
  const provider = readNonEmptyString(raw.provider) ?? providerId;
  const credential = parseLegacyCredentialEntry({ ...raw, type, provider }, providerId);
  if (!credential || !hasUsableAuthProfileCredential(credential)) {
    return null;
  }
  return credential;
}

function coerceLegacyFlatAuthProfileStore(raw: unknown): AuthProfileStore | null {
  if (!isRecord(raw) || "profiles" in raw) {
    return null;
  }
  const store: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  for (const [key, value] of Object.entries(raw)) {
    const providerId = key.trim();
    if (!isSafeLegacyProviderKey(providerId)) {
      continue;
    }
    const credential = coerceLegacyFlatCredential(providerId, value);
    if (!credential) {
      continue;
    }
    store.profiles[`${providerId}:default`] = credential;
  }
  return Object.keys(store.profiles).length > 0 ? store : null;
}

function listAuthProfileSqliteMigrationCandidates(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): AuthProfileSqliteMigrationCandidate[] {
  return listAuthProfileRepairCandidates(cfg, env).map((candidate) => ({
    agentDir: candidate.agentDir,
    authPath: candidate.authPath,
    statePath: resolveAuthStatePath(path.dirname(candidate.authPath)),
    legacyPath: resolveLegacyAuthStorePath(path.dirname(candidate.authPath)),
  }));
}

function hasAuthProfileState(state: AuthProfileState): boolean {
  return Boolean(state.order || state.lastGood || state.usageStats);
}

function normalizeLegacyApiKeyAliasesForImport(raw: unknown): void {
  if (!isRecord(raw) || !isRecord(raw.profiles)) {
    return;
  }
  for (const profile of Object.values(raw.profiles)) {
    if (!isRecord(profile)) {
      continue;
    }
    const type = readNonEmptyString(profile.type) ?? readNonEmptyString(profile.mode);
    if (type !== "api_key") {
      continue;
    }
    const hasCanonicalCredential =
      readNonEmptyString(profile.key) !== undefined ||
      coerceSecretRef(profile.key) !== null ||
      coerceSecretRef(profile.keyRef) !== null;
    if (hasCanonicalCredential || profile["api_key"] === undefined) {
      continue;
    }
    profile.key = profile["api_key"];
  }
}

function collectAuthProfileStateProfileIds(state: AuthProfileState): string[] {
  return [
    ...new Set([
      ...Object.values(state.order ?? {}).flat(),
      ...Object.values(state.lastGood ?? {}),
      ...Object.keys(state.usageStats ?? {}),
    ]),
  ];
}

function inferLegacyConfigAuthProfileMode(
  raw: Record<string, unknown>,
): AuthProfileCredential["type"] | undefined {
  const explicit = readNonEmptyString(raw.mode) ?? readNonEmptyString(raw.type);
  if (explicit === "api_key" || explicit === "token" || explicit === "oauth") {
    return explicit;
  }
  if (
    readNonEmptyString(raw.key) ||
    readNonEmptyString(raw.apiKey) ||
    readNonEmptyString(raw["api_key"]) ||
    coerceSecretRef(raw.keyRef) ||
    coerceSecretRef(raw.key) ||
    coerceSecretRef(raw.apiKey) ||
    coerceSecretRef(raw["api_key"])
  ) {
    return "api_key";
  }
  if (
    readNonEmptyString(raw.token) ||
    coerceSecretRef(raw.tokenRef) ||
    coerceSecretRef(raw.token)
  ) {
    return "token";
  }
  if (
    readNonEmptyString(raw.access) &&
    readNonEmptyString(raw.refresh) &&
    typeof raw.expires === "number"
  ) {
    return "oauth";
  }
  return undefined;
}

function coerceLegacyConfigAuthProfileStore(cfg: OpenClawConfig): AuthProfileStore | null {
  const cfgRecord: Record<string, unknown> = cfg;
  const auth = isRecord(cfgRecord.auth) ? cfgRecord.auth : null;
  const profiles = auth && isRecord(auth.profiles) ? auth.profiles : null;
  if (!profiles) {
    return null;
  }
  const providerHints = collectLegacyConfigAuthProfileProviderHints(cfg);
  const store: RawAuthProfileImportStore = { version: AUTH_STORE_VERSION, profiles: {} };
  for (const [profileId, raw] of Object.entries(profiles)) {
    if (!isRecord(raw)) {
      continue;
    }
    const mode = inferLegacyConfigAuthProfileMode(raw);
    if (mode !== "api_key" && mode !== "token" && mode !== "oauth") {
      continue;
    }
    const provider =
      readNonEmptyString(raw.provider) ??
      extractProviderFromProfileId(profileId) ??
      providerHints.get(profileId);
    if (!provider || !isSafeLegacyProviderKey(provider)) {
      continue;
    }
    const next: Record<string, unknown> = { ...raw, provider, mode };
    if (mode === "api_key") {
      const keyRef =
        coerceSecretRef(raw.keyRef) ??
        coerceSecretRef(raw.key) ??
        coerceSecretRef(raw.apiKey) ??
        coerceSecretRef(raw["api_key"]);
      const key =
        readNonEmptyString(raw.key) ??
        readNonEmptyString(raw.apiKey) ??
        readNonEmptyString(raw["api_key"]);
      if (keyRef) {
        next.keyRef = keyRef;
        delete next.key;
        delete next.apiKey;
        delete next["api_key"];
      } else if (key) {
        next.key = key;
        delete next.keyRef;
      } else {
        continue;
      }
    } else if (mode === "token") {
      const tokenRef = coerceSecretRef(raw.tokenRef) ?? coerceSecretRef(raw.token);
      const token = readNonEmptyString(raw.token);
      if (tokenRef) {
        next.tokenRef = tokenRef;
        delete next.token;
      } else if (token) {
        next.token = token;
        delete next.tokenRef;
      } else {
        continue;
      }
    } else if (
      !readNonEmptyString(raw.access) ||
      !readNonEmptyString(raw.refresh) ||
      typeof raw.expires !== "number"
    ) {
      continue;
    }
    store.profiles[profileId] = next;
  }
  const canonicalStore = coercePersistedAuthProfileStore(store);
  return canonicalStore && Object.keys(canonicalStore.profiles).length > 0 ? canonicalStore : null;
}

function isDefaultAgentCandidate(
  candidate: AuthProfileSqliteMigrationCandidate,
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    candidate.agentDir === undefined ||
    path.resolve(candidate.agentDir) === path.resolve(resolveLegacyInheritedAuthAgentDir(cfg, env))
  );
}

function stripImportedConfigAuthProfileCredentials(
  cfg: OpenClawConfig,
  store: AuthProfileStore,
): boolean {
  const profiles = ensureConfigAuthProfiles(cfg);
  let changed = false;
  for (const [profileId, credential] of Object.entries(store.profiles)) {
    const current = profiles[profileId];
    if (!current) {
      continue;
    }
    const metadata: AuthProfileConfig = {
      provider: current.provider || credential.provider,
      mode: credential.type,
      ...(current.email ? { email: current.email } : {}),
      ...(current.displayName ? { displayName: current.displayName } : {}),
    };
    profiles[profileId] = metadata;
    changed = true;
  }
  return changed;
}

function hasUsableAuthProfileCredential(credential: AuthProfileCredential): boolean {
  if (credential.type === "api_key") {
    return Boolean(readNonEmptyString(credential.key) || credential.keyRef);
  }
  if (credential.type === "token") {
    return Boolean(readNonEmptyString(credential.token) || credential.tokenRef);
  }
  return (
    Boolean(readNonEmptyString(credential.access)) &&
    Boolean(readNonEmptyString(credential.refresh)) &&
    typeof credential.expires === "number"
  );
}

function mergeImportedAuthProfiles(params: {
  store: AuthProfileStore;
  profiles: AuthProfileStore["profiles"];
  existingProfileIds: ReadonlySet<string>;
  replaceExistingWithoutCredential?: boolean;
}): AuthProfileStore {
  const profiles = { ...params.store.profiles };
  for (const [profileId, credential] of Object.entries(params.profiles)) {
    if (!params.existingProfileIds.has(profileId)) {
      profiles[profileId] = credential;
      continue;
    }
    const existing = profiles[profileId];
    if (
      params.replaceExistingWithoutCredential &&
      existing &&
      !hasUsableAuthProfileCredential(existing) &&
      hasUsableAuthProfileCredential(credential)
    ) {
      profiles[profileId] = credential;
    }
  }
  return { ...params.store, profiles };
}

function mergeImportedAuthProfileState(params: {
  store: AuthProfileStore;
  state: AuthProfileState;
  existingState: AuthProfileState;
}): AuthProfileStore {
  // Preserve current SQLite state over imported JSON state; old files are backup-only after import.
  const next = { ...params.store };
  for (const field of ["order", "lastGood", "usageStats"] as const) {
    const incoming = params.state[field];
    if (!incoming) {
      continue;
    }
    const existing = params.existingState[field] ?? {};
    Object.assign(next, {
      [field]: {
        ...params.store[field],
        ...Object.fromEntries(
          Object.entries(incoming).filter(([key]) => !Object.hasOwn(existing, key)),
        ),
      },
    });
  }
  return next;
}

function formatMissingAuthProfileSqliteVerification(params: {
  expected: AuthProfileStore;
  importedProfileIds: ReadonlySet<string>;
  loaded: AuthProfileStore | null;
}): string | null {
  const missingProfileIds = [...params.importedProfileIds].filter(
    (profileId) => !params.loaded?.profiles[profileId],
  );
  const missingStateFields: string[] = [];
  for (const [provider, profileIds] of Object.entries(params.expected.order ?? {})) {
    const loadedProfileIds = params.loaded?.order?.[provider];
    if (
      !loadedProfileIds ||
      loadedProfileIds.length !== profileIds.length ||
      loadedProfileIds.some((profileId, index) => profileId !== profileIds[index])
    ) {
      missingStateFields.push(`order.${provider}`);
    }
  }
  for (const [provider, profileId] of Object.entries(params.expected.lastGood ?? {})) {
    if (params.loaded?.lastGood?.[provider] !== profileId) {
      missingStateFields.push(`lastGood.${provider}`);
    }
  }
  for (const profileId of Object.keys(params.expected.usageStats ?? {})) {
    if (!params.loaded?.usageStats?.[profileId]) {
      missingStateFields.push(`usageStats.${profileId}`);
    }
  }

  const parts: string[] = [];
  if (missingProfileIds.length > 0) {
    parts.push(`imported profile(s): ${missingProfileIds.toSorted().join(", ")}`);
  }
  if (missingStateFields.length > 0) {
    parts.push(`auth state field(s): ${missingStateFields.toSorted().join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

function collectUnresolvedLegacyOAuthSidecarProfileIds(raw: unknown): string[] {
  if (!isRecord(raw) || !isRecord(raw.profiles)) {
    return [];
  }
  const profileIds: string[] = [];
  for (const [profileId, profile] of Object.entries(raw.profiles)) {
    if (!isRecord(profile) || profile.type !== "oauth" || !isRecord(profile.oauthRef)) {
      continue;
    }
    if (
      readNonEmptyString(profile.oauthRef.id) &&
      readNonEmptyString(profile.oauthRef.provider) &&
      (!readNonEmptyString(profile.access) || !readNonEmptyString(profile.refresh))
    ) {
      profileIds.push(profileId);
    }
  }
  return profileIds;
}

function hasImportableAuthProfileStore(store: AuthProfileStore | null): store is AuthProfileStore {
  return Boolean(store && (Object.keys(store.profiles).length > 0 || hasAuthProfileState(store)));
}

function hasLegacyAuthProfileSource(candidate: AuthProfileSqliteMigrationCandidate): boolean {
  return (
    fs.existsSync(candidate.authPath) ||
    fs.existsSync(candidate.statePath) ||
    fs.existsSync(candidate.legacyPath)
  );
}

function prepareAuthProfileSourceReceipt(params: {
  pathname: string;
  targetDatabasePath: string;
  targetTable: AuthProfileMigrationSourceReceipt["targetTable"];
  targetStoreKey?: AuthProfileMigrationSourceReceipt["targetStoreKey"];
  now: () => number;
  env?: NodeJS.ProcessEnv;
}): AuthProfileMigrationSourceReceipt {
  const sourceBytes = fs.readFileSync(params.pathname);
  let sourceRecordCount = 0;
  try {
    const parsed = JSON.parse(sourceBytes.toString("utf8")) as unknown;
    sourceRecordCount = isRecord(parsed) ? Object.keys(parsed).length : 0;
  } catch {
    // The migration parser reports malformed input separately; receipts never include its bytes.
  }
  return createAuthProfileMigrationSourceReceipt({
    sourcePath: params.pathname,
    sourceBytes,
    sourceRecordCount,
    targetDatabasePath: params.targetDatabasePath,
    targetTable: params.targetTable,
    ...(params.targetStoreKey ? { targetStoreKey: params.targetStoreKey } : {}),
    now: new Date(params.now()),
    ...(params.env ? { env: params.env } : {}),
  });
}

function archiveVerifiedAuthProfileSource(
  receipt: AuthProfileMigrationSourceReceipt,
  sourceLocked = false,
): string {
  finalizeAuthProfileMigrationSource(receipt, "completed", { sourceLocked });
  return receipt.archivePath;
}

function assertAuthProfileMigrationSourcesUnchanged(
  candidate: AuthProfileSqliteMigrationCandidate,
  receipts: readonly AuthProfileMigrationSourceReceipt[],
): void {
  const receiptByPath = new Map(receipts.map((receipt) => [receipt.sourcePath, receipt]));
  for (const pathname of [candidate.authPath, candidate.statePath, candidate.legacyPath]) {
    const receipt = receiptByPath.get(path.resolve(pathname));
    if (fs.existsSync(pathname) !== Boolean(receipt)) {
      throw new Error("legacy auth source set changed during migration; retry Doctor");
    }
    if (!receipt) {
      continue;
    }
    const currentSha256 = createHash("sha256").update(fs.readFileSync(pathname)).digest("hex");
    if (currentSha256 !== receipt.sourceSha256) {
      throw new Error("legacy auth source changed during migration; retry Doctor");
    }
  }
}

function parseAuthProfileMigrationSource(
  receipt: AuthProfileMigrationSourceReceipt | undefined,
): unknown {
  if (!receipt?.sourceBytes) {
    return null;
  }
  try {
    return JSON.parse(receipt.sourceBytes.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function archivePreviouslyMigratedAuthProfileSource(
  receipt: AuthProfileMigrationSourceReceipt,
  result: LegacyFlatAuthProfileRepairResult,
): boolean {
  if (!hasTerminalAuthProfileMigrationReceipt(receipt.sourceKey, receipt.env)) {
    return false;
  }
  archiveAuthProfileMigrationSource(receipt);
  result.changes.push(
    `Archived a previously migrated legacy auth source without replaying credentials (${shortenHomePath(receipt.archivePath)}).`,
  );
  return true;
}

function coerceLegacyOAuthFile(raw: unknown): {
  store: AuthProfileStore | null;
  rejectedEntries: number;
} {
  if (!isRecord(raw)) {
    return { store: null, rejectedEntries: 1 };
  }
  const profiles: AuthProfileStore["profiles"] = {};
  let rejectedEntries = 0;
  for (const [provider, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      rejectedEntries += 1;
      continue;
    }
    const credential = parseLegacyCredentialEntry({ ...value, type: "oauth", provider }, provider);
    if (credential?.type === "oauth") {
      profiles[`${provider}:default`] = credential;
    } else {
      rejectedEntries += 1;
    }
  }
  return {
    store: Object.keys(profiles).length > 0 ? { version: AUTH_STORE_VERSION, profiles } : null,
    rejectedEntries,
  };
}

function loadAuthProfileMigrationTargetStore(
  agentDir: string | undefined,
  loadStore: typeof loadPersistedAuthProfileStore = loadPersistedAuthProfileStore,
  database?: AuthProfileDatabase,
  env: NodeJS.ProcessEnv = process.env,
): AuthProfileStore {
  const explicitSharedRead = agentDir === undefined && database === undefined;
  const inspection = explicitSharedRead
    ? inspectPersistedSharedAuthProfileStoreRaw(env)
    : inspectPersistedAuthProfileStoreRaw(agentDir, database);
  const store =
    explicitSharedRead && loadStore === loadPersistedAuthProfileStore
      ? loadPersistedSharedAuthProfileStore(env)
      : loadStore(agentDir, database ? { database } : undefined);
  if (store) {
    return store;
  }
  if (inspection.status !== "missing") {
    throw new Error("canonical auth profile store is unreadable; legacy source left in place");
  }
  const stateInspection = explicitSharedRead
    ? inspectPersistedSharedAuthProfileStateRaw(env)
    : inspectPersistedAuthProfileStateRaw(agentDir, database);
  if (stateInspection.status === "unreadable") {
    throw new Error("canonical auth profile state is unreadable; legacy source left in place");
  }
  return {
    version: AUTH_STORE_VERSION,
    profiles: {},
    ...coerceAuthProfileState(
      explicitSharedRead
        ? readPersistedSharedAuthProfileStateRaw(env)
        : readPersistedAuthProfileStateRaw(agentDir, database),
    ),
  };
}

function migrateLegacyOAuthFile(params: {
  oauthPath: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  result: LegacyFlatAuthProfileRepairResult;
}): void {
  if (!fs.existsSync(params.oauthPath)) {
    return;
  }
  const releaseSource = acquireAuthProfileMigrationSourceLocks([params.oauthPath]);
  try {
    migrateLockedLegacyOAuthFile(params);
  } finally {
    releaseSource();
  }
}

function migrateLockedLegacyOAuthFile(params: {
  oauthPath: string;
  env: NodeJS.ProcessEnv;
  now: () => number;
  result: LegacyFlatAuthProfileRepairResult;
}): void {
  const targetDatabasePath = resolveSharedAuthStorePath(params.env);
  const sharedStateTarget = resolveSharedAuthStoreOwnership(params.env).location === "state-db";
  const receipt = prepareAuthProfileSourceReceipt({
    pathname: params.oauthPath,
    targetDatabasePath,
    targetTable: sharedStateTarget ? "auth_profile_stores" : "auth_profile_store",
    targetStoreKey: sharedStateTarget ? "shared" : "primary",
    now: params.now,
    env: params.env,
  });
  if (archivePreviouslyMigratedAuthProfileSource(receipt, params.result)) {
    return;
  }
  const raw = loadJsonFileThroughSymlink(params.oauthPath);
  const parsed = coerceLegacyOAuthFile(raw);
  const imported = parsed.store;
  if (!imported) {
    finalizeAuthProfileMigrationSource(receipt, "archived-unparsed", { sourceLocked: true });
    params.result.warnings.push(
      `Archived an unreadable legacy OAuth source without import; re-authenticate or recover it from ${shortenHomePath(receipt.archivePath)}.`,
    );
    return;
  }
  const existing = loadAuthProfileMigrationTargetStore(
    undefined,
    loadPersistedAuthProfileStore,
    undefined,
    params.env,
  );
  const importedProfileIds = new Set(Object.keys(imported.profiles));
  const next = mergeImportedAuthProfiles({
    store: existing,
    profiles: imported.profiles,
    existingProfileIds: new Set(Object.keys(existing.profiles)),
  });
  const loaded = runAuthProfileWriteTransaction(
    undefined,
    (database, owner) => {
      const authoritative = loadAuthProfileMigrationTargetStore(
        undefined,
        loadPersistedAuthProfileStore,
        database,
      );
      if (!isDeepStrictEqual(authoritative, existing)) {
        throw new Error("canonical auth profile store changed during legacy OAuth migration");
      }
      saveAuthProfileStoreWithPreparedOwner(
        next,
        undefined,
        {
          filterExternalAuthProfiles: false,
          preserveStateProfileIds: collectAuthProfileStateProfileIds(
            coerceAuthProfileState(existing),
          ),
          syncExternalCli: false,
        },
        database,
        owner,
      );
      const verified = loadPersistedAuthProfileStore(undefined, { database });
      const verificationFailure = formatMissingAuthProfileSqliteVerification({
        expected: next,
        importedProfileIds,
        loaded: verified,
      });
      const mismatched = [...importedProfileIds].filter((profileId) => {
        if (existing.profiles[profileId]) {
          return false;
        }
        return !isDeepStrictEqual(verified?.profiles[profileId], imported.profiles[profileId]);
      });
      if (verificationFailure || mismatched.length > 0 || !verified) {
        throw new Error("legacy OAuth import verification failed");
      }
      return verified;
    },
    { env: params.env },
  );
  receipt.expectedProfileSha256 = Object.fromEntries(
    [...importedProfileIds].map((profileId) => [
      profileId,
      digestAuthProfileMigrationValue(loaded.profiles[profileId]),
    ]),
  );
  finalizeAuthProfileMigrationSource(
    receipt,
    parsed.rejectedEntries > 0 ? "archived-unparsed" : "completed",
    { sourceLocked: true },
  );
  if (parsed.rejectedEntries > 0) {
    params.result.warnings.push(
      `Imported valid shared OAuth entries and archived ${parsed.rejectedEntries} rejected entr${parsed.rejectedEntries === 1 ? "y" : "ies"} for manual recovery.`,
    );
  }
  params.result.changes.push(
    `Migrated shared legacy OAuth credentials into the shared-main SQLite owner (archive: ${shortenHomePath(receipt.archivePath)}).`,
  );
}

/**
 * Imports legacy auth profile JSON and state files into the per-agent SQLite store.
 *
 * JSON files are verified and atomically renamed to timestamped archives only after import.
 * OAuth profiles that still depend on missing sidecar secrets migrate as unavailable ref-only rows.
 */
export async function maybeMigrateAuthProfileJsonStoresToSqlite(params: {
  cfg: OpenClawConfig;
  prompter: Pick<DoctorPrompter, "confirmAutoFix">;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  openAICodexAuthProfileIdMap?: ReadonlyMap<string, string>;
  deps?: {
    loadPersistedAuthProfileStore?: typeof loadPersistedAuthProfileStore;
  };
}): Promise<LegacyFlatAuthProfileRepairResult> {
  const now = params.now ?? Date.now;
  const env = params.env ?? process.env;
  const loadMigratedStore =
    params.deps?.loadPersistedAuthProfileStore ?? loadPersistedAuthProfileStore;
  let resumedChanges: string[] = [];
  let resumeWarning: string | undefined;
  try {
    resumedChanges = resumePendingAuthProfileMigrationArchives(env);
  } catch (err) {
    resumeWarning = `Could not finalize an interrupted auth profile archive; legacy sources were left for recovery: ${String(err)}`;
  }
  const candidates = listAuthProfileSqliteMigrationCandidates(params.cfg, env);
  const configStore = coerceLegacyConfigAuthProfileStore(params.cfg);
  const oauthPath = resolveLegacyOAuthPath(env);
  const hasLegacyOAuth = fs.existsSync(oauthPath);
  const detected = candidates.filter(
    (candidate) =>
      hasLegacyAuthProfileSource(candidate) ||
      (configStore && isDefaultAgentCandidate(candidate, params.cfg, env)),
  );
  const result: LegacyFlatAuthProfileRepairResult = {
    detected: [
      ...detected.flatMap((candidate) =>
        [
          candidate.authPath,
          candidate.statePath,
          candidate.legacyPath,
          ...(configStore && isDefaultAgentCandidate(candidate, params.cfg, env)
            ? [candidate.authPath]
            : []),
        ]
          .filter((pathname, index, entries) => entries.indexOf(pathname) === index)
          .filter(
            (pathname) =>
              fs.existsSync(pathname) ||
              (configStore &&
                isDefaultAgentCandidate(candidate, params.cfg, env) &&
                pathname === candidate.authPath),
          ),
      ),
      ...(hasLegacyOAuth ? [oauthPath] : []),
    ],
    changes: resumedChanges,
    warnings: resumeWarning ? [resumeWarning] : [],
  };
  if (resumeWarning) {
    // A pending imported receipt owns its source until recovery succeeds.
    // Starting a new hash-based run would orphan that crash-recovery record.
    return result;
  }
  if (detected.length === 0 && !hasLegacyOAuth) {
    return result;
  }

  note(
    [
      ...detected.map(
        (candidate) =>
          `- ${shortenHomePath(candidate.authPath)} / ${shortenHomePath(candidate.statePath)}`,
      ),
      ...(hasLegacyOAuth ? [`- ${shortenHomePath(oauthPath)} (shared-main owner)`] : []),
      `- ${formatCliCommand("openclaw doctor --fix")} imports legacy auth profile JSON into SQLite, verifies it, records a receipt, and archives the original bytes.`,
    ].join("\n"),
    "Auth profile SQLite migration",
  );

  const shouldRepair = await params.prompter.confirmAutoFix({
    message: "Migrate auth profile JSON files into SQLite now?",
    initialValue: true,
  });
  if (!shouldRepair) {
    return result;
  }

  // Config, credential import, and session repair must share one collision
  // decision; archived legacy JSON cannot recreate it after migration.
  const openAIProfileIdMap =
    params.openAICodexAuthProfileIdMap ??
    collectOpenAICodexAuthProfileStoreIdMap({ cfg: params.cfg, env });
  for (const candidate of detected) {
    let releaseSources: (() => void) | undefined;
    try {
      const candidateSourcePaths = [candidate.authPath, candidate.statePath, candidate.legacyPath];
      for (const pathname of candidateSourcePaths) {
        fs.mkdirSync(path.dirname(pathname), { recursive: true });
      }
      releaseSources = acquireAuthProfileMigrationSourceLocks(candidateSourcePaths);
      const targetDatabasePath = resolveMigrationTargetDatabasePath(candidate.agentDir, env);
      const sharedStateTarget =
        candidate.agentDir === undefined &&
        resolveSharedAuthStoreOwnership(env).location === "state-db";
      // A shared candidate on a legacy root names the main agent dir explicitly: it resolves to the
      // same database, but an undefined agent dir would enter the shared-write bootstrap and could
      // record state-db ownership midway through this import. Doctor stays the only owner of that flip.
      const transactionAgentDir =
        sharedStateTarget || candidate.agentDir !== undefined
          ? candidate.agentDir
          : resolveSharedMainAuthAgentDir(env);
      let sourceReceipts = candidateSourcePaths.filter(fs.existsSync).map((pathname) =>
        prepareAuthProfileSourceReceipt({
          pathname,
          targetDatabasePath,
          targetTable:
            pathname === candidate.statePath
              ? "auth_profile_state"
              : sharedStateTarget
                ? "auth_profile_stores"
                : "auth_profile_store",
          targetStoreKey: sharedStateTarget ? "shared" : "primary",
          now,
          env,
        }),
      );
      sourceReceipts = sourceReceipts.filter(
        (receipt) => !archivePreviouslyMigratedAuthProfileSource(receipt, result),
      );
      assertAuthProfileMigrationSourcesUnchanged(candidate, sourceReceipts);
      if (sourceReceipts.length === 0 && !configStore) {
        continue;
      }
      const receiptByPath = new Map(
        sourceReceipts.map((receipt) => [receipt.sourcePath, receipt] as const),
      );
      const rawStore = parseAuthProfileMigrationSource(
        receiptByPath.get(path.resolve(candidate.authPath)),
      );
      // Parse the standalone rotation state early so it canonicalizes with the credentials.
      const rawState = parseAuthProfileMigrationSource(
        receiptByPath.get(path.resolve(candidate.statePath)),
      );
      const openAIProviderRepair = canonicalizeLegacyOpenAIAuthStore(
        rawStore,
        rawState,
        openAIProfileIdMap,
      );
      const unresolvedSidecarProfileIds = new Set(
        collectUnresolvedLegacyOAuthSidecarProfileIds(rawStore),
      );
      const unresolvedSidecarWarning =
        unresolvedSidecarProfileIds.size > 0
          ? `Migrated ${unresolvedSidecarProfileIds.size} legacy OAuth sidecar profile${unresolvedSidecarProfileIds.size === 1 ? "" : "s"} from ${shortenHomePath(candidate.authPath)} into SQLite as configured-unavailable without credentials; re-authenticate ${unresolvedSidecarProfileIds.size === 1 ? "this profile" : "these profiles"} to restore access.`
          : undefined;
      const awsSdkMarkerStore =
        isRecord(rawStore) && isRecord(rawStore.profiles)
          ? resolveAwsSdkAuthProfileMarkerStore(candidate)
          : null;
      if (awsSdkMarkerStore && isRecord(rawStore)) {
        const configProfiles = ensureConfigAuthProfiles(params.cfg);
        for (const marker of awsSdkMarkerStore.profiles) {
          configProfiles[marker.profileId] = {
            provider: marker.provider,
            mode: "aws-sdk",
            ...(marker.email ? { email: marker.email } : {}),
            ...(marker.displayName ? { displayName: marker.displayName } : {}),
          };
        }
        removeAwsSdkProfileMarkers(
          rawStore,
          awsSdkMarkerStore.profiles.map((profile) => profile.profileId),
        );
        result.configChanged = true;
      }
      normalizeLegacyApiKeyAliasesForImport(rawStore);
      const maybeCanonicalStore =
        coercePersistedAuthProfileStore(rawStore) ??
        coerceLegacyFlatAuthProfileStore(rawStore) ??
        null;
      const canonicalStore = hasImportableAuthProfileStore(maybeCanonicalStore)
        ? maybeCanonicalStore
        : null;
      const configCanonicalStore =
        configStore && isDefaultAgentCandidate(candidate, params.cfg, env) ? configStore : null;
      const legacyStore = coerceLegacyAuthStore(
        parseAuthProfileMigrationSource(receiptByPath.get(path.resolve(candidate.legacyPath))),
      );
      const state = coerceAuthProfileState(rawState);
      if (
        !canonicalStore &&
        !configCanonicalStore &&
        !legacyStore &&
        !hasAuthProfileState(state) &&
        !awsSdkMarkerStore
      ) {
        if (sourceReceipts.length > 0) {
          const archived = sourceReceipts.map((receipt) => {
            finalizeAuthProfileMigrationSource(receipt, "archived-unparsed", {
              sourceLocked: true,
            });
            return receipt.archivePath;
          });
          result.warnings.push(
            unresolvedSidecarWarning ??
              `Archived unparseable auth profile input without import for ${shortenHomePath(candidate.authPath)} (${archived.map(shortenHomePath).join(", ")}).`,
          );
          continue;
        }
        result.warnings.push(
          `Left auth profile JSON in place for ${shortenHomePath(candidate.authPath)} because no importable auth profiles or state were found.`,
        );
        continue;
      }

      const existing = loadAuthProfileMigrationTargetStore(
        candidate.agentDir,
        loadMigratedStore,
        undefined,
        env,
      );
      const existingProfileIds = new Set(Object.keys(existing.profiles));
      const existingState = coerceAuthProfileState(existing);
      let next: AuthProfileStore = { ...existing };
      let verifiedStore = existing;
      const importedProfileIds = new Set<string>();
      if (legacyStore) {
        const legacyAsStore: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
        applyLegacyAuthStore(legacyAsStore, legacyStore);
        for (const profileId of Object.keys(legacyAsStore.profiles)) {
          importedProfileIds.add(profileId);
        }
        next = mergeImportedAuthProfiles({
          store: next,
          profiles: legacyAsStore.profiles,
          existingProfileIds,
        });
      }
      if (canonicalStore) {
        for (const profileId of Object.keys(canonicalStore.profiles)) {
          importedProfileIds.add(profileId);
        }
        next = {
          ...next,
          version: Math.max(next.version, canonicalStore.version),
        };
        next = mergeImportedAuthProfiles({
          store: next,
          profiles: canonicalStore.profiles,
          existingProfileIds,
        });
        next = mergeImportedAuthProfileState({
          store: next,
          state: coerceAuthProfileState(canonicalStore),
          existingState,
        });
      }
      if (configCanonicalStore) {
        for (const profileId of Object.keys(configCanonicalStore.profiles)) {
          importedProfileIds.add(profileId);
        }
        // Config imports fill missing SQLite credentials only; when both exist,
        // the canonical per-agent SQLite store wins over legacy config secrets.
        next = mergeImportedAuthProfiles({
          store: next,
          profiles: configCanonicalStore.profiles,
          existingProfileIds: new Set(Object.keys(next.profiles)),
          replaceExistingWithoutCredential: true,
        });
      }
      if (hasAuthProfileState(state)) {
        next = mergeImportedAuthProfileState({ store: next, state, existingState });
      }

      if (canonicalStore || configCanonicalStore || legacyStore || hasAuthProfileState(state)) {
        const stateProfileIds = [
          ...collectAuthProfileStateProfileIds(state),
          ...(canonicalStore
            ? collectAuthProfileStateProfileIds(coerceAuthProfileState(canonicalStore))
            : []),
          ...(configCanonicalStore
            ? collectAuthProfileStateProfileIds(coerceAuthProfileState(configCanonicalStore))
            : []),
        ];
        try {
          assertAuthProfileMigrationSourcesUnchanged(candidate, sourceReceipts);
          verifiedStore = runAuthProfileWriteTransaction(
            transactionAgentDir,
            (database, owner) => {
              const authoritative = loadAuthProfileMigrationTargetStore(
                candidate.agentDir,
                loadMigratedStore,
                database,
              );
              // This store includes the separately persisted auth_profile_state row,
              // so state-only concurrent changes abort before either table is written.
              if (!isDeepStrictEqual(authoritative, existing)) {
                throw new Error("canonical auth profile store changed during legacy migration");
              }
              saveAuthProfileStoreWithPreparedOwner(
                next,
                candidate.agentDir,
                {
                  filterExternalAuthProfiles: false,
                  // Imported state may reference external profiles absent from this store.
                  preserveStateProfileIds: stateProfileIds,
                  syncExternalCli: false,
                },
                database,
                owner,
              );
              const loaded = loadMigratedStore(candidate.agentDir, { database });
              const persistedStores = {
                isMainStore:
                  resolveMigrationTargetDatabasePath(candidate.agentDir, env) ===
                  resolveSharedAuthStorePath(env),
                localStore: loaded,
                mainStore:
                  resolveMigrationTargetDatabasePath(candidate.agentDir, env) ===
                  resolveSharedAuthStorePath(env)
                    ? loaded
                    : loadPersistedSharedAuthProfileStore(env),
              };
              // A non-main store drops an OAuth credential the main store already
              // owns at the same or newer expiry. That dedup is intentional, so
              // verifying it as missing would abort a migration that lost nothing
              // and leave the legacy JSON in place, which blocks gateway startup.
              const dedupedToMainProfileIds = new Set(
                [...importedProfileIds].filter((profileId) => {
                  const credential = next.profiles[profileId];
                  return (
                    credential !== undefined &&
                    !loaded?.profiles[profileId] &&
                    isInheritedMainOAuthCredentialFromStores({
                      profileId,
                      credential,
                      persistedStores,
                    })
                  );
                }),
              );
              const verifiableProfileIds = new Set(
                [...importedProfileIds].filter(
                  (profileId) => !dedupedToMainProfileIds.has(profileId),
                ),
              );
              const verificationFailure = formatMissingAuthProfileSqliteVerification({
                expected: next,
                importedProfileIds: verifiableProfileIds,
                loaded,
              });
              const mismatchedCredential = [...verifiableProfileIds].some((profileId) => {
                if (existingProfileIds.has(profileId)) {
                  return false;
                }
                return !isDeepStrictEqual(loaded?.profiles[profileId], next.profiles[profileId]);
              });
              if (verificationFailure || mismatchedCredential || !loaded) {
                throw new AuthProfileMigrationVerificationError(verificationFailure);
              }
              return loaded;
            },
            { env },
          );
        } catch (error) {
          if (!(error instanceof AuthProfileMigrationVerificationError)) {
            throw error;
          }
          result.warnings.push(
            `Left auth profile JSON in place for ${shortenHomePath(candidate.authPath)} because SQLite verification failed${error.detail ? ` (${error.detail})` : ""}.`,
          );
          continue;
        }
        if (
          configCanonicalStore &&
          stripImportedConfigAuthProfileCredentials(params.cfg, configCanonicalStore)
        ) {
          result.configChanged = true;
        }
      }

      const expectedProfileSha256 = Object.fromEntries(
        [...importedProfileIds].flatMap((profileId) => {
          const profileValue = verifiedStore.profiles[profileId];
          return profileValue
            ? [[profileId, digestAuthProfileMigrationValue(profileValue)] as const]
            : [];
        }),
      );
      const expectedStateSha256 = digestAuthProfileMigrationValue(
        candidate.agentDir
          ? readPersistedAuthProfileStateRaw(candidate.agentDir)
          : readPersistedSharedAuthProfileStateRaw(env),
      );
      const canonicalSourceCarriesState = canonicalStore
        ? hasAuthProfileState(coerceAuthProfileState(canonicalStore))
        : false;
      for (const receipt of sourceReceipts) {
        if (receipt.targetTable === "auth_profile_store") {
          receipt.expectedProfileSha256 = expectedProfileSha256;
        }
        if (
          receipt.targetTable === "auth_profile_state" ||
          (receipt.sourcePath === candidate.authPath && canonicalSourceCarriesState)
        ) {
          receipt.expectedStateSha256 = expectedStateSha256;
        }
      }
      assertAuthProfileMigrationSourcesUnchanged(candidate, sourceReceipts);
      const archives = sourceReceipts.map((receipt) =>
        archiveVerifiedAuthProfileSource(receipt, true),
      );
      const archiveText =
        archives.length > 0
          ? `archive${archives.length === 1 ? "" : "s"}: ${archives.map(shortenHomePath).join(", ")}`
          : "no legacy JSON backup needed";
      result.changes.push(
        `Migrated auth profile JSON for ${shortenHomePath(candidate.authPath)} into SQLite (${archiveText}).`,
      );
      if (unresolvedSidecarWarning) {
        result.warnings.push(unresolvedSidecarWarning);
      }
      if (openAIProviderRepair !== null) {
        result.changes.push(
          `Migrated ${openAIProviderRepair} OpenAI Codex auth profile(s) in ${shortenHomePath(candidate.authPath)} to provider "openai".`,
        );
      }
      if (awsSdkMarkerStore) {
        result.changes.push(
          `Moved aws-sdk profile metadata from ${shortenHomePath(candidate.authPath)} to auth.profiles before removing the legacy auth profile JSON.`,
        );
      }
    } catch (err) {
      result.warnings.push(
        `Failed to migrate auth profile JSON for ${shortenHomePath(candidate.authPath)}: ${String(err)}`,
      );
    } finally {
      releaseSources?.();
    }
  }
  const sharedMainAgentDir = resolveSharedMainAuthAgentDir(env);
  const sharedMainCredentialSourceRemains = [
    resolveAuthStorePath(sharedMainAgentDir),
    resolveLegacyAuthStorePath(sharedMainAgentDir),
  ].some((pathname) => fs.existsSync(pathname));
  if (hasLegacyOAuth && sharedMainCredentialSourceRemains) {
    result.warnings.push(
      `Deferred shared legacy OAuth migration until higher-priority shared-main credential sources are resolved by ${formatCliCommand("openclaw doctor --fix")}.`,
    );
  } else if (hasLegacyOAuth) {
    try {
      migrateLegacyOAuthFile({ oauthPath, env, now, result });
    } catch (err) {
      result.warnings.push(
        `Failed to migrate shared legacy OAuth credentials; the source was left in place: ${String(err)}`,
      );
    }
  }
  clearRuntimeAuthProfileStoreSnapshots();
  clearAuthProfileMigrationDiagnostics();
  if (result.changes.length > 0) {
    note(result.changes.map((change) => `- ${change}`).join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.map((warning) => `- ${warning}`).join("\n"), "Doctor warnings");
  }
  return result;
}

function resolveAwsSdkAuthProfileMarkerStore(
  candidate: AuthProfileRepairCandidate,
): AwsSdkAuthProfileMarkerStore | null {
  if (!fs.existsSync(candidate.authPath)) {
    return null;
  }
  const raw = loadJsonFileThroughSymlink(candidate.authPath);
  if (!isRecord(raw) || !isRecord(raw.profiles)) {
    return null;
  }
  const markers: AwsSdkProfileMarker[] = [];
  for (const [profileId, value] of Object.entries(raw.profiles)) {
    if (!isRecord(value)) {
      continue;
    }
    const mode = readNonEmptyString(value.type) ?? readNonEmptyString(value.mode);
    if (mode !== "aws-sdk") {
      continue;
    }
    const provider = readNonEmptyString(value.provider) ?? extractProviderFromProfileId(profileId);
    if (!provider || !isSafeLegacyProviderKey(provider)) {
      continue;
    }
    markers.push({
      profileId,
      provider,
      ...(readNonEmptyString(value.email) ? { email: readNonEmptyString(value.email) } : {}),
      ...(readNonEmptyString(value.displayName)
        ? { displayName: readNonEmptyString(value.displayName) }
        : {}),
    });
  }
  return markers.length > 0
    ? {
        ...candidate,
        raw,
        profiles: markers,
      }
    : null;
}

function ensureConfigAuthProfiles(config: OpenClawConfig): Record<string, AuthProfileConfig> {
  const root = config as Record<string, unknown>;
  const auth = isRecord(root.auth) ? root.auth : {};
  if (root.auth !== auth) {
    root.auth = auth;
  }
  if (!isRecord(auth.profiles)) {
    auth.profiles = {};
  }
  return auth.profiles as Record<string, AuthProfileConfig>;
}

function removeAwsSdkProfileMarkers(raw: Record<string, unknown>, profileIds: string[]): void {
  if (!isRecord(raw.profiles)) {
    return;
  }
  for (const profileId of profileIds) {
    delete raw.profiles[profileId];
  }
}

const LEGACY_OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_PROVIDER_ID = "openai";

function isLegacyOpenAICodexProvider(value: unknown): boolean {
  return (
    typeof value === "string" && value.trim().toLowerCase() === LEGACY_OPENAI_CODEX_PROVIDER_ID
  );
}

function isLegacyOpenAICodexProfileId(profileId: string): boolean {
  return profileId.trim().toLowerCase().startsWith(`${LEGACY_OPENAI_CODEX_PROVIDER_ID}:`);
}

function canonicalOpenAIProfileSuffix(profileId: string): string {
  return profileId.slice(profileId.indexOf(":") + 1).trim() || "default";
}

function allocateOpenAIProfileId(legacyProfileId: string, occupied: Set<string>): string {
  const suffix = canonicalOpenAIProfileSuffix(legacyProfileId);
  const direct = `${OPENAI_PROVIDER_ID}:${suffix}`;
  if (!occupied.has(direct)) {
    occupied.add(direct);
    return direct;
  }
  const chatgpt = `${OPENAI_PROVIDER_ID}:chatgpt-${suffix}`;
  if (!occupied.has(chatgpt)) {
    occupied.add(chatgpt);
    return chatgpt;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${chatgpt}-${index}`;
    if (!occupied.has(candidate)) {
      occupied.add(candidate);
      return candidate;
    }
  }
}

function canonicalizeOpenAIProfileEntries(
  profiles: Record<string, unknown>,
  options?: { profileIdMap?: ReadonlyMap<string, string> },
): {
  profileIdMap: Map<string, string>;
  changed: boolean;
} {
  const occupied = new Set(Object.keys(profiles).filter((id) => !isLegacyOpenAICodexProfileId(id)));
  const reservedMappedIds = new Set(options?.profileIdMap?.values() ?? []);
  const profileIdMap = new Map<string, string>();
  let changed = false;

  for (const [profileId, rawProfile] of Object.entries({ ...profiles })) {
    if (!isRecord(rawProfile)) {
      continue;
    }
    const legacyId = isLegacyOpenAICodexProfileId(profileId);
    const legacyProvider = isLegacyOpenAICodexProvider(rawProfile.provider);
    if (!legacyId && !legacyProvider) {
      continue;
    }
    const mappedProfileId = legacyId ? options?.profileIdMap?.get(profileId) : undefined;
    const nextProfileId =
      mappedProfileId && !occupied.has(mappedProfileId)
        ? mappedProfileId
        : legacyId
          ? allocateOpenAIProfileId(profileId, new Set([...occupied, ...reservedMappedIds]))
          : profileId;
    // Keep ids deterministic across config and store rewrites so references can be updated once.
    occupied.add(nextProfileId);
    const nextProfile = {
      ...rawProfile,
      provider: OPENAI_PROVIDER_ID,
    };
    if (nextProfileId !== profileId) {
      delete profiles[profileId];
      profileIdMap.set(profileId, nextProfileId);
    }
    profiles[nextProfileId] = nextProfile;
    changed = true;
  }

  return { profileIdMap, changed };
}

function replaceMappedProfileId(value: unknown, profileIdMap: Map<string, string>): unknown {
  if (typeof value === "string") {
    return profileIdMap.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const replaced = replaceMappedProfileId(entry, profileIdMap);
      changed ||= replaced !== entry;
      return replaced;
    });
    return changed ? next : value;
  }
  if (!isRecord(value)) {
    return value;
  }
  let changed = false;
  for (const [key, entry] of Object.entries(value)) {
    const replaced = replaceMappedProfileId(entry, profileIdMap);
    if (replaced !== entry) {
      value[key] = replaced;
      changed = true;
    }
  }
  return changed ? value : value;
}

const AUTH_PROFILE_REF_KEYS = new Set(["authProfileId"]);

function rewriteMappedAuthProfileRefs(
  value: unknown,
  profileIdMap: ReadonlyMap<string, string>,
): boolean {
  if (Array.isArray(value)) {
    return value.reduce(
      (changed, entry) => rewriteMappedAuthProfileRefs(entry, profileIdMap) || changed,
      false,
    );
  }
  if (!isRecord(value)) {
    return false;
  }

  let changed = false;
  for (const [key, entry] of Object.entries(value)) {
    if (AUTH_PROFILE_REF_KEYS.has(key) && typeof entry === "string") {
      const replaced = profileIdMap.get(entry);
      if (replaced && replaced !== entry) {
        value[key] = replaced;
        changed = true;
      }
      continue;
    }
    changed = rewriteMappedAuthProfileRefs(entry, profileIdMap) || changed;
  }
  return changed;
}

function canonicalizeOpenAIAuthOrder(
  auth: Record<string, unknown>,
  profileIdMap: Map<string, string>,
): boolean {
  if (!isRecord(auth.order)) {
    return false;
  }
  const order = auth.order;
  let changed = false;
  const existingCanonicalOrder = Array.isArray(order[OPENAI_PROVIDER_ID])
    ? [...(order[OPENAI_PROVIDER_ID] as unknown[])]
    : [];
  const legacyOrder = Array.isArray(order[LEGACY_OPENAI_CODEX_PROVIDER_ID])
    ? (order[LEGACY_OPENAI_CODEX_PROVIDER_ID] as unknown[])
    : [];
  const canonicalOrder = [...legacyOrder, ...existingCanonicalOrder];
  const occupiedProfileIds = new Set(
    canonicalOrder.filter(
      (entry): entry is string => typeof entry === "string" && !isLegacyOpenAICodexProfileId(entry),
    ),
  );
  for (const profileId of profileIdMap.values()) {
    occupiedProfileIds.add(profileId);
  }

  if (legacyOrder.length > 0) {
    delete order[LEGACY_OPENAI_CODEX_PROVIDER_ID];
    changed = true;
  }

  const rewritten = canonicalOrder
    .map((entry) => {
      if (typeof entry !== "string") {
        return entry;
      }
      const mapped = profileIdMap.get(entry);
      if (mapped) {
        return mapped;
      }
      if (!isLegacyOpenAICodexProfileId(entry)) {
        return entry;
      }
      const canonicalProfileId = allocateOpenAIProfileId(entry, occupiedProfileIds);
      profileIdMap.set(entry, canonicalProfileId);
      return canonicalProfileId;
    })
    .filter(
      (entry, index, entries) => typeof entry !== "string" || entries.indexOf(entry) === index,
    );
  if (rewritten.length > 0) {
    order[OPENAI_PROVIDER_ID] = rewritten;
  } else if (OPENAI_PROVIDER_ID in order) {
    delete order[OPENAI_PROVIDER_ID];
  }
  return changed || rewritten.some((entry, index) => entry !== canonicalOrder[index]);
}

function renameMappedProfileIdKeys(
  record: Record<string, unknown>,
  profileIdMap: Map<string, string>,
): boolean {
  let changed = false;
  for (const [key, value] of Object.entries({ ...record })) {
    const nextKey = profileIdMap.get(key);
    if (!nextKey || nextKey === key) {
      continue;
    }
    delete record[key];
    record[nextKey] = value;
    changed = true;
  }
  return changed;
}

function canonicalizeOpenAILastGood(
  record: Record<string, unknown>,
  profileIdMap: Map<string, string>,
): boolean {
  let changed = false;
  const legacyValue = record[LEGACY_OPENAI_CODEX_PROVIDER_ID];
  const canonicalValue = record[OPENAI_PROVIDER_ID];
  if (legacyValue !== undefined) {
    delete record[LEGACY_OPENAI_CODEX_PROVIDER_ID];
    changed = true;
    if (canonicalValue === undefined && typeof legacyValue === "string") {
      record[OPENAI_PROVIDER_ID] = profileIdMap.get(legacyValue) ?? legacyValue;
    }
  }
  if (typeof record[OPENAI_PROVIDER_ID] === "string") {
    const mapped = profileIdMap.get(record[OPENAI_PROVIDER_ID]);
    if (mapped) {
      record[OPENAI_PROVIDER_ID] = mapped;
      changed = true;
    }
  }
  return changed;
}

/**
 * Canonicalizes config references from the legacy OpenAI Codex provider id to OpenAI.
 *
 * The optional map lets config and store repairs share deterministic profile ids when both surfaces
 * contain the same legacy profile.
 */
export function maybeRepairOpenAICodexAuthConfig(
  cfg: OpenClawConfig,
  options?: { profileIdMap?: ReadonlyMap<string, string> },
): {
  config: OpenClawConfig;
  changes: string[];
  warnings: string[];
} {
  const config = structuredClone(cfg);
  const root = config as Record<string, unknown>;
  const auth = isRecord(root.auth) ? root.auth : undefined;
  const profileIdMap = new Map<string, string>(options?.profileIdMap);
  let changed = false;
  if (isRecord(auth?.profiles)) {
    const rewrite = canonicalizeOpenAIProfileEntries(auth.profiles, { profileIdMap });
    for (const [from, to] of rewrite.profileIdMap) {
      profileIdMap.set(from, to);
    }
    changed ||= rewrite.changed;
  }
  if (auth) {
    const orderChanged = canonicalizeOpenAIAuthOrder(auth, profileIdMap);
    changed ||= orderChanged;
  }
  if (profileIdMap.size > 0 && rewriteMappedAuthProfileRefs(config, profileIdMap)) {
    changed = true;
  }
  if (!changed) {
    return { config, changes: [], warnings: [] };
  }
  return {
    config,
    changes: ["Migrated legacy OpenAI Codex auth profile config to the canonical OpenAI provider."],
    warnings: [],
  };
}

function canonicalizeLegacyOpenAIAuthStore(
  raw: unknown,
  stateRaw: unknown,
  profileIdMap: ReadonlyMap<string, string>,
): number | null {
  // No credential store: still canonicalize the standalone rotation state so the
  // config-backed path (#130018, credentials in config, rotation in auth-state.json)
  // drops stale openai-codex ids. Copy the static map (rotation helpers mutate
  // it); return null — no credentials migrated, so the credential warning stays off.
  if (!isRecord(raw) || !isRecord(raw.profiles)) {
    if (isRecord(stateRaw)) {
      canonicalizeOpenAIAuthRotationState(stateRaw, new Map(profileIdMap));
    }
    return null;
  }
  const rewrite = canonicalizeOpenAIProfileEntries(raw.profiles, { profileIdMap });
  // Canonicalize order/lastGood/usageStats on both the credential store and the
  // standalone rotation state with the SAME profile-id map; state-only refs (no
  // matching credential) are left dangling by the shared helpers, never stale.
  const rotation = canonicalizeOpenAIAuthRotationState(raw, rewrite.profileIdMap);
  if (isRecord(stateRaw)) {
    canonicalizeOpenAIAuthRotationState(stateRaw, rewrite.profileIdMap);
  }
  if (rewrite.profileIdMap.size > 0) {
    replaceMappedProfileId(raw, rewrite.profileIdMap);
  }
  return rewrite.changed || rotation.order || rotation.usage || rotation.lastGood
    ? rewrite.profileIdMap.size
    : null;
}

function canonicalizeOpenAIAuthRotationState(
  auth: Record<string, unknown>,
  profileIdMap: Map<string, string>,
): { order: boolean; usage: boolean; lastGood: boolean } {
  return {
    order: canonicalizeOpenAIAuthOrder(auth, profileIdMap),
    usage: isRecord(auth.usageStats)
      ? renameMappedProfileIdKeys(auth.usageStats, profileIdMap)
      : false,
    lastGood: isRecord(auth.lastGood)
      ? canonicalizeOpenAILastGood(auth.lastGood, profileIdMap)
      : false,
  };
}

function recoverArchivedOpenAICodexAuthProfileIdMap(params: {
  candidates: readonly AuthProfileRepairCandidate[];
  env: NodeJS.ProcessEnv;
}): Map<string, string> {
  const recovered = new Map<string, string>();
  const ambiguous = new Set<string>();
  const agentDirs = [
    resolveSharedMainAuthAgentDir(params.env),
    ...params.candidates.flatMap((candidate) => (candidate.agentDir ? [candidate.agentDir] : [])),
  ];
  const archives = listLegacyAuthProfileArchives({ agentDirs, env: params.env }).filter(
    (archive) => archive.kind === "auth-profiles",
  );
  for (const candidate of params.candidates) {
    const canonicalProfiles = (
      candidate.agentDir
        ? loadPersistedAuthProfileStore(candidate.agentDir)
        : loadPersistedSharedAuthProfileStore(params.env)
    )?.profiles;
    if (!canonicalProfiles) {
      continue;
    }
    for (const archive of archives.filter((entry) =>
      entry.path.startsWith(`${candidate.authPath}.migrated-`),
    )) {
      try {
        const sourceBytes = fs.readFileSync(archive.path);
        const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
        const sourceKey = `auth-profile-v2:${createHash("sha256")
          .update(`${path.resolve(candidate.authPath)}\0${sourceSha256}`)
          .digest("hex")}`;
        const receipt = readLegacyMigrationReceipt(sourceKey, params.env);
        if (!receipt?.removedSource || receipt.sourceSha256 !== sourceSha256) {
          continue;
        }
        const report = JSON.parse(receipt.reportJson) as unknown;
        const sharedStateTarget =
          candidate.agentDir === undefined &&
          resolveSharedAuthStoreOwnership(params.env).location === "state-db";
        if (
          !isRecord(report) ||
          report.format !== "auth-profile-json-to-sqlite-v2" ||
          report.completionStatus !== "completed" ||
          report.targetTable !==
            (sharedStateTarget ? "auth_profile_stores" : "auth_profile_store") ||
          typeof report.archivePath !== "string" ||
          path.resolve(report.archivePath) !== path.resolve(archive.path) ||
          typeof report.targetDatabasePath !== "string" ||
          path.resolve(report.targetDatabasePath) !==
            path.resolve(resolveMigrationTargetDatabasePath(candidate.agentDir, params.env)) ||
          !isRecord(report.expectedProfileSha256)
        ) {
          continue;
        }
        const archivedStore = JSON.parse(sourceBytes.toString("utf8")) as unknown;
        if (!isRecord(archivedStore) || !isRecord(archivedStore.profiles)) {
          continue;
        }
        for (const [legacyProfileId, rawCredential] of Object.entries(archivedStore.profiles)) {
          if (!isLegacyOpenAICodexProfileId(legacyProfileId) || !isRecord(rawCredential)) {
            continue;
          }
          const archivedCredential = parseLegacyCredentialEntry(
            { ...rawCredential, provider: "openai" },
            "openai",
          );
          if (archivedCredential?.type !== "oauth") {
            continue;
          }
          const matches = Object.entries(report.expectedProfileSha256).flatMap(
            ([canonicalProfileId, expectedSha256]) => {
              const credential = canonicalProfiles[canonicalProfileId];
              return typeof expectedSha256 === "string" &&
                credential?.type === "oauth" &&
                credential.provider === "openai" &&
                (hasMatchingOAuthIdentity(archivedCredential, credential) ||
                  areOAuthCredentialsEquivalent(archivedCredential, credential))
                ? [canonicalProfileId]
                : [];
            },
          );
          if (matches.length !== 1) {
            continue;
          }
          const canonicalProfileId = matches[0]!;
          const previous = recovered.get(legacyProfileId);
          if (previous && previous !== canonicalProfileId) {
            recovered.delete(legacyProfileId);
            ambiguous.add(legacyProfileId);
          } else if (!ambiguous.has(legacyProfileId)) {
            recovered.set(legacyProfileId, canonicalProfileId);
          }
        }
      } catch {
        // Archives without a matching verified receipt or parseable identity
        // cannot prove account ownership; leave their session pins untouched.
      }
    }
  }
  return recovered;
}

/** Collects collision-safe OpenAI profile ids across config, SQLite, and legacy agent stores. */
export function collectOpenAICodexAuthProfileStoreIdMap(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Map<string, string> {
  const env = params.env ?? process.env;
  const occupiedProfileIds = new Set<string>();
  const legacyProfileIds = new Set<string>();
  const profileIdMap = new Map<string, string>();
  const candidates = listAuthProfileRepairCandidates(params.cfg, env);
  const addProfileIds = (profileIds: Iterable<string>): void => {
    for (const profileId of profileIds) {
      if (isLegacyOpenAICodexProfileId(profileId)) {
        legacyProfileIds.add(profileId);
      } else {
        occupiedProfileIds.add(profileId);
      }
    }
  };
  addProfileIds(Object.keys(params.cfg.auth?.profiles ?? {}));
  for (const candidate of candidates) {
    const persistedStore = candidate.agentDir
      ? loadPersistedAuthProfileStore(candidate.agentDir)
      : loadPersistedSharedAuthProfileStore(env);
    addProfileIds(Object.keys(persistedStore?.profiles ?? {}));
    if (!fs.existsSync(candidate.authPath)) {
      continue;
    }
    const raw = loadJsonFileThroughSymlink(candidate.authPath);
    if (!isRecord(raw) || !isRecord(raw.profiles)) {
      continue;
    }
    addProfileIds(Object.keys(raw.profiles));
  }
  for (const profileId of [...legacyProfileIds].toSorted((a, b) => a.localeCompare(b))) {
    profileIdMap.set(profileId, allocateOpenAIProfileId(profileId, occupiedProfileIds));
  }
  for (const [legacyProfileId, canonicalProfileId] of recoverArchivedOpenAICodexAuthProfileIdMap({
    candidates,
    env,
  })) {
    if (!profileIdMap.has(legacyProfileId)) {
      profileIdMap.set(legacyProfileId, canonicalProfileId);
    }
  }
  return profileIdMap;
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
