import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import type { SessionEntry } from "./types.js";

// Pins are root-session facts; children live in their parent's tree.
export function isPinnableSessionEntry(
  storeKey: string,
  entry: Pick<SessionEntry, "spawnedBy" | "parentSessionKey"> | undefined,
): boolean {
  return (
    !isSubagentSessionKey(storeKey) &&
    !normalizeOptionalString(entry?.spawnedBy) &&
    !normalizeOptionalString(entry?.parentSessionKey)
  );
}
