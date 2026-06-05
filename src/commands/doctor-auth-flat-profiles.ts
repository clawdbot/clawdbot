/** Doctor repairs for legacy auth profile JSON stores and OpenAI provider-id migrations. */
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveAgentDir, resolveDefaultAgentDir, listAgentIds } from "../agents/agent-scope.js";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import {
  resolveAuthStatePath,
  resolveAuthStorePath,
  resolveLegacyAuthStorePath,
} from "../agents/auth-profiles/paths.js";
import {
  applyLegacyAuthStore,
  coercePersistedAuthProfileStore,
  loadLegacyAuthProfileStore,
  loadPersistedAuthProfileStore,
} from "../agents/auth-profiles/persisted.js";
import { coerceAuthProfileState } from "../agents/auth-profiles/state.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store.js";
import type {
  AuthProfileCredential,
  AuthProfileState,
  AuthProfileStore,
} from "../agents/auth-profiles/types.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import type { AuthProfileConfig } from "../config/types.auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { loadJsonFile } from "../infra/json-file.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type AuthProfileRepairCandidate = {
  agentDir?: string;
  authPath: string;
};

type LegacyFlatAuthProfileStore = {
  agentDir?: string;
  authPath: string;
  store: AuthProfileStore;
};

type AuthProfileSqliteMigrationCandidate = AuthProfileRepairCandidate & {
  statePath: string;
  legacyPath: string;
};

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

export type LegacyFlatAuthProfileRepairResult = {
  detected: string[];
  changes: string[];
  configChanged?: boolean;
  warnings: string[];
};

