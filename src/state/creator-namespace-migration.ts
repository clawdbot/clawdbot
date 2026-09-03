import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionActor } from "../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";

/** Doctor and versioned upgrades alone may qualify historical creation seams. */
export function migrateLegacySessionCreator(entry: SessionEntry): SessionEntry {
  // SAFETY: Doctor owns retired input; createdBy is checked as a record before it is used.
  const legacy = entry as SessionEntry & { createdBy?: SessionActor };
  const actor =
    entry.createdActor ??
    (isRecord(legacy.createdBy)
      ? { ...legacy.createdBy, type: "human" as const, source: "unknown" as const }
      : undefined);
  if (actor?.type !== "human") {
    return entry;
  }
  const source =
    actor.source === "profile" || actor.source === "channel" || actor.source === "unknown"
      ? actor.source
      : entry.createdVia === "operator" || entry.createdVia === "run"
        ? "profile"
        : entry.createdVia === "channel"
          ? "channel"
          : "unknown";
  if (actor === entry.createdActor && source === actor.source && !legacy.createdBy) {
    return entry;
  }
  const migrated = { ...legacy, createdActor: { ...actor, source } };
  delete migrated.createdBy;
  return migrated;
}
