// Repairs configured auth orders whose referenced profiles no longer exist.
import fs from "node:fs";
import path from "node:path";
import { listAgentIds, resolveAgentDir } from "../../../agents/agent-scope-config.js";
import { listRuntimeExternalAuthProfiles } from "../../../agents/auth-profiles/external-auth-runtime.js";
import {
  resolveAuthProfileEligibility,
  resolveAuthProfileOrder,
} from "../../../agents/auth-profiles/order.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "../../../agents/auth-profiles/path-resolve.js";
import { mergeAuthProfileStores } from "../../../agents/auth-profiles/persisted.js";
import { resolveSharedMainAuthAgentDir } from "../../../agents/auth-profiles/shared-main-dir.js";
import {
  resolveAuthProfileDatabaseOwnerId,
  resolveAuthProfileDatabasePath,
} from "../../../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import { resolveProviderIdForAuth } from "../../../agents/provider-auth-aliases.js";
import { resolveStateDir } from "../../../config/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import {
  inspectOpenClawAgentDatabaseOwner,
  listOpenClawRegisteredAgentDatabases,
} from "../../../state/openclaw-agent-db.js";
import { isRecord, resolveUserPath } from "../../../utils.js";
import {
  inspectAuthDatabaseFiles,
  inspectUnmigratedAuthStoreSources,
  loadCompletePersistedStore,
} from "./stale-auth-order-store.js";

type StaleConfiguredAuthOrder = {
  provider: string;
  staleProfileCount: number;
};

