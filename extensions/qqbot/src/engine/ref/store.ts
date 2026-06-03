/**
 * Ref-index store — SQLite KV-backed store for message reference index.
 *
 * Legacy JSONL entries are imported once, then deleted after SQLite has the
 * canonical ref-index rows.
 */

import fs from "node:fs";
import path from "node:path";
import { formatErrorMessage } from "../utils/format.js";
import { debugLog, debugError } from "../utils/log.js";
import { getQQBotDataPath } from "../utils/platform.js";
import { buildQQBotStateKey, openQQBotSyncKeyedStore } from "../utils/sqlite-state.js";
import type { RefAttachmentSummary, RefIndexEntry } from "./types.js";

// Re-export types and format function for convenience.
export type { RefIndexEntry, RefAttachmentSummary } from "./types.js";
export { formatRefEntryForAgent } from "./format-ref-entry.js";

const MAX_ENTRIES = 50000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REF_INDEX_NAMESPACE = "ref-index";
const REF_INDEX_MIGRATIONS_NAMESPACE = "ref-index-migrations";
const LEGACY_REF_INDEX_MIGRATION_KEY = "ref-index-jsonl-v1";

interface RefIndexLine {
  k: string;
  v: RefIndexEntry;
  t: number;
}

type StoredRefIndexEntry = RefIndexEntry & {
  createdAt: number;
};

type RefIndexMigrationMarker = {
  importedAt: string;
};

let legacyImported = false;

function getRefIndexFile(): string {
  return path.join(getQQBotDataPath("data"), "ref-index.jsonl");
}

function createRefIndexStore() {
  return openQQBotSyncKeyedStore<StoredRefIndexEntry>({
    namespace: REF_INDEX_NAMESPACE,
    maxEntries: MAX_ENTRIES,
    defaultTtlMs: TTL_MS,
  });
}

function createRefIndexMigrationStore() {
  return openQQBotSyncKeyedStore<RefIndexMigrationMarker>({
    namespace: REF_INDEX_MIGRATIONS_NAMESPACE,
    maxEntries: 100,
  });
}

function refIndexStateKey(refIdx: string): string {
  return buildQQBotStateKey("ref-index", refIdx);
}

function toStoredAttachment(attachment: RefAttachmentSummary): RefAttachmentSummary {
  return {
    type: attachment.type,
    ...(attachment.filename !== undefined ? { filename: attachment.filename } : {}),
    ...(attachment.contentType !== undefined ? { contentType: attachment.contentType } : {}),
    ...(attachment.transcript !== undefined ? { transcript: attachment.transcript } : {}),
    ...(attachment.transcriptSource !== undefined
      ? { transcriptSource: attachment.transcriptSource }
      : {}),
    ...(attachment.localPath !== undefined ? { localPath: attachment.localPath } : {}),
    ...(attachment.url !== undefined ? { url: attachment.url } : {}),
  };
}

function toStoredRefIndexEntry(entry: RefIndexEntry, createdAt: number): StoredRefIndexEntry {
  return {
    content: entry.content,
    senderId: entry.senderId,
    ...(entry.senderName !== undefined ? { senderName: entry.senderName } : {}),
    timestamp: entry.timestamp,
    ...(entry.isBot !== undefined ? { isBot: entry.isBot } : {}),
    ...(entry.attachments ? { attachments: entry.attachments.map(toStoredAttachment) } : {}),
    createdAt,
  };
}

function toRefIndexEntry(entry: StoredRefIndexEntry): RefIndexEntry {
  return {
    content: entry.content,
    senderId: entry.senderId,
    ...(entry.senderName !== undefined ? { senderName: entry.senderName } : {}),
    timestamp: entry.timestamp,
    ...(entry.isBot !== undefined ? { isBot: entry.isBot } : {}),
    ...(entry.attachments ? { attachments: entry.attachments.map(toStoredAttachment) } : {}),
  };
}

function ensureLegacyRefIndexImported(): void {
  if (legacyImported) {
    return;
  }
  const migrationStore = createRefIndexMigrationStore();
  if (migrationStore.lookup(LEGACY_REF_INDEX_MIGRATION_KEY)) {
    legacyImported = true;
    return;
  }
  try {
    const refIndexFile = getRefIndexFile();
    if (!fs.existsSync(refIndexFile)) {
      migrationStore.register(LEGACY_REF_INDEX_MIGRATION_KEY, {
        importedAt: new Date().toISOString(),
      });
      legacyImported = true;
      return;
    }
    const raw = fs.readFileSync(refIndexFile, "utf-8");
    const lines = raw.split("\n");
    const now = Date.now();
    let expired = 0;
    let imported = 0;
    const store = createRefIndexStore();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const entry = JSON.parse(trimmed) as RefIndexLine;
        if (!entry.k || !entry.v || !entry.t) {
          continue;
        }
        if (now - entry.t > TTL_MS) {
          expired++;
          continue;
        }
        store.register(refIndexStateKey(entry.k), toStoredRefIndexEntry(entry.v, entry.t), {
          ttlMs: Math.max(1, TTL_MS - (now - entry.t)),
        });
        imported++;
      } catch {}
    }
    migrationStore.register(LEGACY_REF_INDEX_MIGRATION_KEY, {
      importedAt: new Date().toISOString(),
    });
    legacyImported = true;
    fs.rmSync(refIndexFile, { force: true });
    debugLog(`[ref-index-store] Migrated ${imported} entries to SQLite (${expired} expired)`);
  } catch (err) {
    debugError(`[ref-index-store] Failed to import legacy JSONL: ${formatErrorMessage(err)}`);
  }
}

/** Persist a refIdx mapping for one message. */
export function setRefIndex(refIdx: string, entry: RefIndexEntry): void {
  try {
    ensureLegacyRefIndexImported();
    const now = Date.now();
    createRefIndexStore().register(refIndexStateKey(refIdx), toStoredRefIndexEntry(entry, now), {
      ttlMs: TTL_MS,
    });
  } catch (err) {
    debugError(`[ref-index-store] Failed to persist ref index: ${formatErrorMessage(err)}`);
  }
}

/** Look up one quoted message by refIdx. */
export function getRefIndex(refIdx: string): RefIndexEntry | null {
  try {
    ensureLegacyRefIndexImported();
    const store = createRefIndexStore();
    const key = refIndexStateKey(refIdx);
    const entry = store.lookup(key);
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.createdAt > TTL_MS) {
      store.delete(key);
      return null;
    }
    return toRefIndexEntry(entry);
  } catch (err) {
    debugError(`[ref-index-store] Failed to read ref index: ${formatErrorMessage(err)}`);
    return null;
  }
}

/** Compact the store before process exit when needed. */
export function flushRefIndex(): void {
  // SQLite writes are synchronous; no JSONL compaction remains.
}
