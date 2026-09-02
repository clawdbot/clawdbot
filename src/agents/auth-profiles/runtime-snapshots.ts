import path from "node:path";
/**
 * Process-local auth profile snapshots used by prepared runtimes and tests.
 * Snapshots are cloned at boundaries so callers cannot mutate shared state.
 */
import { isDeepStrictEqual } from "node:util";
import { cloneAuthProfileStore } from "./clone.js";
import {
  recordRuntimeAuthProfileStorePersistedMutation,
  resolveRuntimeStoreKey,
} from "./mutation-lineage.js";
import { captureAuthProfileOwnerScope } from "./path-resolve.js";
import { mergeAuthProfileStores } from "./persisted.js";
import {
  clearAllRuntimeAuthMaterializations,
  clearRuntimeAuthMaterializationsAtDatabasePath,
} from "./runtime-materializations.js";
import {
  captureRuntimeAuthProfileLegacyCandidates,
  cloneRuntimeAuthProfileLegacyCandidates,
  captureRuntimeAuthSharedOwner,
  cloneRuntimeAuthSharedOwner,
  runtimeAuthProfileSnapshotSharesOwner,
  runtimeAuthSharedOwnerRebound,
  runtimeAuthCredentialState as credentialState,
  runtimeAuthOwnerState as ownerState,
  type RuntimeAuthSharedOwner,
  type RuntimeAuthProfileLegacyCandidates,
  type OwnedRuntimeAuthProfileStoreSnapshotEntry,
} from "./runtime-snapshot-owner.js";
import {
  closeAuthProfileReadPool,
  type AuthProfileStoreOwner,
  type PreparedAuthProfileStoreOwner,
} from "./sqlite.js";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "./types.js";

type OwnedRuntimeSnapshot = {
  store: RuntimeAuthProfileStore;
  owner: RuntimeAuthSharedOwner;
  legacyCandidates?: RuntimeAuthProfileLegacyCandidates;
};
const runtimeAuthStoreSnapshots = new Map<string, OwnedRuntimeSnapshot>();

function runtimeStoreEntries(): Array<[string, RuntimeAuthProfileStore]> {
  return Array.from(runtimeAuthStoreSnapshots, ([key, entry]) => [key, entry.store]);
}
type RuntimeAuthProfileStoreMutationListener = (event: {
  agentDir?: string;
  affectsInheritedStores: boolean;
  profileSetChanged: boolean;
}) => void;
const runtimeAuthStoreMutationListeners = new Set<RuntimeAuthProfileStoreMutationListener>();
let runtimeAuthStoreCredentialsRevision = 0;
let runtimeAuthStoreSnapshotsRevision = 0;
// Per-store generations isolate rollback ownership; the global counter remains
// the deletion generation for keys no longer present in this map.
const runtimeAuthStoreSnapshotRevisions = new Map<string, number>();

type RuntimeAuthProfileStoreSnapshotEntry = {
  databasePath?: string;
  agentDir?: string;
  store: RuntimeAuthProfileStore;
};

export {
  prepareRuntimeAuthProfileStoreSnapshots,
  type OwnedRuntimeAuthProfileStoreSnapshotEntry,
} from "./runtime-snapshot-owner.js";

function advanceRuntimeAuthStoreSnapshotsRevision(): void {
  // Readers must close before consumers can observe the new snapshot generation.
  closeAuthProfileReadPool();
  runtimeAuthStoreSnapshotsRevision += 1;
}

function snapshotOwnershipState(entries: Iterable<[string, OwnedRuntimeSnapshot]>) {
  return Array.from(
    entries,
    ([key, entry]) =>
      [
        key,
        {
          state: ownerState(entry.store),
          owner: entry.owner,
          legacyCandidates: entry.legacyCandidates,
        },
      ] as const,
  ).toSorted(([left], [right]) => left.localeCompare(right));
}

function replaceChangesOwner(entries: OwnedRuntimeAuthProfileStoreSnapshotEntry[]): boolean {
  const next = new Map(entries.map((entry) => [entry.databasePath, entry] as const));
  return !isDeepStrictEqual(
    snapshotOwnershipState(runtimeAuthStoreSnapshots),
    snapshotOwnershipState(next),
  );
}

