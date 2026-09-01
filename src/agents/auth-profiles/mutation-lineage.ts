import { resolveSharedAuthStorePath, type AuthProfileOwnerScope } from "./path-resolve.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";

type PersistedMutationRecord = {
  credentialRevision: number;
  credentialRevisionKnown: boolean;
  profileSetRevision: number;
  profileSetRevisionKnown: boolean;
  stateRevision: number;
  stateRevisionKnown: boolean;
  mutationFloor: number;
  profileRevisions: Map<string, number>;
};

const persistedMutationRecords = new Map<string, PersistedMutationRecord>();
let persistedMutationRevision = 0;
let evictedOwnerMutationFloor = 0;
const MAX_PERSISTED_MUTATION_OWNERS = 256;
const MAX_PERSISTED_MUTATION_PROFILES_PER_OWNER = 256;

export type RuntimeAuthProfileStoreMutationToken = {
  revision: number;
  known: boolean;
};

export type RuntimeAuthProfileStoreMutationOwner =
  | { kind: "resolved"; databasePath: string; sharedDatabasePath: string }
  | { kind: "unresolved"; databasePath: string; scope: AuthProfileOwnerScope };

// Runtime snapshots are keyed by the canonical database path so default-agent
// and per-agent stores do not overwrite each other.
export function resolveRuntimeStoreKey(agentDir?: string): string {
  return agentDir ? resolveAuthProfileDatabasePath(agentDir) : resolveSharedAuthStorePath();
}

function maxMutationRevision(record: PersistedMutationRecord): number {
  return Math.max(
    record.credentialRevision,
    record.profileSetRevision,
    record.stateRevision,
    record.mutationFloor,
    ...record.profileRevisions.values(),
  );
}

function getOrCreatePersistedMutationRecord(ownerKey: string): PersistedMutationRecord {
  const existing = persistedMutationRecords.get(ownerKey);
  if (existing) {
    // Mutations, rather than reads, drive LRU recency so observation cannot
    // retain dormant owners forever.
    persistedMutationRecords.delete(ownerKey);
    persistedMutationRecords.set(ownerKey, existing);
    return existing;
  }
  const record: PersistedMutationRecord = {
    credentialRevision: evictedOwnerMutationFloor,
    credentialRevisionKnown: evictedOwnerMutationFloor === 0,
    profileSetRevision: evictedOwnerMutationFloor,
    profileSetRevisionKnown: evictedOwnerMutationFloor === 0,
    stateRevision: evictedOwnerMutationFloor,
    stateRevisionKnown: evictedOwnerMutationFloor === 0,
    mutationFloor: evictedOwnerMutationFloor,
    profileRevisions: new Map(),
  };
  persistedMutationRecords.set(ownerKey, record);
  while (persistedMutationRecords.size > MAX_PERSISTED_MUTATION_OWNERS) {
    const oldestOwnerKey = persistedMutationRecords.keys().next().value;
    if (oldestOwnerKey === undefined) {
      break;
    }
    const oldest = persistedMutationRecords.get(oldestOwnerKey);
    persistedMutationRecords.delete(oldestOwnerKey);
    if (oldest) {
      // A floor trades false-positive rollback fences for bounded memory; it
      // must never let an evicted persisted mutation look unchanged.
      evictedOwnerMutationFloor = Math.max(evictedOwnerMutationFloor, maxMutationRevision(oldest));
    }
  }
  record.mutationFloor = Math.max(record.mutationFloor, evictedOwnerMutationFloor);
  return record;
}

function setProfileMutationRevision(
  record: PersistedMutationRecord,
  profileId: string,
  revision: number,
): void {
  record.profileRevisions.delete(profileId);
  record.profileRevisions.set(profileId, revision);
  while (record.profileRevisions.size > MAX_PERSISTED_MUTATION_PROFILES_PER_OWNER) {
    const oldestProfileId = record.profileRevisions.keys().next().value;
    if (oldestProfileId === undefined) {
      break;
    }
    const oldestRevision = record.profileRevisions.get(oldestProfileId) ?? 0;
    record.profileRevisions.delete(oldestProfileId);
    record.mutationFloor = Math.max(record.mutationFloor, oldestRevision);
  }
}

function getPersistedMutationRecord(ownerKey: string): PersistedMutationRecord | undefined {
  return persistedMutationRecords.get(ownerKey);
}

export function recordRuntimeAuthProfileStorePersistedMutation(
  ownerKey: string,
  mutation: {
    credentialsChanged: boolean;
    profileSetChanged?: boolean;
    stateChanged: boolean;
    profileIds: Iterable<string>;
  },
): void {
  persistedMutationRevision += 1;
  const record = getOrCreatePersistedMutationRecord(ownerKey);
  if (mutation.profileSetChanged) {
    record.profileSetRevision = persistedMutationRevision;
    record.profileSetRevisionKnown = true;
  }
  if (mutation.credentialsChanged) {
    record.credentialRevision = persistedMutationRevision;
    record.credentialRevisionKnown = true;
    for (const profileId of mutation.profileIds) {
      setProfileMutationRevision(record, profileId, persistedMutationRevision);
    }
  }
  if (mutation.stateChanged) {
    record.stateRevision = persistedMutationRevision;
    record.stateRevisionKnown = true;
  }
}

