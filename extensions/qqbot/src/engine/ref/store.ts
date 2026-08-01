/**
 * Ref-index store — SQLite KV-backed store for message reference index.
 */

import { formatErrorMessage } from "../utils/format.js";
import { debugError } from "../utils/log.js";
import { buildQQBotStateKey, openQQBotSyncKeyedStore } from "../utils/sqlite-state.js";
import type { RefAttachmentSummary, RefIndexEntry } from "./types.js";

// Re-export the formatter for convenience.
export { formatRefEntryForAgent } from "./format-ref-entry.js";

const MAX_ENTRIES = 50000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REF_INDEX_NAMESPACE = "ref-index";

type StoredRefIndexEntry = RefIndexEntry & {
  createdAt: number;
};

function createRefIndexStore() {
  return openQQBotSyncKeyedStore<StoredRefIndexEntry>({
    namespace: REF_INDEX_NAMESPACE,
    maxEntries: MAX_ENTRIES,
    defaultTtlMs: TTL_MS,
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

/** Persist a refIdx mapping for one message. */
export function setRefIndex(refIdx: string, entry: RefIndexEntry): void {
  try {
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
