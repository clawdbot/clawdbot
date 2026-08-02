import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../io.js";
import { canonicalSessionKeyMigrationRequiredError } from "./session-canonical-key.js";
import { resolveSessionStoreTargetWithStore } from "./session-store-target.js";
import type { SessionEntry } from "./types.js";

function loadResolvedSessionEntryWithMode(
  sessionKey: string,
  opts: { agentId?: string; clone?: boolean; includeStoreChildEntries?: boolean } | undefined,
  readOnly: boolean,
) {
  const cfg = getRuntimeConfig();
  const key = normalizeOptionalString(sessionKey) ?? "";
  const target = resolveSessionStoreTargetWithStore({
    cfg,
    key,
    ...(opts?.clone === false ? { clone: false } : {}),
    ...(opts?.agentId ? { agentId: opts.agentId } : {}),
    ...(readOnly
      ? {
          exactRead: true,
          readOnly: true,
          ...(opts?.includeStoreChildEntries ? { includeStoreChildEntries: true } : {}),
        }
      : {}),
  });
  const canonicalMatch = resolveCanonicalSessionStoreMatchFromStoreKeys(
    target.store,
    target.storeKeys,
  );
  const legacyKey = canonicalMatch?.key !== target.canonicalKey ? canonicalMatch?.key : undefined;
  const entry =
    readOnly && opts?.clone !== false && canonicalMatch?.entry
      ? structuredClone(canonicalMatch.entry)
      : canonicalMatch?.entry;
  return {
    cfg,
    storePath: target.storePath,
    store: target.store,
    entry,
    canonicalKey: target.canonicalKey,
    storeKeys: target.storeKeys,
    legacyKey,
  };
}

export function loadResolvedSessionEntry(
  sessionKey: string,
  opts?: { agentId?: string; clone?: boolean },
) {
  return loadResolvedSessionEntryWithMode(sessionKey, opts, false);
}

export function loadResolvedSessionEntryReadOnly(
  sessionKey: string,
  opts?: { agentId?: string; clone?: boolean; includeStoreChildEntries?: boolean },
) {
  return loadResolvedSessionEntryWithMode(sessionKey, opts, true);
}

/** Returns the canonical entry and the exact persisted key that owns it. */
export function resolveCanonicalSessionStoreMatchFromStoreKeys(
  store: Record<string, SessionEntry>,
  storeKeys: string[],
): { key: string; entry: SessionEntry } | undefined {
  let selected: { key: string; entry: SessionEntry } | undefined;
  for (const key of storeKeys) {
    const entry = store[key];
    if (!entry) {
      continue;
    }
    const match = { key, entry };
    if (selected) {
      throw canonicalSessionKeyMigrationRequiredError(
        `duplicate rows resolve to canonical session key ${storeKeys[0] ?? key}`,
      );
    }
    selected = match;
  }
  if (selected && selected.key !== storeKeys[0]) {
    throw canonicalSessionKeyMigrationRequiredError(
      `non-canonical persisted row resolves to session key ${storeKeys[0] ?? selected.key}`,
    );
  }
  return selected;
}

export function resolveCanonicalSessionEntryFromStoreKeys(
  store: Record<string, SessionEntry>,
  storeKeys: string[],
): SessionEntry | undefined {
  return resolveCanonicalSessionStoreMatchFromStoreKeys(store, storeKeys)?.entry;
}
