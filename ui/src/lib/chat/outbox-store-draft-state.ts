let lastIssuedDraftRevision = 0;
type DraftHighWater = {
  committed: number;
  attempted: number;
  edited: number;
  replacement?: symbol;
};
const draftHighWaterByOwner = new WeakMap<object, Map<string, Map<string, DraftHighWater>>>();

export function observeDraftRevision(draftRevision: number | undefined): void {
  lastIssuedDraftRevision = Math.max(lastIssuedDraftRevision, draftRevision ?? 0);
}

export function nextDraftRevision(baseline = 0): number {
  const revision = Math.max(Date.now(), lastIssuedDraftRevision + 1, baseline + 1);
  lastIssuedDraftRevision = revision;
  return revision;
}

export function rememberDraftRevision(
  storage: object,
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
  storage: object,
  storageKey: string,
  storeSessionKey: string,
  draftRevision: number,
) {
  const highWater = draftHighWater(storage, storageKey, storeSessionKey);
  highWater.attempted = Math.max(highWater.attempted, draftRevision);
}

export function rememberDraftEdit(
  owner: object,
  storageKey: string,
  storeSessionKey: string,
  draftRevision: number,
) {
  // Pending edits retire async replacements without changing when earlier
  // ordinary debounce writes may commit before the newer write starts.
  const highWater = draftHighWater(owner, storageKey, storeSessionKey);
  highWater.edited = Math.max(highWater.edited, draftRevision);
}

export function captureDraftReplacement(
  owner: object,
  storageKey: string,
  storeSessionKey: string,
  observedRevision: number,
): () => boolean {
  const highWater = draftHighWater(owner, storageKey, storeSessionKey);
  const replacement = Symbol("composer-replacement");
  const revision = Math.max(
    observedRevision,
    highWater.committed,
    highWater.attempted,
    highWater.edited,
  );
  highWater.replacement = replacement;
  return () =>
    highWater.replacement === replacement &&
    Math.max(highWater.committed, highWater.attempted, highWater.edited) <= revision;
}

function draftHighWater(storage: object, storageKey: string, storeSessionKey: string) {
  let byStorageKey = draftHighWaterByOwner.get(storage);
  if (!byStorageKey) {
    byStorageKey = new Map();
    draftHighWaterByOwner.set(storage, byStorageKey);
  }
  let bySession = byStorageKey.get(storageKey);
  if (!bySession) {
    bySession = new Map();
    byStorageKey.set(storageKey, bySession);
  }
  let highWater = bySession.get(storeSessionKey);
  if (!highWater) {
    highWater = { committed: 0, attempted: 0, edited: 0 };
    bySession.set(storeSessionKey, highWater);
  }
  return highWater;
}

export function readDraftRevisionState(
  storage: object,
  storageKey: string,
  storeSessionKey: string,
  storedRevision: number | undefined,
): { committed: number; latestAttempt: number } {
  const highWater = draftHighWaterByOwner.get(storage)?.get(storageKey)?.get(storeSessionKey);
  const committed = Math.max(storedRevision ?? 0, highWater?.committed ?? 0);
  return {
    committed,
    latestAttempt: Math.max(committed, highWater?.attempted ?? 0),
  };
}
