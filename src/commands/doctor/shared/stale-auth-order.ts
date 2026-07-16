// Repairs configured auth orders whose referenced profiles no longer exist.
import fs from "node:fs";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentDir,
  resolveDefaultAgentDir,
} from "../../../agents/agent-scope-config.js";
import { listRuntimeExternalAuthProfiles } from "../../../agents/auth-profiles/external-auth.js";
import { resolveAuthProfileOrder } from "../../../agents/auth-profiles/order.js";
import {
  resolveAuthStatePath,
  resolveAuthStorePath,
  resolveLegacyAuthStorePath,
} from "../../../agents/auth-profiles/paths.js";
import {
  coercePersistedAuthProfileStore,
  mergeAuthProfileStores,
} from "../../../agents/auth-profiles/persisted.js";
import {
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabaseOwnerId,
  resolveAuthProfileDatabasePath,
  resolveAuthProfileDatabaseFilePaths,
} from "../../../agents/auth-profiles/sqlite.js";
import {
  coerceAuthProfileState,
  mergeAuthProfileState,
} from "../../../agents/auth-profiles/state.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import { resolveProviderIdForAuth } from "../../../agents/provider-auth-aliases.js";
import { resolveStateDir } from "../../../config/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../../routing/session-key.js";
import {
  inspectOpenClawAgentDatabaseOwner,
  listOpenClawRegisteredAgentDatabases,
} from "../../../state/openclaw-agent-db.js";
import { isRecord, resolveUserPath } from "../../../utils.js";

type StaleConfiguredAuthOrder = {
  provider: string;
  staleProfileCount: number;
};

type LoadedAuthStores =
  | {
      status: "ready";
      stores: AuthProfileStore[];
      activeStores: AuthProfileStore[];
      runtimeProfileIds: Set<string>;
    }
  | { status: "blocked"; warnings: string[] };

const AUTH_PROFILE_MODES = new Set(["api_key", "aws-sdk", "oauth", "token"]);
const INVALID_SQLITE_STORE_WARNING =
  "- Skipped auth.order repair because a SQLite auth profile store is unreadable, unavailable, or contains invalid credentials; repair or re-import that agent's auth store, then rerun doctor.";

function isProfileIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((profileId) => typeof profileId === "string");
}

function readValidConfiguredAuthOrder(cfg: OpenClawConfig): Record<string, string[]> | undefined {
  const order: unknown = cfg.auth?.order;
  if (!isRecord(order)) {
    return undefined;
  }
  const result: Record<string, string[]> = {};
  for (const [provider, profileIds] of Object.entries(order)) {
    if (!isProfileIdList(profileIds)) {
      return undefined;
    }
    result[provider] = profileIds;
  }
  return result;
}

function hasValidConfiguredAuthProfiles(cfg: OpenClawConfig): boolean {
  const profiles: unknown = cfg.auth?.profiles;
  if (profiles === undefined) {
    return true;
  }
  return (
    isRecord(profiles) &&
    Object.values(profiles).every(
      (profile) =>
        isRecord(profile) &&
        typeof profile.provider === "string" &&
        typeof profile.mode === "string" &&
        AUTH_PROFILE_MODES.has(profile.mode),
    )
  );
}

function hasNonemptyConfiguredAuthOrder(cfg: OpenClawConfig): boolean {
  const order = readValidConfiguredAuthOrder(cfg);
  return Boolean(order && Object.values(order).some((profileIds) => profileIds.length > 0));
}

function inspectAuthPath(pathname: string): "present" | "missing" | "unreadable" {
  try {
    fs.statSync(pathname);
    return "present";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return "unreadable";
    }
  }
  try {
    // A dangling final symlink is unavailable state, not a stale registry row.
    fs.lstatSync(pathname);
    return "unreadable";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return "unreadable";
    }
  }

  // Accept ENOENT only when the missing suffix has no broken symlink or
  // non-directory ancestor masking an unavailable auth source.
  let ancestor = path.dirname(pathname);
  while (true) {
    try {
      const stat = fs.lstatSync(ancestor);
      if (!stat.isSymbolicLink()) {
        return stat.isDirectory() ? "missing" : "unreadable";
      }
      try {
        return fs.statSync(ancestor).isDirectory() ? "missing" : "unreadable";
      } catch {
        return "unreadable";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return "unreadable";
      }
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      return "missing";
    }
    ancestor = parent;
  }
}

