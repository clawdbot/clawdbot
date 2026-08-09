import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  deleteLegacySessionEntryRows,
  readExactSessionEntryRow,
  sqliteSessionEntriesEqual,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { cloneSessionEntry } from "./session-accessor.sqlite-scope.js";
import type { SessionEntryReplacement } from "./session-accessor.types.js";
import type { SessionEntry } from "./types.js";

export function normalizeSqliteSessionEntryReplacements(
  replacements: Iterable<SessionEntryReplacement> | undefined,
): SessionEntryReplacement[] {
  const normalized: SessionEntryReplacement[] = [];
  for (const replacement of replacements ?? []) {
    const sessionKey = replacement.sessionKey.trim();
    if (replacement.previousSessionKeys === undefined) {
      normalized.push({ entry: replacement.entry, sessionKey });
      continue;
    }
    normalized.push({
      entry: replacement.entry,
      previousSessionKeys: uniqueStrings(
        replacement.previousSessionKeys.map((key) => key.trim()).filter(Boolean),
      ),
      sessionKey,
    });
  }
  return normalized;
}

export function validateSqliteSessionEntryReplacements(
  database: OpenClawAgentDatabase,
  replacements: readonly SessionEntryReplacement[],
  expectedEntries: ReadonlyMap<string, SessionEntry>,
): void {
  for (const replacement of replacements) {
    for (const sessionKey of [replacement.sessionKey, ...(replacement.previousSessionKeys ?? [])]) {
      const transactionEntry = readExactSessionEntryRow(database, sessionKey)?.entry;
      if (!sqliteSessionEntriesEqual(transactionEntry, expectedEntries.get(sessionKey))) {
        throw new Error(`SQLite session entry changed before replacement for ${sessionKey}`);
      }
    }
  }
}

/** Synchronous row primitive; the projection owner supplies the transaction. */
export function commitSqliteSessionEntryReplacement(
  database: OpenClawAgentDatabase,
  replacement: SessionEntryReplacement,
  expectedEntries: ReadonlyMap<string, SessionEntry>,
): Array<{ entry: SessionEntry; sessionKey: string }> {
  const previousSessionKeys = replacement.previousSessionKeys ?? [];
  const sourceEntries = [replacement.sessionKey, ...previousSessionKeys].flatMap((sessionKey) => {
    const entry = expectedEntries.get(sessionKey);
    return entry ? [{ entry, sessionKey }] : [];
  });
  let selectedBefore: SessionEntry | undefined;
  for (const { entry } of sourceEntries) {
    if (!selectedBefore || (entry.updatedAt ?? 0) > (selectedBefore.updatedAt ?? 0)) {
      selectedBefore = entry;
    }
  }
  writeSessionEntry(database, replacement.sessionKey, cloneSessionEntry(replacement.entry), {
    previousEntry: selectedBefore ?? null,
  });
  deleteLegacySessionEntryRows(database, [...previousSessionKeys], replacement.sessionKey, {
    rehomeMembers: selectedBefore?.sessionId === replacement.entry.sessionId,
  });
  return sourceEntries;
}
