import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow, writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { loadSessionEntryReadOnly } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  createSessionRecipientAuthorityEpoch,
  readSessionRecipientAuthorityEpoch,
  sessionRecipientAuthorityMatches,
  type SessionRecipientAuthority,
} from "./session-recipient-authority-types.js";

export function advanceSessionRecipientAuthorityInTransaction(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): boolean {
  const selected = readSessionEntryRow(database, sessionKey);
  if (!selected) {
    return false;
  }
  writeSessionEntry(
    database,
    sessionKey,
    {
      ...selected.entry,
      recipientAuthorityEpoch: createSessionRecipientAuthorityEpoch(),
    },
    { previousEntry: selected.entry },
  );
  return true;
}

export function captureSessionRecipientAuthority(
  scope: SessionAccessScope,
): SessionRecipientAuthority {
  const resolved = resolveSqliteScope(scope);
  return runOpenClawAgentWriteTransaction((database) => {
    const selected = readSessionEntryRow(database, resolved.sessionKey);
    if (!selected) {
      return { state: "absent" };
    }
    const current = readSessionRecipientAuthorityEpoch(selected.entry);
    if (current.state === "malformed") {
      throw new Error(`Invalid recipient authority epoch for session ${resolved.sessionKey}`);
    }
    if (current.state === "present") {
      return { state: "bound", epoch: current.epoch };
    }
    const epoch = createSessionRecipientAuthorityEpoch();
    writeSessionEntry(
      database,
      resolved.sessionKey,
      { ...selected.entry, recipientAuthorityEpoch: epoch },
      { previousEntry: selected.entry },
    );
    return { state: "bound", epoch };
  }, toDatabaseOptions(resolved));
}

export function isSessionRecipientAuthorityCurrent(
  scope: SessionAccessScope,
  authority: SessionRecipientAuthority,
): boolean {
  return sessionRecipientAuthorityMatches(authority, loadSessionEntryReadOnly(scope));
}