type UndeclaredConfiguredAuthOrder = {
  provider: string;
  undeclaredProfileIds: string[];
  declaredProviderProfileIds: string[];
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
  // Every agent inherits the shared store at runtime, even when `agents.list`
  // names a different default agent.
  const mainAgentDir = resolveSharedMainAuthAgentDir(env);
  const sharedDatabasePath = path.resolve(resolveSharedAuthStorePath(env));
  const sharedOwnership = resolveSharedAuthStoreOwnership(env);
  const activeAgentDirs = new Set<string>();
  const expectedAgentIdsByDir = new Map<string, Set<string>>();
  const addExpectedAgentDir = (agentDir: string, agentId: string) => {
    const owners = expectedAgentIdsByDir.get(agentDir) ?? new Set<string>();
    owners.add(normalizeAgentId(agentId));
    expectedAgentIdsByDir.set(agentDir, owners);
  };
  if (sharedOwnership.location === "legacy-main") {
    addExpectedAgentDir(mainAgentDir, resolveAuthProfileDatabaseOwnerId(mainAgentDir));
  }
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
    agentDir?: string;
    databasePath: string;
    store: AuthProfileStore | null;
    isShared: boolean;
  }> = [];
  const sharedLegacyAvailability = inspectUnmigratedAuthStoreSources(mainAgentDir);
  if (sharedLegacyAvailability === "unreadable") {
    return { status: "blocked", warnings: [INVALID_SQLITE_STORE_WARNING] };
  }
  if (sharedLegacyAvailability === "present") {
    return undefined;
  }
  const sharedLoaded = loadCompletePersistedStore(undefined, env);
  if (sharedLoaded.status === "invalid") {
    return { status: "blocked", warnings: [INVALID_SQLITE_STORE_WARNING] };
  }
  if (sharedOwnership.location === "legacy-main") {
    const availability = inspectAuthDatabaseFiles(mainAgentDir);
    const expectedAgentIds = expectedAgentIdsByDir.get(mainAgentDir);
    const owner =
      availability === "present"
        ? inspectOpenClawAgentDatabaseOwner(sharedDatabasePath)
        : undefined;
    if (
      availability === "unreadable" ||
      owner?.status === "unreadable" ||
      (expectedAgentIds && owner?.status === "owned" && !expectedAgentIds.has(owner.agentId)) ||
      (owner?.status === "unowned" && sharedLoaded.hasAuthTables)
    ) {
      return { status: "blocked", warnings: [INVALID_SQLITE_STORE_WARNING] };
    }
  }
  entries.push({
    databasePath: sharedDatabasePath,
    store: sharedLoaded.store,
    isShared: true,
  });
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
    if (databasePath === sharedDatabasePath) {
      continue;
    }
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
    entries.push({ agentDir, databasePath, store: loaded.store, isShared: false });
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
  const mainStore = entries.find((entry) => entry.isShared)?.store ?? emptyStore;
  const agentStores = entries.map((entry) => {
    const localStore = entry.store ?? emptyStore;
    return entry.isShared
      ? mainStore
      : mergeAuthProfileStores(mainStore, localStore, {
          preserveBaseRuntimeExternalProfiles: true,
        });
  });
  const activeStores = entries.flatMap((entry, index) =>
    (entry.isShared && activeAgentDirs.has(mainAgentDir)) ||
    (entry.agentDir !== undefined && activeAgentDirs.has(entry.agentDir))
      ? [agentStores[index] ?? emptyStore]
      : [],
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

function scanUndeclaredConfiguredAuthOrders(
  cfg: OpenClawConfig,
  loaded?: Extract<LoadedAuthStores, { status: "ready" }>,
): UndeclaredConfiguredAuthOrder[] {
  const order = readValidConfiguredAuthOrder(cfg);
  if (!order || !hasValidConfiguredAuthProfiles(cfg) || !cfg.auth?.profiles) {
    return [];
  }
  const configuredProfileIds = new Set(Object.keys(cfg.auth.profiles));
  return Object.entries(order).flatMap(([provider, profileIds]) => {
    const undeclaredProfileIds = profileIds.filter((profileId) => {
      if (configuredProfileIds.has(profileId) || loaded?.runtimeProfileIds.has(profileId)) {
        return false;
      }
      return !loaded?.stores.some(
        (store) => resolveAuthProfileEligibility({ cfg, store, provider, profileId }).eligible,
      );
    });
    if (undeclaredProfileIds.length === 0) {
      return [];
    }
    const canonicalProvider = resolveProviderIdForAuth(provider, { config: cfg });
    const declaredProviderProfileIds = Object.entries(cfg.auth?.profiles ?? {})
      .filter(
        ([, profile]) =>
          resolveProviderIdForAuth(profile.provider, { config: cfg, storedCredential: true }) ===
          canonicalProvider,
      )
      .map(([profileId]) => profileId);
    return [{ provider, undeclaredProfileIds, declaredProviderProfileIds }];
  });
}

function repairUndeclaredConfiguredAuthOrders(
  cfg: OpenClawConfig,
  loaded?: Extract<LoadedAuthStores, { status: "ready" }>,
): {
  config: OpenClawConfig;
  changes: string[];
  warnings: string[];
} {
  const hits = scanUndeclaredConfiguredAuthOrders(cfg, loaded);
  const order = readValidConfiguredAuthOrder(cfg) ?? {};
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const hit of hits) {
    if (hit.declaredProviderProfileIds.length !== 1) {
      const candidates = hit.declaredProviderProfileIds.join(", ") || "none";
      warnings.push(
        `- auth.order.${hit.provider} references undeclared ${hit.undeclaredProfileIds.join(", ")}; declared profiles for this provider are ambiguous (${candidates}). Set auth.order.${hit.provider} explicitly.`,
      );
      continue;
    }
    const replacement = hit.declaredProviderProfileIds[0];
    if (!replacement) {
      continue;
    }
    const undeclared = new Set(hit.undeclaredProfileIds);
    order[hit.provider] = [
      ...new Set(
        (order[hit.provider] ?? []).map((profileId) =>
          undeclared.has(profileId) ? replacement : profileId,
        ),
      ),
    ];
    changes.push(
      `auth.order.${hit.provider}: replaced undeclared ${hit.undeclaredProfileIds.join(", ")} with ${replacement}.`,
    );
  }
  return {
    config:
      changes.length === 0
        ? cfg
        : {
            ...cfg,
            auth: {
              ...cfg.auth,
              order,
            },
          },
    changes,
    warnings,
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
  const initialLoaded = loadConfiguredAgentAuthStores(params.cfg, params.env ?? process.env);
  if (!initialLoaded) {
    return { config: params.cfg, changes: [] };
  }
  if (initialLoaded.status === "blocked") {
    return { config: params.cfg, changes: [], warnings: initialLoaded.warnings };
  }
  const declaredRepair = repairUndeclaredConfiguredAuthOrders(params.cfg, initialLoaded);
  const cfg = declaredRepair.config;
  const staleRepair = repairStaleConfiguredAuthOrders({ cfg, ...initialLoaded });
  const remainingDeclaredWarnings = repairUndeclaredConfiguredAuthOrders(
    staleRepair.config,
    initialLoaded,
  ).warnings;
  return {
    config: staleRepair.config,
    changes: [...declaredRepair.changes, ...staleRepair.changes],
    ...(remainingDeclaredWarnings.length > 0 ? { warnings: remainingDeclaredWarnings } : {}),
  };
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
  const declaredWarnings = scanUndeclaredConfiguredAuthOrders(params.cfg, loaded).map((hit) => {
    if (hit.declaredProviderProfileIds.length === 1) {
      return `- auth.order.${hit.provider} references undeclared ${hit.undeclaredProfileIds.join(", ")}; run ${params.doctorFixCommand} to replace it with ${hit.declaredProviderProfileIds[0]}.`;
    }
    const candidates = hit.declaredProviderProfileIds.join(", ") || "none";
    return `- auth.order.${hit.provider} references undeclared ${hit.undeclaredProfileIds.join(", ")}; declared profiles for this provider are ambiguous (${candidates}). Set auth.order.${hit.provider} explicitly.`;
  });
  return [
    ...declaredWarnings,
    ...scanStaleConfiguredAuthOrders({ cfg: params.cfg, ...loaded }).map(
      (hit) =>
        `- auth.order.${hit.provider} references only missing profiles while compatible stored credentials exist; run ${params.doctorFixCommand} to remove the stale override and restore automatic selection.`,
    ),
  ];
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.staleAuthOrderTestApi")] = {
    repairStaleConfiguredAuthOrders,
  };
}