function inspectUnmigratedAuthStoreSources(agentDir: string): "present" | "missing" | "unreadable" {
  const results = new Set(
    [
      resolveAuthStorePath(agentDir),
      resolveAuthStatePath(agentDir),
      resolveLegacyAuthStorePath(agentDir),
    ].map((pathname) => inspectAuthPath(pathname)),
  );
  if (results.has("unreadable")) {
    return "unreadable";
  }
  return results.has("present") ? "present" : "missing";
}

function inspectAuthDatabaseFiles(agentDir: string): "present" | "missing" | "unreadable" {
  const [databasePath, ...sidecarPaths] = resolveAuthProfileDatabaseFilePaths(agentDir);
  if (!databasePath) {
    return "unreadable";
  }
  const availability = inspectAuthPath(databasePath);
  const sidecarAvailability = sidecarPaths.map((pathname) => inspectAuthPath(pathname));
  if (
    availability === "unreadable" ||
    sidecarAvailability.some((status) => status === "unreadable")
  ) {
    return "unreadable";
  }
  if (availability === "present") {
    return "present";
  }
  return sidecarAvailability.every((sidecar) => sidecar === "missing") ? "missing" : "unreadable";
}

function loadCompletePersistedStore(
  agentDir: string,
):
  | { status: "ok"; store: AuthProfileStore | null; hasAuthTables: boolean }
  | { status: "invalid" } {
  const inspection = inspectPersistedAuthProfileStoreRaw(agentDir);
  const stateInspection = inspectPersistedAuthProfileStateRaw(agentDir);
  if (inspection.status === "unreadable" || stateInspection.status === "unreadable") {
    return { status: "invalid" };
  }
  const storeMissingReason = inspection.status === "missing" ? inspection.reason : undefined;
  const stateMissingReason =
    stateInspection.status === "missing" ? stateInspection.reason : undefined;
  if (storeMissingReason === "database" || stateMissingReason === "database") {
    return storeMissingReason === "database" && stateMissingReason === "database"
      ? { status: "ok", store: null, hasAuthTables: false }
      : { status: "invalid" };
  }
  if ((storeMissingReason === "table") !== (stateMissingReason === "table")) {
    return { status: "invalid" };
  }
  if (storeMissingReason === "table") {
    return { status: "ok", store: null, hasAuthTables: false };
  }
  const persistedState =
    stateInspection.status === "readable" ? coerceAuthProfileState(stateInspection.raw) : {};
  if (inspection.status === "missing") {
    return stateInspection.status === "missing"
      ? { status: "ok", store: null, hasAuthTables: true }
      : {
          status: "ok",
          store: { version: 1, profiles: {}, ...persistedState },
          hasAuthTables: true,
        };
  }
  if (!isRecord(inspection.raw) || !isRecord(inspection.raw.profiles)) {
    return { status: "invalid" };
  }
  const store = coercePersistedAuthProfileStore(inspection.raw);
  const rawProfileIds = Object.keys(inspection.raw.profiles);
  if (
    !store ||
    rawProfileIds.length !== Object.keys(store.profiles).length ||
    rawProfileIds.some((profileId) => !Object.hasOwn(store.profiles, profileId))
  ) {
    // Coercion deliberately drops malformed credentials. A dropped id may be
    // the user's explicit selection, so doctor must not infer that it vanished.
    return { status: "invalid" };
  }
  return {
    status: "ok",
    store: {
      ...store,
      ...mergeAuthProfileState(coerceAuthProfileState(inspection.raw), persistedState),
    },
    hasAuthTables: true,
  };
}

function listRetainedStateAgentDirs(env: NodeJS.ProcessEnv): string[] | null {
  const agentsRoot = path.join(resolveStateDir(env), "agents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? [] : null;
  }

  const agentDirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const agentDir = path.join(agentsRoot, entry.name, "agent");
    try {
      if (fs.statSync(agentDir).isDirectory()) {
        agentDirs.push(path.resolve(agentDir));
      } else {
        return null;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (entry.isSymbolicLink() || (code !== "ENOENT" && code !== "ENOTDIR")) {
        return null;
      }
      try {
        // A dangling `agents/<id>/agent` symlink is an unavailable store, not
        // proof that the retained agent has no credentials.
        fs.lstatSync(agentDir);
        return null;
      } catch (lstatError) {
        const lstatCode = (lstatError as NodeJS.ErrnoException).code;
        if (lstatCode !== "ENOENT" && lstatCode !== "ENOTDIR") {
          return null;
        }
      }
    }
  }
  return agentDirs;
}