function replaceChangesCredentials(entries: RuntimeAuthProfileStoreSnapshotEntry[]): boolean {
  const next = new Map(
    entries.map((entry) => [resolveRuntimeSnapshotEntryKey(entry), entry.store] as const),
  );
  return !isDeepStrictEqual(credentialState(runtimeStoreEntries()), credentialState(next));
}

function recordChangedSnapshotRevisions(
  entries: OwnedRuntimeAuthProfileStoreSnapshotEntry[],
): boolean {
  const next = new Map(
    entries.map(
      (entry) =>
        [
          entry.databasePath,
          { store: entry.store, owner: entry.owner, legacyCandidates: entry.legacyCandidates },
        ] as const,
    ),
  );
  const keys = new Set([...runtimeAuthStoreSnapshots.keys(), ...next.keys()]);
  let changed = false;
  for (const key of keys) {
    if (isDeepStrictEqual(runtimeAuthStoreSnapshots.get(key), next.get(key))) {
      continue;
    }
    changed = true;
    advanceRuntimeAuthStoreSnapshotsRevision();
    if (next.has(key)) {
      runtimeAuthStoreSnapshotRevisions.set(key, runtimeAuthStoreSnapshotsRevision);
    } else {
      runtimeAuthStoreSnapshotRevisions.delete(key);
    }
  }
  return changed;
}

function resolveRuntimeSnapshotEntryKey(entry: {
  databasePath?: string;
  agentDir?: string;
}): string {
  // Enumeration already owns the canonical key; never reconstruct it from a projected directory.
  return entry.databasePath ?? resolveRuntimeStoreKey(entry.agentDir);
}

function notifyRuntimeAuthStoreMutation(agentDir?: string, profileSetChanged = false): void {
  const event = {
    ...(agentDir ? { agentDir } : {}),
    affectsInheritedStores: agentDir === undefined,
    profileSetChanged,
  };
  for (const listener of runtimeAuthStoreMutationListeners) {
    listener(event);
  }
}

function authProfilesChanged(
  previous: RuntimeAuthProfileStore | undefined,
  next: RuntimeAuthProfileStore | undefined,
): boolean {
  return !isDeepStrictEqual(previous?.profiles ?? {}, next?.profiles ?? {});
}

function authProfileSetChanged(
  previous: RuntimeAuthProfileStore | undefined,
  next: RuntimeAuthProfileStore | undefined,
): boolean {
  return !isDeepStrictEqual(
    Object.keys(previous?.profiles ?? {}).toSorted(),
    Object.keys(next?.profiles ?? {}).toSorted(),
  );
}

/** Observes credential snapshot changes at their lifecycle publication edge. */
export function registerRuntimeAuthProfileStoreMutationListener(
  listener: RuntimeAuthProfileStoreMutationListener,
): () => void {
  runtimeAuthStoreMutationListeners.add(listener);
  return () => runtimeAuthStoreMutationListeners.delete(listener);
}

/** Reads a cloned runtime auth profile store snapshot for an agent dir. */
export function getRuntimeAuthProfileStoreSnapshotCore(
  agentDir?: string,
): RuntimeAuthProfileStore | undefined {
  return getRuntimeAuthProfileStoreSnapshotAtDatabasePath(resolveRuntimeStoreKey(agentDir));
}

export function getRuntimeAuthProfileStoreSnapshotAtDatabasePath(
  databasePath: string,
): RuntimeAuthProfileStore | undefined {
  const store = runtimeAuthStoreSnapshots.get(databasePath)?.store;
  return store ? cloneAuthProfileStore(store) : undefined;
}

export function getOwnedRuntimeAuthProfileStoreSnapshotAtDatabasePath(
  databasePath: string,
): OwnedRuntimeAuthProfileStoreSnapshotEntry | undefined {
  const entry = runtimeAuthStoreSnapshots.get(databasePath);
  return (
    entry && {
      databasePath,
      agentDir: path.dirname(databasePath),
      store: cloneAuthProfileStore(entry.store),
      owner: cloneRuntimeAuthSharedOwner(entry.owner),
      legacyCandidates: cloneRuntimeAuthProfileLegacyCandidates(entry.legacyCandidates),
    }
  );
}

