let lastIssuedDraftRevision = 0;
type DraftHighWater = { committed: number; attempted: number };
const draftHighWaterByStorage = new WeakMap<Storage, Map<string, Map<string, DraftHighWater>>>();

export function observeDraftRevision(draftRevision: number | undefined): void {
  lastIssuedDraftRevision = Math.max(lastIssuedDraftRevision, draftRevision ?? 0);
}

export function nextDraftRevision(baseline = 0): number {
  const revision = Math.max(Date.now(), lastIssuedDraftRevision + 1, baseline + 1);
  lastIssuedDraftRevision = revision;
  return revision;
}

export function rememberDraftRevision(
  storage: Storage,
  storageKey: string,
  storeSessionKey: string,
  draftRevision: number | undefined,
) {
  if (draftRevision === undefined) {
    return;
  }
  const highWater = draftHighWater(storage, storageKey, storeSessionKey);
  highWater.committed = Math.max(highWater.committed, draftRevision);
}

export function rememberDraftAttempt(
  storage: Storage,
  storageKey: string,
  storeSessionKey: string,
  draftRevision: number,
) {
  const highWater = draftHighWater(storage, storageKey, storeSessionKey);
  highWater.attempted = Math.max(highWater.attempted, draftRevision);
}

function draftHighWater(storage: Storage, storageKey: string, storeSessionKey: string) {
  let byStorageKey = draftHighWaterByStorage.get(storage);
  if (!byStorageKey) {
    byStorageKey = new Map();
    draftHighWaterByStorage.set(storage, byStorageKey);
  }
  let bySession = byStorageKey.get(storageKey);
  if (!bySession) {
    bySession = new Map();
    byStorageKey.set(storageKey, bySession);
  }
  let highWater = bySession.get(storeSessionKey);
  if (!highWater) {
    highWater = { committed: 0, attempted: 0 };
    bySession.set(storeSessionKey, highWater);
  }
  return highWater;
}

export function readDraftRevisionState(
  storage: Storage,
  storageKey: string,
  storeSessionKey: string,
  storedRevision: number | undefined,
): { committed: number; latestAttempt: number } {
  const highWater = draftHighWaterByStorage.get(storage)?.get(storageKey)?.get(storeSessionKey);
  const committed = Math.max(storedRevision ?? 0, highWater?.committed ?? 0);
  return {
    committed,
    latestAttempt: Math.max(committed, highWater?.attempted ?? 0),
  };
}
