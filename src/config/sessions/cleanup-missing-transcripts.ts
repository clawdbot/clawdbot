import { parseAgentSessionKey } from "../../routing/session-key.js";
import { inspectTranscriptEventsSync } from "./session-accessor.js";
import { shouldPreserveMaintenanceEntry } from "./store-maintenance.js";
import type { SessionStoreTarget } from "./targets.js";
import type { SessionEntry } from "./types.js";

function isTranscriptMessageRole(role: unknown): boolean {
  return (
    role === "user" ||
    role === "assistant" ||
    role === "tool" ||
    role === "toolResult" ||
    role === "system"
  );
}

function isTranscriptMessageRecord(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const type = "type" in entry ? entry.type : undefined;
  if (type === "message") {
    return true;
  }
  if (
    type === undefined &&
    "message" in entry &&
    entry.message &&
    typeof entry.message === "object" &&
    "role" in entry.message &&
    isTranscriptMessageRole(entry.message.role)
  ) {
    return true;
  }
  return type === undefined && "role" in entry && isTranscriptMessageRole(entry.role);
}

function inspectConfirmedMessageFreeTranscript(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}) {
  try {
    const inspection = inspectTranscriptEventsSync(params);
    return inspection.events.some(isTranscriptMessageRecord) ? undefined : inspection;
  } catch {
    return undefined;
  }
}

export function pruneMissingTranscriptEntries(params: {
  store: Record<string, SessionEntry>;
  target: SessionStoreTarget;
  onPruned?: (
    key: string,
    entry: SessionEntry,
    inspection?: ReturnType<typeof inspectConfirmedMessageFreeTranscript>,
  ) => void;
}): number {
  let removed = 0;
  for (const [key, entry] of Object.entries(params.store)) {
    // `--fix-missing` cannot release harness ownership or delete a user-shelved archive.
    if (
      (entry?.modelSelectionLocked === true || entry?.archivedAt !== undefined) &&
      shouldPreserveMaintenanceEntry({ key, entry })
    ) {
      continue;
    }
    const legacySessionFile = "sessionFile" in entry ? entry.sessionFile : undefined;
    // Explicitly pending sessions and their shipped pre-flag shape may not have a first turn yet.
    if (
      parseAgentSessionKey(key) &&
      (entry.initializationPending === true ||
        (entry.sessionId === key &&
          (typeof legacySessionFile !== "string" || !legacySessionFile.trim())))
    ) {
      continue;
    }
    if (!entry?.sessionId) {
      if (parseAgentSessionKey(key)) {
        // Agent-scoped keys without session ids are valid routing entries; keep them.
        continue;
      }
      delete params.store[key];
      removed += 1;
      params.onPruned?.(key, entry);
      continue;
    }
    const inspection = inspectConfirmedMessageFreeTranscript({
      ...params.target,
      sessionId: entry.sessionId,
      sessionKey: key,
    });
    if (inspection) {
      delete params.store[key];
      removed += 1;
      params.onPruned?.(key, entry, inspection);
    }
  }
  return removed;
}
