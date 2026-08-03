// Gateway session child-discovery helpers.
// Finds direct parent/child relationships across canonical and legacy fields.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { loadCombinedSessionStoreForGateway } from "../config/sessions/combined-store-gateway.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

// Child-session discovery reads the combined gateway session store and matches
// both legacy spawnedBy and newer parentSessionKey relationships.
/** Direct child session entry returned for parent session lookups. */
type DirectChildSessionEntry = {
  sessionKey: string;
  entry: SessionEntry;
};

/** Returns true when a session store row is a direct child of the parent key. */
function isDirectChildSessionEntry(params: {
  sessionKey: string;
  entry: SessionEntry | undefined;
  parentKey: string;
}): boolean {
  const parentKey = normalizeOptionalString(params.parentKey);
  if (!parentKey || params.sessionKey === parentKey || !params.entry) {
    return false;
  }
  return (
    normalizeOptionalString(params.entry.spawnedBy) === parentKey ||
    normalizeOptionalString(params.entry.parentSessionKey) === parentKey
  );
}

/** Finds direct child sessions for a parent session across the combined gateway store. */
export function findDirectChildSessionsForParent(params: {
  cfg: OpenClawConfig;
  parentKey: string;
}): DirectChildSessionEntry[] {
  const { store } = loadCombinedSessionStoreForGateway(params.cfg);
  return Object.entries(store)
    .filter(([sessionKey, entry]) =>
      isDirectChildSessionEntry({
        sessionKey,
        entry,
        parentKey: params.parentKey,
      }),
    )
    .map(([sessionKey, entry]) => ({ sessionKey, entry }));
}
