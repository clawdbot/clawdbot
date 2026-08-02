import { resolveAuthProfileDatabasePath } from "./sqlite.js";

const MAX_PUBLICATION_OWNERS = 256;
let publicationRevision = 0;
type PublicationOwnerGeneration = {
  generation: number;
  references: number;
};
const ownerGenerations = new Map<string, PublicationOwnerGeneration>();

export type RuntimeAuthProfileStorePublicationToken = {
  consumed: boolean;
  mainKey: string;
  ownerKey: string;
  ownerGeneration: number;
  mainGeneration: number;
};

type RuntimeAuthProfileStorePublicationStatus =
  | "current"
  | "owner-superseded"
  | "main-superseded"
  | "consumed";

function getOrCreateOwnerGeneration(ownerKey: string): PublicationOwnerGeneration {
  const existing = ownerGenerations.get(ownerKey);
  if (existing) {
    return existing;
  }
  publicationRevision += 1;
  const created = { generation: publicationRevision, references: 0 };
  ownerGenerations.set(ownerKey, created);
  return created;
}

function pruneUnreferencedOwnerGenerations(): void {
  // Live callbacks retain their entries. Temporary overflow is therefore
  // bounded by the number of committed publications waiting to run.
  const currentMainKey = resolveAuthProfileDatabasePath();
  while (ownerGenerations.size > MAX_PUBLICATION_OWNERS) {
    let pruned = false;
    for (const [ownerKey, entry] of ownerGenerations) {
      // A derived transaction retains this generation before its postcommit
      // token exists, so the canonical main owner also has a scalar lease.
      if (ownerKey !== currentMainKey && entry.references === 0) {
        ownerGenerations.delete(ownerKey);
        pruned = true;
        break;
      }
    }
    if (!pruned) {
      break;
    }
  }
}

function retainOwnerGeneration(ownerKey: string): void {
  getOrCreateOwnerGeneration(ownerKey).references += 1;
}

function releaseOwnerGeneration(ownerKey: string): void {
  const entry = ownerGenerations.get(ownerKey);
  if (!entry) {
    return;
  }
  entry.references -= 1;
}

/**
 * Captures durable commit order without reopening SQLite during publication.
 * Derived publishers also fence against newer main-store commits they inherit.
 */
export function captureRuntimeAuthProfileStorePublicationToken(
  agentDir?: string,
  options?: { advanceOwner?: boolean; inheritedMainGeneration?: number },
): RuntimeAuthProfileStorePublicationToken {
  const ownerKey = resolveAuthProfileDatabasePath(agentDir);
  const mainKey = resolveAuthProfileDatabasePath();
  const ownerEntry = getOrCreateOwnerGeneration(ownerKey);
  if (options?.advanceOwner === true) {
    publicationRevision += 1;
    ownerEntry.generation = publicationRevision;
    ownerGenerations.delete(ownerKey);
    ownerGenerations.set(ownerKey, ownerEntry);
  }
  const token = {
    consumed: false,
    mainKey,
    ownerKey,
    ownerGeneration: ownerEntry.generation,
    mainGeneration:
      ownerKey === mainKey
        ? ownerEntry.generation
        : (options?.inheritedMainGeneration ?? getOrCreateOwnerGeneration(mainKey).generation),
  };
  retainOwnerGeneration(ownerKey);
  if (mainKey !== ownerKey) {
    retainOwnerGeneration(mainKey);
  }
  pruneUnreferencedOwnerGenerations();
  return token;
}

export function getRuntimeAuthProfileStorePublicationGeneration(agentDir?: string): number {
  return getOrCreateOwnerGeneration(resolveAuthProfileDatabasePath(agentDir)).generation;
}

export function consumeRuntimeAuthProfileStorePublicationToken(
  token: RuntimeAuthProfileStorePublicationToken,
): RuntimeAuthProfileStorePublicationStatus {
  if (token.consumed) {
    return "consumed";
  }
  const ownerCurrent =
    token.ownerGeneration === (ownerGenerations.get(token.ownerKey)?.generation ?? 0);
  const mainCurrent =
    token.mainGeneration === (ownerGenerations.get(token.mainKey)?.generation ?? 0);
  token.consumed = true;
  releaseOwnerGeneration(token.ownerKey);
  if (token.mainKey !== token.ownerKey) {
    releaseOwnerGeneration(token.mainKey);
  }
  pruneUnreferencedOwnerGenerations();
  if (!ownerCurrent) {
    return "owner-superseded";
  }
  return mainCurrent ? "current" : "main-superseded";
}