function loadConfiguredAgentAuthStores(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): LoadedAuthStores | undefined {
  const order = readValidConfiguredAuthOrder(cfg);
  if (!order || !hasValidConfiguredAuthProfiles(cfg)) {
    return undefined;
  }
  // Every secondary agent inherits the legacy main store at runtime, even when
  // `agents.list` names a different default agent.
  const mainAgentDir = path.resolve(resolveDefaultAgentDir({}, env));
  const activeAgentDirs = new Set<string>();
  const expectedAgentIdsByDir = new Map<string, Set<string>>();
  const addExpectedAgentDir = (agentDir: string, agentId: string) => {
    const owners = expectedAgentIdsByDir.get(agentDir) ?? new Set<string>();
    owners.add(normalizeAgentId(agentId));
    expectedAgentIdsByDir.set(agentDir, owners);
  };
  addExpectedAgentDir(mainAgentDir, DEFAULT_AGENT_ID);
  for (const agentId of listAgentIds(cfg)) {
    const agentDir = path.resolve(resolveAgentDir(cfg, agentId, env));
    activeAgentDirs.add(agentDir);
    addExpectedAgentDir(agentDir, agentId);
  }
  const envAgentDir =
    env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim() || undefined;
  if (envAgentDir) {
    const agentDir = path.resolve(resolveUserPath(envAgentDir, env));
    activeAgentDirs.add(agentDir);
    addExpectedAgentDir(agentDir, resolveAuthProfileDatabaseOwnerId(agentDir));
  }
  const retainedAgentDirs = listRetainedStateAgentDirs(env);
  if (!retainedAgentDirs) {
    return { status: "blocked", warnings: [INVALID_SQLITE_STORE_WARNING] };
  }
  const agentDirs = new Set([mainAgentDir, ...activeAgentDirs, ...retainedAgentDirs]);

  const entries: Array<{
    agentDir: string;
    databasePath: string;
    store: AuthProfileStore | null;
  }> = [];
  for (const agentDir of agentDirs) {
    const expectedAgentIds = expectedAgentIdsByDir.get(agentDir);
    if (expectedAgentIds && expectedAgentIds.size !== 1) {
      return { status: "blocked", warnings: [INVALID_SQLITE_STORE_WARNING] };
    }
    const legacyAvailability = inspectUnmigratedAuthStoreSources(agentDir);
    if (legacyAvailability === "unreadable") {
      return { status: "blocked", warnings: [INVALID_SQLITE_STORE_WARNING] };
    }
    if (legacyAvailability === "present") {
      return undefined;
    }
    const databasePath = path.resolve(resolveAuthProfileDatabasePath(agentDir));
    const availability = inspectAuthDatabaseFiles(agentDir);
    if (availability === "unreadable") {
      return { status: "blocked", warnings: [INVALID_SQLITE_STORE_WARNING] };
    }
    const owner =
      availability === "present" ? inspectOpenClawAgentDatabaseOwner(databasePath) : undefined;
    if (owner) {
      if (
        owner.status === "unreadable" ||
        (expectedAgentIds && owner.status === "owned" && !expectedAgentIds.has(owner.agentId))
      ) {
        return { status: "blocked", warnings: [INVALID_SQLITE_STORE_WARNING] };
      }
    }
    const loaded = loadCompletePersistedStore(agentDir);
    if (loaded.status === "invalid") {
      return { status: "blocked", warnings: [INVALID_SQLITE_STORE_WARNING] };
    }
    if (owner?.status === "unowned" && loaded.hasAuthTables) {
      return { status: "blocked", warnings: [INVALID_SQLITE_STORE_WARNING] };
    }
    entries.push({ agentDir, databasePath, store: loaded.store });
  }

  let registeredDatabases: Array<{ agentId: string; path: string }>;
  try {
    const registryEntries = listOpenClawRegisteredAgentDatabases({ env });
    if (registryEntries.some((entry) => !entry.path.trim() || !path.isAbsolute(entry.path))) {
      return undefined;
    }
    const authDatabaseBasename = path.basename(resolveAuthProfileDatabasePath(mainAgentDir));
    registeredDatabases = registryEntries.flatMap((entry) =>
      path.basename(entry.path) === authDatabaseBasename
        ? [{ agentId: entry.agentId, path: path.resolve(entry.path) }]
        : [],
    );
  } catch {
    // The registry participates in the profile-existence proof. Preserve
    // explicit routing when it cannot be inspected safely.
    return undefined;
  }
  const entriesByDatabasePath = new Map(entries.map((entry) => [entry.databasePath, entry]));
  const registeredEntries: Array<{ agentDir: string; store: AuthProfileStore | null }> = [];
  const registeredOwnersByPath = new Map<string, Set<string>>();
  for (const entry of registeredDatabases) {
    const owners = registeredOwnersByPath.get(entry.path) ?? new Set<string>();
    owners.add(entry.agentId);
    registeredOwnersByPath.set(entry.path, owners);
  }
  for (const [databasePath, owners] of registeredOwnersByPath) {
    const agentDir = path.dirname(databasePath);
    if (path.resolve(resolveAuthProfileDatabasePath(agentDir)) !== databasePath) {
      continue;
    }
    const legacyAvailability = inspectUnmigratedAuthStoreSources(agentDir);
    if (legacyAvailability === "unreadable") {
      return { status: "blocked", warnings: [INVALID_SQLITE_STORE_WARNING] };
    }
    if (legacyAvailability === "present") {
      return undefined;
    }
    const availability = inspectAuthDatabaseFiles(agentDir);
    if (availability === "missing") {
      // Registry rows are durable history and agent deletion does not prune
      // them, so a cleanly absent pathname is stale rather than a live store.
      continue;
    }
    if (availability === "unreadable") {
      return { status: "blocked", warnings: [INVALID_SQLITE_STORE_WARNING] };
    }
    const owner = inspectOpenClawAgentDatabaseOwner(databasePath);
    if (owner.status !== "owned" || !owners.has(owner.agentId)) {
      return { status: "blocked", warnings: [INVALID_SQLITE_STORE_WARNING] };
    }
    const loaded = loadCompletePersistedStore(agentDir);
    if (loaded.status === "invalid") {
      return { status: "blocked", warnings: [INVALID_SQLITE_STORE_WARNING] };
    }
    const knownEntry = entriesByDatabasePath.get(databasePath);
    if (knownEntry) {
      knownEntry.store = loaded.store;
      continue;
    }
    registeredEntries.push({ agentDir, store: loaded.store });
  }

  const emptyStore: AuthProfileStore = { version: 1, profiles: {} };
  const mainStore = entries.find((entry) => entry.agentDir === mainAgentDir)?.store ?? emptyStore;
  const agentStores = entries.map((entry) => {
    const localStore = entry.store ?? emptyStore;
    return entry.agentDir === mainAgentDir
      ? mainStore
      : mergeAuthProfileStores(mainStore, localStore, {
          preserveBaseRuntimeExternalProfiles: true,
        });
  });
  const activeStores = entries.flatMap((entry, index) =>
    activeAgentDirs.has(entry.agentDir) ? [agentStores[index] ?? emptyStore] : [],
  );
  const stores = [
    ...agentStores,
    ...registeredEntries.flatMap((entry) => (entry.store ? [entry.store] : [])),
  ];

  const providerIds = Object.keys(order);
  const profileIds = Object.values(order).flat();
  const runtimeProfileIds = new Set<string>();
  const runtimeEntries = [
    ...entries.map((entry, index) => ({
      agentDir: entry.agentDir,
      store: agentStores[index] ?? emptyStore,
    })),
    ...registeredEntries.map((entry) => ({
      agentDir: entry.agentDir,
      store: mergeAuthProfileStores(mainStore, entry.store ?? emptyStore, {
        preserveBaseRuntimeExternalProfiles: true,
      }),
    })),
  ];
  try {
    for (const entry of runtimeEntries) {
      const externalProfiles = listRuntimeExternalAuthProfiles({
        store: entry.store,
        agentDir: entry.agentDir,
        env,
        externalCli: {
          allowKeychainPrompt: false,
          config: cfg,
          externalCliProviderIds: providerIds,
          externalCliProfileIds: profileIds,
        },
      });
      for (const profile of externalProfiles) {
        runtimeProfileIds.add(profile.profileId);
      }
    }
  } catch {
    // Runtime discovery participates in the existence proof. Preserve explicit
    // config if it cannot be inspected without prompting.
    return undefined;
  }
  return { status: "ready", stores, activeStores, runtimeProfileIds };
}

