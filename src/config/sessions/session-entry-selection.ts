import type { SessionEntry } from "./types.js";

type SessionStoreTarget = {
  canonicalKey: string;
  storeKeys: readonly string[];
};

type SessionProjectionTarget = {
  candidateKeys?: readonly string[];
  primaryKey: string;
};

/** Normalizes caller aliases while always preserving the canonical key. */
export function normalizeTargetStoreKeys(target: SessionStoreTarget): string[] {
  const keys = new Set<string>();
  const remember = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) {
      keys.add(trimmed);
    }
  };
  remember(target.canonicalKey);
  for (const key of target.storeKeys) {
    remember(key);
  }
  return [...keys];
}

/** Selects the row that alias migration would promote. */
export function resolveFreshestTargetEntry(
  store: Record<string, SessionEntry>,
  targetKeys: readonly string[],
): { key: string; entry: SessionEntry } | undefined {
  let freshest: { key: string; entry: SessionEntry } | undefined;
  for (const key of targetKeys) {
    const entry = store[key];
    if (entry && (!freshest || (entry.updatedAt ?? 0) > (freshest.entry.updatedAt ?? 0))) {
      freshest = { key, entry };
    }
  }
  return freshest;
}

export function cloneOptionalSessionEntry(
  entry: SessionEntry | undefined,
): SessionEntry | undefined {
  return entry ? structuredClone(entry) : undefined;
}

export function resolveProjectionExistingEntry(
  entries: readonly { sessionKey: string; entry: SessionEntry }[],
  target: SessionProjectionTarget,
): SessionEntry | undefined {
  const candidateKeys = target.candidateKeys ?? [target.primaryKey];
  let freshest: SessionEntry | undefined;
  for (const candidateKey of candidateKeys) {
    const entry = entries.find((candidate) => candidate.sessionKey === candidateKey)?.entry;
    if (entry && (!freshest || (entry.updatedAt ?? 0) > (freshest.updatedAt ?? 0))) {
      freshest = entry;
    }
  }
  return cloneOptionalSessionEntry(freshest);
}