/**
 * Reads the effective prepared auth store without falling back to persisted storage.
 * Lifecycle consumers use this after auth publication so request paths never reopen SQLite.
 */
export function getPreparedRuntimeAuthProfileStoreSnapshotCore(
  agentDir?: string,
  inheritedAuthDir?: string,
): AuthProfileStore | undefined {
  const inheritedKey = resolveRuntimeStoreKey(inheritedAuthDir);
  const requestedKey = resolveRuntimeStoreKey(agentDir);
  const inherited = getRuntimeAuthProfileStoreSnapshotAtDatabasePath(inheritedKey);
  if (requestedKey === inheritedKey) {
    return inherited;
  }
  const requested = getRuntimeAuthProfileStoreSnapshotAtDatabasePath(requestedKey);
  // With no agent, the shared snapshot wins without merging the inherited store.
  if (agentDir && inherited && requested) {
    return mergeAuthProfileStores(inherited, requested, {
      preserveBaseRuntimeExternalProfiles: true,
    });
  }
  return requested ?? inherited;
}

/** Lists cloned snapshots with their canonical database identity and producer ownership. */
export function listOwnedRuntimeAuthProfileStoreSnapshots(): OwnedRuntimeAuthProfileStoreSnapshotEntry[] {
  return Array.from(runtimeAuthStoreSnapshots, ([databasePath, entry]) => ({
    databasePath,
    agentDir: path.dirname(databasePath),
    store: cloneAuthProfileStore(entry.store),
    owner: cloneRuntimeAuthSharedOwner(entry.owner),
    legacyCandidates: cloneRuntimeAuthProfileLegacyCandidates(entry.legacyCandidates),
  }));
}

/** Select derived snapshots by their producer's shared owner, never directory shape. */
export function listRuntimeAuthProfileStoreSnapshotsForSharedOwner(owner: AuthProfileStoreOwner) {
  return listOwnedRuntimeAuthProfileStoreSnapshots().filter(
    (entry) =>
      entry.databasePath !== owner.sharedDatabasePath &&
      runtimeAuthProfileSnapshotSharesOwner(entry.owner, owner),
  );
}

/** Returns true when a runtime snapshot exists for an agent dir. */
export function hasRuntimeAuthProfileStoreSnapshot(agentDir?: string): boolean {
  return runtimeAuthStoreSnapshots.has(resolveRuntimeStoreKey(agentDir));
}

/** Checks the owned profile keys without copying private credential data out of the owner. */
export function hasRuntimeAuthProfileStoreSource(agentDir?: string): boolean {
  const store = runtimeAuthStoreSnapshots.get(resolveRuntimeStoreKey(agentDir))?.store;
  return Boolean(store && Object.keys(store.profiles).length > 0);
}

/** Returns true when requested or main runtime snapshots contain profiles. */
export function hasAnyRuntimeAuthProfileStoreSource(agentDir?: string): boolean {
  return (
    hasRuntimeAuthProfileStoreSource(agentDir) ||
    (Boolean(agentDir) && hasRuntimeAuthProfileStoreSource())
  );
}

/** Replaces all runtime auth profile snapshots with cloned entries. */
export function replaceRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ databasePath?: string; agentDir?: string; store: AuthProfileStore }>,
): void {
  const prepared = entries.map((entry): OwnedRuntimeAuthProfileStoreSnapshotEntry => {
    const databasePath = resolveRuntimeSnapshotEntryKey(entry);
    return {
      databasePath,
      agentDir: path.dirname(databasePath),
      store: cloneAuthProfileStore(entry.store),
      owner: cloneRuntimeAuthSharedOwner(
        runtimeAuthStoreSnapshots.get(databasePath)?.owner ?? {
          kind: "unresolved",
          scope: captureAuthProfileOwnerScope(),
        },
      ),
      legacyCandidates: cloneRuntimeAuthProfileLegacyCandidates(
        runtimeAuthStoreSnapshots.get(databasePath)?.legacyCandidates ??
          captureRuntimeAuthProfileLegacyCandidates(
            entry.agentDir ?? (entry.databasePath ? path.dirname(databasePath) : undefined),
          ),
      ),
    };
  });
  replaceOwnedRuntimeAuthProfileStoreSnapshots(prepared);
}

