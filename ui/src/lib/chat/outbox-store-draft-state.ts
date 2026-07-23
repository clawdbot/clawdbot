let lastIssuedDraftRevision = 0;
const draftRevisionHighWaterByStorage = new WeakMap<Storage, Map<string, Map<string, number>>>();
const draftAttemptHighWaterByStorage = new WeakMap<Storage, Map<string, Map<string, number>>>();

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
  let byStorageKey = draftRevisionHighWaterByStorage.get(storage);
  if (!byStorageKey) {
    byStorageKey = new Map();
    draftRevisionHighWaterByStorage.set(storage, byStorageKey);
  }
  let bySession = byStorageKey.get(storageKey);
  if (!bySession) {
    bySession = new Map();
    byStorageKey.set(storageKey, bySession);
  }
  bySession.set(storeSessionKey, Math.max(bySession.get(storeSessionKey) ?? 0, draftRevision));
}

export function rememberDraftAttempt(
  storage: Storage,
  storageKey: string,
  storeSessionKey: string,
  draftRevision: number,
) {
  let byStorageKey = draftAttemptHighWaterByStorage.get(storage);
  if (!byStorageKey) {
    byStorageKey = new Map();
    draftAttemptHighWaterByStorage.set(storage, byStorageKey);
  }
  let bySession = byStorageKey.get(storageKey);
  if (!bySession) {
    bySession = new Map();
    byStorageKey.set(storageKey, bySession);
  }
  bySession.set(storeSessionKey, Math.max(bySession.get(storeSessionKey) ?? 0, draftRevision));
}

export function rememberedDraftRevision(
  storage: Storage,
  storageKey: string,
  storeSessionKey: string,
): number {
  return draftRevisionHighWaterByStorage.get(storage)?.get(storageKey)?.get(storeSessionKey) ?? 0;
}

export function rememberedDraftAttempt(
  storage: Storage,
  storageKey: string,
  storeSessionKey: string,
): number {
  return draftAttemptHighWaterByStorage.get(storage)?.get(storageKey)?.get(storeSessionKey) ?? 0;
}