function combineMutationTokens(
  tokens: RuntimeAuthProfileStoreMutationToken[],
): RuntimeAuthProfileStoreMutationToken {
  return {
    revision: Math.max(0, ...tokens.map((token) => token.revision)),
    known: tokens.every((token) => token.known),
  };
}

/** Bounded persisted credential lineage; unknown means its exact token was evicted. */
export function getRuntimeAuthProfileStoreCredentialMutationToken(
  agentDir?: string,
  profileId?: string,
  options?: { includeMain?: boolean; owner?: RuntimeAuthProfileStoreMutationOwner },
): RuntimeAuthProfileStoreMutationToken {
  const requestedKey = options?.owner?.databasePath ?? resolveRuntimeStoreKey(agentDir);
  if (!profileId) {
    const record = getPersistedMutationRecord(requestedKey);
    return record
      ? { revision: record.credentialRevision, known: record.credentialRevisionKnown }
      : { revision: evictedOwnerMutationFloor, known: evictedOwnerMutationFloor === 0 };
  }
  if (options?.includeMain && options.owner?.kind === "unresolved") {
    return { revision: 0, known: false };
  }
  const mainKey = !options?.includeMain
    ? requestedKey
    : options.owner?.kind === "resolved"
      ? options.owner.sharedDatabasePath
      : resolveRuntimeStoreKey(undefined);
  const keys =
    requestedKey === mainKey || options?.includeMain !== true
      ? [requestedKey]
      : [requestedKey, mainKey];
  return combineMutationTokens(
    keys.map((key) => {
      const record = getPersistedMutationRecord(key);
      if (!record) {
        return { revision: evictedOwnerMutationFloor, known: evictedOwnerMutationFloor === 0 };
      }
      const revision = record.profileRevisions.get(profileId);
      return revision === undefined
        ? { revision: record.mutationFloor, known: record.mutationFloor === 0 }
        : { revision, known: true };
    }),
  );
}

/** Persisted token for profile-id additions and removals in one owner store. */
export function getRuntimeAuthProfileStoreProfileSetMutationToken(
  agentDir?: string,
  databasePath?: string,
): RuntimeAuthProfileStoreMutationToken {
  const ownerKey = databasePath ?? resolveRuntimeStoreKey(agentDir);
  const record = getPersistedMutationRecord(ownerKey);
  return record
    ? { revision: record.profileSetRevision, known: record.profileSetRevisionKnown }
    : { revision: evictedOwnerMutationFloor, known: evictedOwnerMutationFloor === 0 };
}

/** Persisted mutation token for non-secret selection state in one owner store. */
export function getRuntimeAuthProfileStoreStateMutationToken(
  agentDir?: string,
  options?: { includeMain?: boolean; owner?: RuntimeAuthProfileStoreMutationOwner },
): RuntimeAuthProfileStoreMutationToken {
  const requestedKey = options?.owner?.databasePath ?? resolveRuntimeStoreKey(agentDir);
  if (options?.includeMain && options.owner?.kind === "unresolved") {
    return { revision: 0, known: false };
  }
  const mainKey = !options?.includeMain
    ? requestedKey
    : options.owner?.kind === "resolved"
      ? options.owner.sharedDatabasePath
      : resolveRuntimeStoreKey(undefined);
  const keys =
    requestedKey === mainKey || options?.includeMain !== true
      ? [requestedKey]
      : [requestedKey, mainKey];
  return combineMutationTokens(
    keys.map((key) => {
      const record = getPersistedMutationRecord(key);
      return record
        ? { revision: record.stateRevision, known: record.stateRevisionKnown }
        : { revision: evictedOwnerMutationFloor, known: evictedOwnerMutationFloor === 0 };
    }),
  );
}

const testing = {
  MAX_PERSISTED_MUTATION_OWNERS,
  MAX_PERSISTED_MUTATION_PROFILES_PER_OWNER,
  getPersistedMutationRecordCounts(): { owners: number; profiles: number } {
    return {
      owners: persistedMutationRecords.size,
      profiles: Math.max(
        0,
        ...Array.from(persistedMutationRecords.values(), (record) => record.profileRevisions.size),
      ),
    };
  },
  resetPersistedMutationLineage(): void {
    persistedMutationRecords.clear();
    persistedMutationRevision = 0;
    evictedOwnerMutationFloor = 0;
  },
};
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  // SAFETY: test-only publication; globalThis is written as an open symbol-keyed bag.
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.runtimeAuthSnapshotsTestApi")] =
    testing;
}