export function replaceOwnedRuntimeAuthProfileStoreSnapshots(
  entries: OwnedRuntimeAuthProfileStoreSnapshotEntry[],
): void {
  // Cold producer facts are enough to fence stale preparation; do not open SQLite
  // merely to avoid conservative invalidation for an irrelevant relocation.
  const reboundKeys = new Set(
    entries
      .filter((entry) => {
        const previous = runtimeAuthStoreSnapshots.get(entry.databasePath);
        return previous && runtimeAuthSharedOwnerRebound(previous.owner, entry.owner);
      })
      .map((entry) => entry.databasePath),
  );
  const credentialsChanged = replaceChangesCredentials(entries) || reboundKeys.size > 0;
  const ownerChanged = replaceChangesOwner(entries);
  if (credentialsChanged) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  const next = new Map(
    entries.map((entry) => [resolveRuntimeSnapshotEntryKey(entry), entry.store] as const),
  );
  const profileSetChanged = [
    ...new Set([...runtimeAuthStoreSnapshots.keys(), ...next.keys()]),
  ].some((key) => authProfileSetChanged(runtimeAuthStoreSnapshots.get(key)?.store, next.get(key)));
  for (const key of new Set([...runtimeAuthStoreSnapshots.keys(), ...next.keys()])) {
    if (
      reboundKeys.has(key) ||
      authProfilesChanged(runtimeAuthStoreSnapshots.get(key)?.store, next.get(key))
    ) {
      clearRuntimeAuthMaterializationsAtDatabasePath(key);
    }
  }
  recordChangedSnapshotRevisions(entries);
  const nextOwned = entries.map((entry) => {
    const key = resolveRuntimeSnapshotEntryKey(entry);
    return [
      key,
      {
        store: cloneAuthProfileStore(entry.store),
        owner: cloneRuntimeAuthSharedOwner(entry.owner),
        legacyCandidates: cloneRuntimeAuthProfileLegacyCandidates(entry.legacyCandidates),
      },
    ] as const;
  });
  runtimeAuthStoreSnapshots.clear();
  for (const [key, entry] of nextOwned) {
    runtimeAuthStoreSnapshots.set(key, entry);
  }
  if (ownerChanged) {
    notifyRuntimeAuthStoreMutation(undefined, profileSetChanged);
  }
}

/** Clears all runtime auth profile snapshots. */
export function clearRuntimeAuthProfileStoreSnapshots(): void {
  const snapshotsChanged = runtimeAuthStoreSnapshots.size > 0;
  const credentialsChanged = credentialState(runtimeStoreEntries()).length > 0;
  const profileSetChanged = runtimeStoreEntries().some(
    ([, store]) => Object.keys(store.profiles).length > 0,
  );
  if (credentialsChanged) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  if (snapshotsChanged) {
    advanceRuntimeAuthStoreSnapshotsRevision();
  } else {
    closeAuthProfileReadPool();
  }
  runtimeAuthStoreSnapshots.clear();
  clearAllRuntimeAuthMaterializations();
  runtimeAuthStoreSnapshotRevisions.clear();
  if (snapshotsChanged) {
    notifyRuntimeAuthStoreMutation(undefined, profileSetChanged);
  }
}

/** Clears one runtime auth-profile snapshot without disturbing other active agents. */
export function clearRuntimeAuthProfileStoreSnapshotCore(agentDir?: string): boolean {
  return clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(
    resolveRuntimeStoreKey(agentDir),
    agentDir,
  );
}

export function clearRuntimeAuthProfileStoreSnapshotAtDatabasePath(
  key: string,
  agentDir?: string,
): boolean {
  const store = runtimeAuthStoreSnapshots.get(key)?.store;
  if (!store) {
    return false;
  }
  if (Object.keys(store.profiles).length > 0) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  advanceRuntimeAuthStoreSnapshotsRevision();
  runtimeAuthStoreSnapshots.delete(key);
  clearRuntimeAuthMaterializationsAtDatabasePath(key);
  runtimeAuthStoreSnapshotRevisions.delete(key);
  notifyRuntimeAuthStoreMutation(agentDir, Object.keys(store.profiles).length > 0);
  return true;
}