function removeAuthOrderKeys(cfg: OpenClawConfig, providers: ReadonlySet<string>): OpenClawConfig {
  const order = Object.fromEntries(
    Object.entries(readValidConfiguredAuthOrder(cfg) ?? {}).filter(
      ([provider]) => !providers.has(provider),
    ),
  );
  return {
    ...cfg,
    auth: {
      ...cfg.auth,
      order,
    },
  };
}

/** Find nonempty config orders that only reference removed profiles. */
function scanStaleConfiguredAuthOrders(params: {
  cfg: OpenClawConfig;
  stores: readonly AuthProfileStore[];
  activeStores?: readonly AuthProfileStore[];
  runtimeProfileIds?: ReadonlySet<string>;
}): StaleConfiguredAuthOrder[] {
  const order = readValidConfiguredAuthOrder(params.cfg);
  if (!order || !hasValidConfiguredAuthProfiles(params.cfg)) {
    return [];
  }

  const configuredProfileIds = new Set(Object.keys(params.cfg.auth?.profiles ?? {}));
  const storedProfileIds = new Set(params.stores.flatMap((store) => Object.keys(store.profiles)));
  const staleByCanonicalProvider = new Map<string, StaleConfiguredAuthOrder[]>();

  for (const [provider, profileIds] of Object.entries(order)) {
    // Empty order is an intentional provider disable. Any surviving profile is
    // authoritative even if its credential is currently unusable.
    if (
      profileIds.length === 0 ||
      profileIds.some(
        (profileId) =>
          configuredProfileIds.has(profileId) ||
          storedProfileIds.has(profileId) ||
          params.runtimeProfileIds?.has(profileId),
      )
    ) {
      continue;
    }
    const canonicalProvider = resolveProviderIdForAuth(provider, { config: params.cfg });
    const entries = staleByCanonicalProvider.get(canonicalProvider) ?? [];
    entries.push({ provider, staleProfileCount: profileIds.length });
    staleByCanonicalProvider.set(canonicalProvider, entries);
  }

  const hits: StaleConfiguredAuthOrder[] = [];
  for (const [canonicalProvider, staleEntries] of staleByCanonicalProvider) {
    // Remove every stale alias in the group for the proof. Otherwise deleting
    // the canonical key can merely expose another stale alias underneath it.
    const staleProviders = new Set(staleEntries.map((entry) => entry.provider));
    const cfgWithoutStaleOrder = removeAuthOrderKeys(params.cfg, staleProviders);
    const fallbackStores = params.activeStores ?? params.stores;
    const hasAutomaticFallback =
      fallbackStores.length > 0 &&
      fallbackStores.every((store) => {
        const selectionStore = structuredClone(store);
        return (
          resolveAuthProfileOrder({
            cfg: cfgWithoutStaleOrder,
            store: selectionStore,
            provider: canonicalProvider,
          }).length > 0
        );
      });
    if (hasAutomaticFallback) {
      hits.push(...staleEntries);
    }
  }
  return hits;
}