const UNSAFE_LEGACY_AUTH_PROFILE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

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
  if (readNonEmptyString(record.token)) {
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
  const provider = readNonEmptyString(raw.provider) ?? providerId;
  const type = inferLegacyCredentialType(raw);
  const email = readNonEmptyString(raw.email);
  if (type === "api_key") {
    const key = readNonEmptyString(raw.key) ?? readNonEmptyString(raw.apiKey);
    return key ? { type, provider, key, ...(email ? { email } : {}) } : null;
  }
  if (type === "token") {
    const token = readNonEmptyString(raw.token);
    return token
      ? {
          type,
          provider,
          token,
          ...(typeof raw.expires === "number" ? { expires: raw.expires } : {}),
          ...(email ? { email } : {}),
        }
      : null;
  }
  if (type === "oauth") {
    const access = readNonEmptyString(raw.access);
    const refresh = readNonEmptyString(raw.refresh);
    if (!access || !refresh || typeof raw.expires !== "number") {
      return null;
    }
    return {
      type,
      provider,
      access,
      refresh,
      expires: raw.expires,
      ...(readNonEmptyString(raw.enterpriseUrl)
        ? { enterpriseUrl: readNonEmptyString(raw.enterpriseUrl) }
        : {}),
      ...(readNonEmptyString(raw.projectId)
        ? { projectId: readNonEmptyString(raw.projectId) }
        : {}),
      ...(readNonEmptyString(raw.accountId)
        ? { accountId: readNonEmptyString(raw.accountId) }
        : {}),
      ...(email ? { email } : {}),
    };
  }
  return null;
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

function addCandidate(
  candidates: Map<string, AuthProfileRepairCandidate>,
  agentDir: string | undefined,
): void {
  const authPath = resolveAuthStorePath(agentDir);
  candidates.set(path.resolve(authPath), { agentDir, authPath });
}

function listExistingAgentDirsFromState(env: NodeJS.ProcessEnv): string[] {
  const root = path.join(resolveStateDir(env), "agents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "agent"))
    .filter((agentDir) => {
      try {
        return fs.statSync(agentDir).isDirectory();
      } catch {
        return false;
      }
    });
}

function listAuthProfileRepairCandidates(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): AuthProfileRepairCandidate[] {
  const candidates = new Map<string, AuthProfileRepairCandidate>();
  addCandidate(candidates, resolveDefaultAgentDir(cfg, env));
  const envAgentDir =
    readNonEmptyString(env.OPENCLAW_AGENT_DIR) ?? readNonEmptyString(env.PI_CODING_AGENT_DIR);
  if (envAgentDir) {
    addCandidate(candidates, envAgentDir);
  }
  for (const agentId of listAgentIds(cfg)) {
    addCandidate(candidates, resolveAgentDir(cfg, agentId, env));
  }
  for (const agentDir of listExistingAgentDirsFromState(env)) {
    addCandidate(candidates, agentDir);
  }
  return [...candidates.values()];
}

function listAuthProfileSqliteMigrationCandidates(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): AuthProfileSqliteMigrationCandidate[] {
  const candidates: AuthProfileSqliteMigrationCandidate[] = [];
  for (const candidate of listAuthProfileRepairCandidates(cfg, env)) {
    candidates.push({
      agentDir: candidate.agentDir,
      authPath: candidate.authPath,
      statePath: resolveAuthStatePath(candidate.agentDir),
      legacyPath: resolveLegacyAuthStorePath(candidate.agentDir),
    });
  }
  return candidates;
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
      readNonEmptyString(profile.key) !== undefined || coerceSecretRef(profile.keyRef) !== null;
    if (hasCanonicalCredential || profile["api_key"] === undefined) {
      continue;
    }
    profile.key = profile["api_key"];
  }
}

function collectAuthProfileStateProfileIds(state: AuthProfileState): string[] {
  const profileIds = new Set<string>();
  for (const entries of Object.values(state.order ?? {})) {
    for (const profileId of entries) {
      profileIds.add(profileId);
    }
  }
  for (const profileId of Object.values(state.lastGood ?? {})) {
    profileIds.add(profileId);
  }
  for (const profileId of Object.keys(state.usageStats ?? {})) {
    profileIds.add(profileId);
  }
  return [...profileIds];
}

function mergeImportedAuthProfiles(params: {
  store: AuthProfileStore;
  profiles: AuthProfileStore["profiles"];
  existingProfileIds: ReadonlySet<string>;
}): AuthProfileStore {
  const profiles = { ...params.store.profiles };
  for (const [profileId, credential] of Object.entries(params.profiles)) {
    if (!params.existingProfileIds.has(profileId)) {
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
  return {
    ...params.store,
    ...(params.state.order
      ? {
          order: {
            ...params.store.order,
            ...Object.fromEntries(
              Object.entries(params.state.order).filter(
                ([provider]) => !params.existingState.order?.[provider],
              ),
            ),
          },
        }
      : {}),
    ...(params.state.lastGood
      ? {
          lastGood: {
            ...params.store.lastGood,
            ...Object.fromEntries(
              Object.entries(params.state.lastGood).filter(
                ([provider]) => !params.existingState.lastGood?.[provider],
              ),
            ),
          },
        }
      : {}),
    ...(params.state.usageStats
      ? {
          usageStats: {
            ...params.store.usageStats,
            ...Object.fromEntries(
              Object.entries(params.state.usageStats).filter(
                ([profileId]) => !params.existingState.usageStats?.[profileId],
              ),
            ),
          },
        }
      : {}),
  };
}

function filterRawAuthProfileState(
  raw: Record<string, unknown>,
  shouldKeepProfileId: (profileId: string) => boolean,
): void {
  if (isRecord(raw.order)) {
    for (const [provider, profileIds] of Object.entries(raw.order)) {
      if (!Array.isArray(profileIds)) {
        continue;
      }
      const kept = profileIds.filter(
        (profileId): profileId is string =>
          typeof profileId === "string" && shouldKeepProfileId(profileId),
      );
      if (kept.length > 0) {
        raw.order[provider] = kept;
      } else {
        delete raw.order[provider];
      }
    }
    if (Object.keys(raw.order).length === 0) {
      delete raw.order;
    }
  }
  if (isRecord(raw.lastGood)) {
    for (const [provider, profileId] of Object.entries(raw.lastGood)) {
      if (typeof profileId !== "string" || !shouldKeepProfileId(profileId)) {
        delete raw.lastGood[provider];
      }
    }
    if (Object.keys(raw.lastGood).length === 0) {
      delete raw.lastGood;
    }
  }
  if (isRecord(raw.usageStats)) {
    for (const profileId of Object.keys(raw.usageStats)) {
      if (!shouldKeepProfileId(profileId)) {
        delete raw.usageStats[profileId];
      }
    }
    if (Object.keys(raw.usageStats).length === 0) {
      delete raw.usageStats;
    }
  }
}

function pruneRawAuthProfileIds(raw: unknown, profileIds: ReadonlySet<string>): void {
  if (!isRecord(raw) || !isRecord(raw.profiles)) {
    return;
  }
  for (const profileId of profileIds) {
    delete raw.profiles[profileId];
  }
  filterRawAuthProfileState(raw, (profileId) => !profileIds.has(profileId));
}

function pickRawAuthProfileIds(
  raw: unknown,
  profileIds: ReadonlySet<string>,
): Record<string, unknown> | null {
  if (!isRecord(raw) || !isRecord(raw.profiles)) {
    return null;
  }
  const profiles = Object.fromEntries(
    Object.entries(raw.profiles).filter(([profileId]) => profileIds.has(profileId)),
  );
  if (Object.keys(profiles).length === 0) {
    return null;
  }
  const next = structuredClone(raw);
  next.profiles = profiles;
  filterRawAuthProfileState(next, (profileId) => profileIds.has(profileId));
  return next;
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

function backupAuthProfileJson(pathname: string, suffix: string, now: () => number): string {
  const backupPath = `${pathname}.${suffix}.${now()}.bak`;
  fs.copyFileSync(pathname, backupPath);
  return backupPath;
}

function backupAndRemoveAuthProfileJson(
  pathname: string,
  suffix: string,
  now: () => number,
): string {
  const backupPath = backupAuthProfileJson(pathname, suffix, now);
  fs.unlinkSync(pathname);
  return backupPath;
}

function writeJsonFile(pathname: string, value: unknown): void {
  fs.writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Imports legacy auth profile JSON and state files into the per-agent SQLite store.
 *
 * JSON files are backed up and removed only after import. OAuth profiles that still depend on
 * unresolved sidecar secrets are kept in JSON so the sidecar migration can run first.
 */
export async function maybeMigrateAuthProfileJsonStoresToSqlite(params: {
  cfg: OpenClawConfig;
  prompter: Pick<DoctorPrompter, "confirmAutoFix">;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}): Promise<LegacyFlatAuthProfileRepairResult> {
  const now = params.now ?? Date.now;
  const env = params.env ?? process.env;
  const candidates = listAuthProfileSqliteMigrationCandidates(params.cfg, env);
  const detected = candidates.filter(
    (candidate) =>
      fs.existsSync(candidate.authPath) ||
      fs.existsSync(candidate.statePath) ||
      fs.existsSync(candidate.legacyPath),
  );
  const result: LegacyFlatAuthProfileRepairResult = {
    detected: detected.flatMap((candidate) =>
      [candidate.authPath, candidate.statePath, candidate.legacyPath].filter((pathname) =>
        fs.existsSync(pathname),
      ),
    ),
    changes: [],
    warnings: [],
  };
  if (detected.length === 0) {
    return result;
  }

  note(
    [
      ...detected.map(
        (candidate) =>
          `- ${shortenHomePath(candidate.authPath)} / ${shortenHomePath(candidate.statePath)}`,
      ),
      `- ${formatCliCommand("openclaw doctor --fix")} imports legacy auth profile JSON into the per-agent SQLite database and removes the old files after backup.`,
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

  for (const candidate of detected) {
    try {
      const rawStore = fs.existsSync(candidate.authPath) ? loadJsonFile(candidate.authPath) : null;
      const unresolvedSidecarProfileIds = new Set(
        collectUnresolvedLegacyOAuthSidecarProfileIds(rawStore),
      );
      const unresolvedSidecarRawStore =
        unresolvedSidecarProfileIds.size > 0
          ? pickRawAuthProfileIds(rawStore, unresolvedSidecarProfileIds)
          : null;
      if (unresolvedSidecarProfileIds.size > 0) {
        // Sidecar-backed OAuth entries cannot move into SQLite until their secret material exists.
        pruneRawAuthProfileIds(rawStore, unresolvedSidecarProfileIds);
        result.warnings.push(
          `Left ${unresolvedSidecarProfileIds.size} legacy OAuth sidecar profile${unresolvedSidecarProfileIds.size === 1 ? "" : "s"} in ${shortenHomePath(candidate.authPath)}; rerun ${formatCliCommand("openclaw doctor --fix")} after sidecar migration or re-authenticate those profiles.`,
        );
      }
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
      const legacyStore = loadLegacyAuthProfileStore(candidate.agentDir);
      const rawState = fs.existsSync(candidate.statePath)
        ? loadJsonFile(candidate.statePath)
        : null;
      const state = coerceAuthProfileState(rawState);
      if (!canonicalStore && !legacyStore && !hasAuthProfileState(state) && !awsSdkMarkerStore) {
        result.warnings.push(
          `Left auth profile JSON in place for ${shortenHomePath(candidate.authPath)} because no importable auth profiles or state were found.`,
        );
        continue;
      }

      const existing = loadPersistedAuthProfileStore(candidate.agentDir) ?? {
        version: AUTH_STORE_VERSION,
        profiles: {},
      };
      const existingProfileIds = new Set(Object.keys(existing.profiles));
      const existingState = coerceAuthProfileState(existing);
      let next: AuthProfileStore = { ...existing };
      if (legacyStore) {
        const legacyAsStore: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
        applyLegacyAuthStore(legacyAsStore, legacyStore);
        next = mergeImportedAuthProfiles({
          store: next,
          profiles: legacyAsStore.profiles,
          existingProfileIds,
        });
      }
      if (canonicalStore) {
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
      if (hasAuthProfileState(state)) {
        next = mergeImportedAuthProfileState({ store: next, state, existingState });
      }

      if (canonicalStore || legacyStore || hasAuthProfileState(state)) {
        const stateProfileIds = [
          ...collectAuthProfileStateProfileIds(state),
          ...(canonicalStore
            ? collectAuthProfileStateProfileIds(coerceAuthProfileState(canonicalStore))
            : []),
        ];
        saveAuthProfileStore(next, candidate.agentDir, {
          filterExternalAuthProfiles: false,
          // Imported order/usage state may mention externally-backed profiles not in this store.
          preserveStateProfileIds: stateProfileIds,
          syncExternalCli: false,
        });
      }

      const backups: string[] = [];
      if (fs.existsSync(candidate.authPath)) {
        if (unresolvedSidecarRawStore) {
          backups.push(backupAuthProfileJson(candidate.authPath, "sqlite-import", now));
          writeJsonFile(candidate.authPath, unresolvedSidecarRawStore);
        } else {
          backups.push(backupAndRemoveAuthProfileJson(candidate.authPath, "sqlite-import", now));
        }
      }
      if (fs.existsSync(candidate.statePath)) {
        backups.push(backupAndRemoveAuthProfileJson(candidate.statePath, "sqlite-import", now));
      }
      if (fs.existsSync(candidate.legacyPath)) {
        backups.push(backupAndRemoveAuthProfileJson(candidate.legacyPath, "sqlite-import", now));
      }
      result.changes.push(
        `Migrated auth profile JSON for ${shortenHomePath(candidate.authPath)} into SQLite (backup${backups.length === 1 ? "" : "s"}: ${backups.map(shortenHomePath).join(", ")}).`,
      );
      if (awsSdkMarkerStore) {
        result.changes.push(
          `Moved aws-sdk profile metadata from ${shortenHomePath(candidate.authPath)} to auth.profiles before removing the legacy auth profile JSON.`,
        );
      }
    } catch (err) {
      result.warnings.push(
        `Failed to migrate auth profile JSON for ${shortenHomePath(candidate.authPath)}: ${String(err)}`,
      );
    }
  }
  clearRuntimeAuthProfileStoreSnapshots();
  if (result.changes.length > 0) {
    note(result.changes.map((change) => `- ${change}`).join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.map((warning) => `- ${warning}`).join("\n"), "Doctor warnings");
  }
  return result;
}

function resolveLegacyFlatStore(
  candidate: AuthProfileRepairCandidate,
): LegacyFlatAuthProfileStore | null {
  if (!fs.existsSync(candidate.authPath)) {
    return null;
  }
  const raw = loadJsonFile(candidate.authPath);
  if (!raw || typeof raw !== "object" || "profiles" in raw) {
    return null;
  }
  const store = coerceLegacyFlatAuthProfileStore(raw);
  if (!store || Object.keys(store.profiles).length === 0) {
    return null;
  }
  return {
    ...candidate,
    store,
  };
}

function backupAuthProfileStore(authPath: string, now: () => number): string {
  const backupPath = `${authPath}.legacy-flat.${now()}.bak`;
  fs.copyFileSync(authPath, backupPath);
  return backupPath;
}

function backupAwsSdkProfileMarkerStore(authPath: string, now: () => number): string {
  const backupPath = `${authPath}.aws-sdk-profile.${now()}.bak`;
  fs.copyFileSync(authPath, backupPath);
  return backupPath;
}

function resolveAwsSdkAuthProfileMarkerStore(
  candidate: AuthProfileRepairCandidate,
): AwsSdkAuthProfileMarkerStore | null {
  if (!fs.existsSync(candidate.authPath)) {
    return null;
  }
  const raw = loadJsonFile(candidate.authPath);
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

/**
 * Rewrites pre-versioned flat auth profile JSON into canonical profile stores.
 *
 * Also lifts aws-sdk profile markers into config because those entries are routing metadata, not
 * credentials, and the runtime no longer treats them as stored secrets.
 */
export async function maybeRepairLegacyFlatAuthProfileStores(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}): Promise<LegacyFlatAuthProfileRepairResult> {
  const now = params.now ?? Date.now;
  const env = params.env ?? process.env;
  const legacyStores = listAuthProfileRepairCandidates(params.cfg, env)
    .map(resolveLegacyFlatStore)
    .filter((entry): entry is LegacyFlatAuthProfileStore => entry !== null);
  const awsSdkMarkerStores = listAuthProfileRepairCandidates(params.cfg, env)
    .map(resolveAwsSdkAuthProfileMarkerStore)
    .filter((entry): entry is AwsSdkAuthProfileMarkerStore => entry !== null);

  const result: LegacyFlatAuthProfileRepairResult = {
    detected: [
      ...legacyStores.map((entry) => entry.authPath),
      ...awsSdkMarkerStores.map((entry) => entry.authPath),
    ],
    changes: [],
    warnings: [],
  };
  if (legacyStores.length === 0 && awsSdkMarkerStores.length === 0) {
    return result;
  }

  const noteLines = [
    ...legacyStores.map(
      (entry) => `- ${shortenHomePath(entry.authPath)} uses the legacy flat auth profile format.`,
    ),
    ...awsSdkMarkerStores.map(
      (entry) =>
        `- ${shortenHomePath(entry.authPath)} contains aws-sdk profile markers that belong in openclaw.json auth.profiles.`,
    ),
  ];
  if (legacyStores.length > 0) {
    noteLines.push(
      `- The gateway expects the canonical version/profiles store; ${formatCliCommand("openclaw doctor --fix")} rewrites this legacy shape with a backup.`,
    );
  }
  if (awsSdkMarkerStores.length > 0) {
    noteLines.push(
      `- AWS SDK profile markers are routing metadata, not stored credentials; ${formatCliCommand("openclaw doctor --fix")} moves them to config with a backup.`,
    );
  }
  note(noteLines.join("\n"), "Auth profiles");

  const shouldRepair = await params.prompter.confirmAutoFix({
    message: "Repair legacy auth-profiles.json files now?",
    initialValue: true,
  });
  if (!shouldRepair) {
    return result;
  }

  for (const entry of legacyStores) {
    try {
      const backupPath = backupAuthProfileStore(entry.authPath, now);
      saveAuthProfileStore(entry.store, entry.agentDir, { syncExternalCli: false });
      fs.unlinkSync(entry.authPath);
      result.changes.push(
        `Migrated ${shortenHomePath(entry.authPath)} to the SQLite auth profile store (backup: ${shortenHomePath(backupPath)}).`,
      );
    } catch (err) {
      result.warnings.push(`Failed to rewrite ${shortenHomePath(entry.authPath)}: ${String(err)}`);
    }
  }
  for (const entry of awsSdkMarkerStores) {
    try {
      const backupPath = backupAwsSdkProfileMarkerStore(entry.authPath, now);
      const configProfiles = ensureConfigAuthProfiles(params.cfg);
      for (const marker of entry.profiles) {
        configProfiles[marker.profileId] = {
          provider: marker.provider,
          mode: "aws-sdk",
          ...(marker.email ? { email: marker.email } : {}),
          ...(marker.displayName ? { displayName: marker.displayName } : {}),
        };
      }
      removeAwsSdkProfileMarkers(
        entry.raw,
        entry.profiles.map((profile) => profile.profileId),
      );
      fs.writeFileSync(entry.authPath, `${JSON.stringify(entry.raw, null, 2)}\n`);
      result.changes.push(
        `Moved aws-sdk profile metadata from ${shortenHomePath(entry.authPath)} to auth.profiles (backup: ${shortenHomePath(backupPath)}).`,
      );
    } catch (err) {
      result.warnings.push(
        `Failed to migrate aws-sdk profile markers from ${shortenHomePath(entry.authPath)}: ${String(err)}`,
      );
    }
  }
  clearRuntimeAuthProfileStoreSnapshots();
  if (result.changes.length > 0) {
    note(result.changes.map((change) => `- ${change}`).join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.map((warning) => `- ${warning}`).join("\n"), "Doctor warnings");
  }
  return result;
}

type CanonicalApiKeyAliasRepair = {
  authPath: string;
  raw: Record<string, unknown>;
  profileIds: string[];
};

function resolveCanonicalApiKeyAliasRepair(
  candidate: AuthProfileRepairCandidate,
): CanonicalApiKeyAliasRepair | null {
  if (!fs.existsSync(candidate.authPath)) {
    return null;
  }
  const raw = loadJsonFile(candidate.authPath);
  if (!isRecord(raw) || !isRecord(raw.profiles)) {
    return null;
  }
  const profileIds: string[] = [];
  for (const [profileId, value] of Object.entries(raw.profiles)) {
    if (!isRecord(value)) {
      continue;
    }
    const type = readNonEmptyString(value.type) ?? readNonEmptyString(value.mode);
    const hasApiKeyField =
      readNonEmptyString(value["api_key"]) !== undefined ||
      coerceSecretRef(value["api_key"]) !== null;
    const hasCanonicalKey =
      readNonEmptyString(value.key) !== undefined || coerceSecretRef(value.key) !== null;
    const hasCanonicalKeyRef = coerceSecretRef(value.keyRef) !== null;
    if (type === "api_key" && hasApiKeyField && !hasCanonicalKey && !hasCanonicalKeyRef) {
      profileIds.push(profileId);
    }
  }
  return profileIds.length > 0 ? { authPath: candidate.authPath, raw, profileIds } : null;
}

function backupCanonicalApiKeyAlias(authPath: string, now: () => number): string {
  const backupPath = `${authPath}.api-key-alias.${now()}.bak`;
  fs.copyFileSync(authPath, backupPath);
  return backupPath;
}

/**
 * Repairs auth profile JSON that used the historical "api_key" credential field.
 *
 * Runtime parsing reads "key" or "keyRef"; doctor preserves the original file as a backup before
 * moving the alias into the canonical key slot.
 */
export async function maybeRepairCanonicalApiKeyFieldAlias(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}): Promise<LegacyFlatAuthProfileRepairResult> {
  const now = params.now ?? Date.now;
  const env = params.env ?? process.env;
  const repairs = listAuthProfileRepairCandidates(params.cfg, env)
    .map(resolveCanonicalApiKeyAliasRepair)
    .filter((entry): entry is CanonicalApiKeyAliasRepair => entry !== null);

  const result: LegacyFlatAuthProfileRepairResult = {
    detected: repairs.map((entry) => entry.authPath),
    changes: [],
    warnings: [],
  };
  if (repairs.length === 0) {
    return result;
  }

  const noteLines = repairs.map(
    (entry) =>
      `- ${shortenHomePath(entry.authPath)} has ${entry.profileIds.length} profile(s) using the non-canonical "api_key" field; the canonical field is "key".`,
  );
  noteLines.push(
    `- Runtime auth parsing only reads canonical "key" and "keyRef" fields, so these profiles are silently skipped; ${formatCliCommand("openclaw doctor --fix")} rewrites "api_key" to "key" with a backup.`,
  );
  note(noteLines.join("\n"), "Auth profiles");

  const shouldRepair = await params.prompter.confirmAutoFix({
    message: 'Rewrite non-canonical "api_key" fields to "key" now?',
    initialValue: true,
  });
  if (!shouldRepair) {
    return result;
  }

  for (const entry of repairs) {
    try {
      const backupPath = backupCanonicalApiKeyAlias(entry.authPath, now);
      const profiles = entry.raw.profiles as Record<string, Record<string, unknown>>;
      for (const profileId of entry.profileIds) {
        const profile = profiles[profileId];
        if (!isRecord(profile)) {
          continue;
        }
        profile.key = profile["api_key"];
        delete profile["api_key"];
      }
      fs.writeFileSync(entry.authPath, `${JSON.stringify(entry.raw, null, 2)}\n`);
      result.changes.push(
        `Rewrote ${entry.profileIds.length} "api_key" field(s) to "key" in ${shortenHomePath(entry.authPath)} (backup: ${shortenHomePath(backupPath)}).`,
      );
    } catch (err) {
      result.warnings.push(
        `Failed to rewrite "api_key" fields in ${shortenHomePath(entry.authPath)}: ${String(err)}`,
      );
    }
  }
  clearRuntimeAuthProfileStoreSnapshots();
  if (result.changes.length > 0) {
    note(result.changes.map((change) => `- ${change}`).join("\n"), "Doctor changes");
  }
  if (result.warnings.length > 0) {
    note(result.warnings.map((warning) => `- ${warning}`).join("\n"), "Doctor warnings");
  }
  return result;
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

type OpenAICodexAuthStoreRepair = {
  authPath: string;
  raw: Record<string, unknown>;
  profileIdMap: Map<string, string>;
  changed: boolean;
};

function resolveOpenAICodexAuthStoreRepair(
  candidate: AuthProfileRepairCandidate,
  profileIdMap?: ReadonlyMap<string, string>,
): OpenAICodexAuthStoreRepair | null {
  if (!fs.existsSync(candidate.authPath)) {
    return null;
  }
  const raw = loadJsonFile(candidate.authPath);
  if (!isRecord(raw) || !isRecord(raw.profiles)) {
    return null;
  }
  const rewrite = canonicalizeOpenAIProfileEntries(raw.profiles, { profileIdMap });
  const orderChanged = canonicalizeOpenAIAuthOrder(raw, rewrite.profileIdMap);
  const usageChanged = isRecord(raw.usageStats)
    ? renameMappedProfileIdKeys(raw.usageStats, rewrite.profileIdMap)
    : false;
  const lastGoodChanged = isRecord(raw.lastGood)
    ? canonicalizeOpenAILastGood(raw.lastGood, rewrite.profileIdMap)
    : false;
  if (rewrite.profileIdMap.size > 0) {
    replaceMappedProfileId(raw, rewrite.profileIdMap);
  }
  const changed = rewrite.changed || orderChanged || usageChanged || lastGoodChanged;
  return changed
    ? {
        authPath: candidate.authPath,
        raw,
        profileIdMap: rewrite.profileIdMap,
        changed,
      }
    : null;
}

/** Collects deterministic legacy-to-canonical OpenAI profile ids across all agent stores. */
export function collectOpenAICodexAuthProfileStoreIdMap(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Map<string, string> {
  const env = params.env ?? process.env;
  const occupiedProfileIds = new Set<string>();
  const legacyProfileIds = new Set<string>();
  const profileIdMap = new Map<string, string>();
  for (const candidate of listAuthProfileRepairCandidates(params.cfg, env)) {
    if (!fs.existsSync(candidate.authPath)) {
      continue;
    }
    const raw = loadJsonFile(candidate.authPath);
    if (!isRecord(raw) || !isRecord(raw.profiles)) {
      continue;
    }
    for (const profileId of Object.keys(raw.profiles)) {
      if (isLegacyOpenAICodexProfileId(profileId)) {
        legacyProfileIds.add(profileId);
      } else {
        occupiedProfileIds.add(profileId);
      }
    }
  }
  for (const profileId of [...legacyProfileIds].toSorted((a, b) => a.localeCompare(b))) {
    profileIdMap.set(profileId, allocateOpenAIProfileId(profileId, occupiedProfileIds));
  }
  return profileIdMap;
}

function backupOpenAIProviderUnification(authPath: string, now: () => number): string {
  const backupPath = `${authPath}.openai-provider-unification.${now()}.bak`;
  fs.copyFileSync(authPath, backupPath);
  return backupPath;
}

/**
 * Rewrites legacy OpenAI Codex auth profiles in JSON stores to the canonical OpenAI provider id.
 */
export async function maybeRepairOpenAICodexAuthProfileStores(params: {
  cfg: OpenClawConfig;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}): Promise<LegacyFlatAuthProfileRepairResult> {
  const now = params.now ?? Date.now;
  const env = params.env ?? process.env;
  const profileIdMap = collectOpenAICodexAuthProfileStoreIdMap({ cfg: params.cfg, env });
  const repairs = listAuthProfileRepairCandidates(params.cfg, env)
    .map((candidate) => resolveOpenAICodexAuthStoreRepair(candidate, profileIdMap))
    .filter((entry): entry is OpenAICodexAuthStoreRepair => entry !== null);
  const result: LegacyFlatAuthProfileRepairResult = {
    detected: repairs.map((entry) => entry.authPath),
    changes: [],
    warnings: [],
  };
  if (repairs.length === 0) {
    return result;
  }
  for (const entry of repairs) {
    try {
      const backupPath = backupOpenAIProviderUnification(entry.authPath, now);
      fs.writeFileSync(entry.authPath, `${JSON.stringify(entry.raw, null, 2)}\n`);
      const movedCount = entry.profileIdMap.size;
      result.changes.push(
        `Migrated ${movedCount} OpenAI Codex auth profile(s) in ${shortenHomePath(entry.authPath)} to provider "openai" (backup: ${shortenHomePath(backupPath)}).`,
      );
    } catch (err) {
      result.warnings.push(
        `Failed to migrate OpenAI Codex auth profiles in ${shortenHomePath(entry.authPath)}: ${String(err)}`,
      );
    }
  }
  clearRuntimeAuthProfileStoreSnapshots();
  return result;
}