function setRuntimeAuthProfileStoreSnapshotAtKey(
  store: RuntimeAuthProfileStore,
  key: string,
  agentDir: string | undefined,
  owner: RuntimeAuthSharedOwner,
  legacyCandidates?: RuntimeAuthProfileLegacyCandidates,
): void {
  const previous = runtimeAuthStoreSnapshots.get(key);
  const sharedOwnerChanged =
    !isDeepStrictEqual(previous?.owner, owner) ||
    !isDeepStrictEqual(previous?.legacyCandidates, legacyCandidates);
  const credentialsChanged = !isDeepStrictEqual(
    credentialState(
      runtimeAuthStoreSnapshots.has(key) ? [[key, runtimeAuthStoreSnapshots.get(key)!.store]] : [],
    ),
    credentialState([[key, store]]),
  );
  const sharedOwnerRebound = previous && runtimeAuthSharedOwnerRebound(previous.owner, owner);
  if (credentialsChanged || sharedOwnerRebound) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  const previousStore = previous?.store;
  const profileSetChanged = authProfileSetChanged(previousStore, store);
  if (sharedOwnerRebound || authProfilesChanged(previousStore, store)) {
    clearRuntimeAuthMaterializationsAtDatabasePath(key);
  }
  const ownerChanged =
    sharedOwnerChanged || !isDeepStrictEqual(ownerState(previousStore), ownerState(store));
  const snapshotChanged = sharedOwnerChanged || !isDeepStrictEqual(previousStore, store);
  if (snapshotChanged) {
    advanceRuntimeAuthStoreSnapshotsRevision();
    runtimeAuthStoreSnapshotRevisions.set(key, runtimeAuthStoreSnapshotsRevision);
  }
  runtimeAuthStoreSnapshots.set(key, {
    store: cloneAuthProfileStore(store),
    owner: cloneRuntimeAuthSharedOwner(owner),
    legacyCandidates: cloneRuntimeAuthProfileLegacyCandidates(legacyCandidates),
  });
  if (ownerChanged) {
    notifyRuntimeAuthStoreMutation(agentDir, profileSetChanged);
  }
}

/** Stores a cloned runtime auth profile snapshot for an agent dir. */
export function setRuntimeAuthProfileStoreSnapshot(
  store: RuntimeAuthProfileStore,
  agentDir?: string,
): void {
  setRuntimeAuthProfileStoreSnapshotAtKey(
    store,
    resolveRuntimeStoreKey(agentDir),
    agentDir,
    captureRuntimeAuthSharedOwner(),
    captureRuntimeAuthProfileLegacyCandidates(agentDir),
  );
}

/** Restore the captured runtime owner independently of the persistence transaction. */
export function restoreOwnedRuntimeAuthProfileStoreSnapshot(
  entry: OwnedRuntimeAuthProfileStoreSnapshotEntry,
  agentDir?: string,
): void {
  setRuntimeAuthProfileStoreSnapshotAtKey(
    entry.store,
    entry.databasePath,
    agentDir,
    entry.owner,
    entry.legacyCandidates,
  );
}

/** Materialization changes contents, not the existing producer's shared ownership. */
export function updateRuntimeAuthProfileStoreSnapshot(
  store: RuntimeAuthProfileStore,
  agentDir?: string,
): void {
  const key = resolveRuntimeStoreKey(agentDir);
  const owner = runtimeAuthStoreSnapshots.get(key)?.owner ?? captureRuntimeAuthSharedOwner();
  setRuntimeAuthProfileStoreSnapshotAtKey(
    store,
    key,
    agentDir,
    owner,
    runtimeAuthStoreSnapshots.get(key)?.legacyCandidates ??
      captureRuntimeAuthProfileLegacyCandidates(agentDir),
  );
}