/** Remove provably stale config orders and restore per-agent automatic selection. */
function repairStaleConfiguredAuthOrders(params: {
  cfg: OpenClawConfig;
  stores: readonly AuthProfileStore[];
  activeStores?: readonly AuthProfileStore[];
  runtimeProfileIds?: ReadonlySet<string>;
}): { config: OpenClawConfig; changes: string[] } {
  const hits = scanStaleConfiguredAuthOrders(params);
  if (hits.length === 0) {
    return { config: params.cfg, changes: [] };
  }
  return {
    config: removeAuthOrderKeys(params.cfg, new Set(hits.map((hit) => hit.provider))),
    changes: hits.map(
      (hit) =>
        `auth.order.${hit.provider}: removed ${hit.staleProfileCount} missing profile reference${hit.staleProfileCount === 1 ? "" : "s"} to restore automatic per-agent auth selection.`,
    ),
  };
}

/** Load configured agent stores and repair their stale config auth orders. */
export function maybeRepairStaleConfiguredAuthOrders(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): { config: OpenClawConfig; changes: string[]; warnings?: string[] } {
  if (!hasNonemptyConfiguredAuthOrder(params.cfg)) {
    return { config: params.cfg, changes: [] };
  }
  const loaded = loadConfiguredAgentAuthStores(params.cfg, params.env ?? process.env);
  if (!loaded) {
    return { config: params.cfg, changes: [] };
  }
  if (loaded.status === "blocked") {
    return { config: params.cfg, changes: [], warnings: loaded.warnings };
  }
  return repairStaleConfiguredAuthOrders({ cfg: params.cfg, ...loaded });
}

/** Build preview warnings for stale config auth orders. */
export function collectStaleConfiguredAuthOrderWarnings(params: {
  cfg: OpenClawConfig;
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  if (!hasNonemptyConfiguredAuthOrder(params.cfg)) {
    return [];
  }
  const loaded = loadConfiguredAgentAuthStores(params.cfg, params.env ?? process.env);
  if (!loaded) {
    return [];
  }
  if (loaded.status === "blocked") {
    return loaded.warnings;
  }
  return scanStaleConfiguredAuthOrders({ cfg: params.cfg, ...loaded }).map(
    (hit) =>
      `- auth.order.${hit.provider} references only missing profiles while compatible stored credentials exist; run ${params.doctorFixCommand} to remove the stale override and restore automatic selection.`,
  );
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.staleAuthOrderTestApi")] = {
    repairStaleConfiguredAuthOrders,
  };
}