/** Stores a cloned snapshot under an already resolved canonical database owner. */
export function setRuntimeAuthProfileStoreSnapshotAtDatabasePath(
  store: RuntimeAuthProfileStore,
  databasePath: string,
  agentDir: string | undefined,
  owner: AuthProfileStoreOwner | PreparedAuthProfileStoreOwner,
  legacyCandidates?: RuntimeAuthProfileLegacyCandidates,
): void {
  const existing = runtimeAuthStoreSnapshots.get(databasePath);
  const candidates =
    "env" in owner
      ? captureRuntimeAuthProfileLegacyCandidates(
          databasePath === owner.sharedDatabasePath ? undefined : agentDir,
          owner.env,
        )
      : (legacyCandidates ??
        (existing && runtimeAuthProfileSnapshotSharesOwner(existing.owner, owner)
          ? existing.legacyCandidates
          : undefined));
  setRuntimeAuthProfileStoreSnapshotAtKey(
    store,
    databasePath,
    agentDir,
    {
      kind: "resolved",
      sharedDatabasePath: owner.sharedDatabasePath,
      location: owner.location,
    },
    candidates,
  );
}

/**
 * Invalidates prepared credential ownership after a persisted owner-store write.
 * Main-store credentials are inherited by custom-agent snapshots, so those
 * derived snapshots must be dropped even when no exact main snapshot exists.
 * State-only saves refresh them in the publisher without changing credential ownership.
 */
export function noteRuntimeAuthProfileStorePersistedMutation(
  agentDir: string | undefined,
  mutation: {
    credentialsChanged: boolean;
    profileSetChanged?: boolean;
    stateChanged: boolean;
    profileIds: Iterable<string>;
  },
  owner?: AuthProfileStoreOwner,
): void {
  if (!mutation.credentialsChanged && !mutation.profileSetChanged && !mutation.stateChanged) {
    return;
  }
  if (mutation.credentialsChanged) {
    runtimeAuthStoreCredentialsRevision += 1;
  }
  const ownerKey = owner?.databasePath ?? resolveRuntimeStoreKey(agentDir);
  if (mutation.credentialsChanged || mutation.profileSetChanged) {
    clearRuntimeAuthMaterializationsAtDatabasePath(ownerKey);
  }
  recordRuntimeAuthProfileStorePersistedMutation(ownerKey, mutation);
  const mainKey = owner?.sharedDatabasePath ?? resolveRuntimeStoreKey(undefined);
  if (ownerKey !== mainKey || (!mutation.credentialsChanged && !mutation.profileSetChanged)) {
    return;
  }
  let deletedDerivedSnapshot = false;
  const sharedOwner = owner ?? captureRuntimeAuthSharedOwner();
  for (const [key, entry] of runtimeAuthStoreSnapshots) {
    if (key !== mainKey && runtimeAuthProfileSnapshotSharesOwner(entry.owner, sharedOwner)) {
      runtimeAuthStoreSnapshots.delete(key);
      runtimeAuthStoreSnapshotRevisions.delete(key);
      deletedDerivedSnapshot = true;
    }
  }
  if (deletedDerivedSnapshot) {
    advanceRuntimeAuthStoreSnapshotsRevision();
  }
  if (mutation.credentialsChanged || mutation.profileSetChanged) {
    notifyRuntimeAuthStoreMutation(agentDir, mutation.profileSetChanged === true);
  }
}

/** Stable token for credential ownership without coupling to usage bookkeeping. */
export function getRuntimeAuthProfileStoreCredentialsRevision(): number {
  return runtimeAuthStoreCredentialsRevision;
}

/** Process-local generation for one exact runtime snapshot rollback owner. */
export function getRuntimeAuthProfileStoreSnapshotRevision(agentDir?: string): number {
  return getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(resolveRuntimeStoreKey(agentDir));
}

/** Process-local generation for an already resolved canonical snapshot owner. */
export function getRuntimeAuthProfileStoreSnapshotRevisionAtDatabasePath(
  databasePath: string,
): number {
  return runtimeAuthStoreSnapshotRevisions.get(databasePath) ?? runtimeAuthStoreSnapshotsRevision;
}
