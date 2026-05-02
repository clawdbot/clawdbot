/**
 * Ref-index store — JSONL file-based store for message reference index.
 *
 * Migrated from src/ref-index-store.ts. Dependencies are only Node.js
 * built-ins + log + platform (both zero plugin-sdk).
 */

import fs from "node:fs";
import path from "node:path";
import { formatErrorMessage } from "../utils/format.js";
import { debugLog, debugError } from "../utils/log.js";
import { getQQBotDataDir, getQQBotDataPath } from "../utils/platform.js";
import type { RefIndexEntry } from "./types.js";

// Re-export types and format function for convenience.
export type { RefIndexEntry, RefAttachmentSummary } from "./types.js";
export { formatRefEntryForAgent } from "./format-ref-entry.js";

const MAX_ENTRIES = 50000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COMPACT_THRESHOLD_RATIO = 2;

interface RefIndexLine {
  k: string;
  v: RefIndexEntry;
  t: number;
}

let cache: Map<string, RefIndexEntry & { _createdAt: number }> | null = null;
let totalLinesOnDisk = 0;

function getRefIndexFile(): string {
  return path.join(getQQBotDataPath("data"), "ref-index.jsonl");
}

function loadFromFile(): Map<string, RefIndexEntry & { _createdAt: number }> {
  if (cache !== null) {
    return cache;
  }
  cache = new Map();
  totalLinesOnDisk = 0;

  try {
    const refIndexFile = getRefIndexFile();
    if (!fs.existsSync(refIndexFile)) {
      return cache;
    }
    const raw = fs.readFileSync(refIndexFile, "utf-8");
    const lines = raw.split("\n");
    const now = Date.now();
    let expired = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      totalLinesOnDisk++;
      try {
        const entry = JSON.parse(trimmed) as RefIndexLine;
        if (!entry.k || !entry.v || !entry.t) {
          continue;
        }
        if (now - entry.t > TTL_MS) {
          expired++;
          continue;
        }
        cache.set(entry.k, { ...entry.v, _createdAt: entry.t });
      } catch {}
    }
    debugLog(
      `[ref-index-store] Loaded ${cache.size} entries from ${totalLinesOnDisk} lines (${expired} expired)`,
    );
    if (shouldCompact()) {
      compactFile();
    }
  } catch (err) {
    debugError(`[ref-index-store] Failed to load: ${formatErrorMessage(err)}`);
    cache = new Map();
  }
  return cache;
}

function ensureDir(): void {
  getQQBotDataDir("data");
}

function appendLine(line: RefIndexLine): void {
  try {
    ensureDir();
    fs.appendFileSync(getRefIndexFile(), JSON.stringify(line) + "\n", "utf-8");
    totalLinesOnDisk++;
  } catch (err) {
    debugError(`[ref-index-store] Failed to append: ${formatErrorMessage(err)}`);
  }
}

function shouldCompact(): boolean {
  return (
    !!cache && totalLinesOnDisk > cache.size * COMPACT_THRESHOLD_RATIO && totalLinesOnDisk > 1000
  );
}

function compactFile(): void {
  if (!cache) {
    return;
  }
  const before = totalLinesOnDisk;
  try {
    ensureDir();
    const refIndexFile = getRefIndexFile();
    const tmpPath = refIndexFile + ".tmp";
    const lines: string[] = [];
    for (const [key, entry] of cache) {
      lines.push(
        JSON.stringify({
          k: key,
          v: {
            content: entry.content,
            senderId: entry.senderId,
            senderName: entry.senderName,
            timestamp: entry.timestamp,
            isBot: entry.isBot,
            attachments: entry.attachments,
          },
          t: entry._createdAt,
        }),
      );
    }
    fs.writeFileSync(tmpPath, lines.join("\n") + "\n", "utf-8");
    fs.renameSync(tmpPath, refIndexFile);
    totalLinesOnDisk = cache.size;
    debugLog(`[ref-index-store] Compacted: ${before} lines → ${totalLinesOnDisk} lines`);
  } catch (err) {
    debugError(`[ref-index-store] Compact failed: ${formatErrorMessage(err)}`);
  }
}

function evictIfNeeded(): void {
  if (!cache || cache.size < MAX_ENTRIES) {
    return;
  }
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry._createdAt > TTL_MS) {
      cache.delete(key);
    }
  }
  if (cache.size >= MAX_ENTRIES) {
    const sorted = [...cache.entries()].toSorted((a, b) => a[1]._createdAt - b[1]._createdAt);
    const toRemove = sorted.slice(0, cache.size - MAX_ENTRIES + 1000);
    for (const [key] of toRemove) {
      cache.delete(key);
    }
    debugLog(`[ref-index-store] Evicted ${toRemove.length} oldest entries`);
  }
}

/** Persist a refIdx mapping for one message. */
export function setRefIndex(refIdx: string, entry: RefIndexEntry): void {
  const store = loadFromFile();
  evictIfNeeded();
  const now = Date.now();
  store.set(refIdx, { ...entry, _createdAt: now });
  appendLine({
    k: refIdx,
    v: {
      content: entry.content,
      senderId: entry.senderId,
      senderName: entry.senderName,
      timestamp: entry.timestamp,
      isBot: entry.isBot,
      attachments: entry.attachments,
    },
    t: now,
  });
  if (shouldCompact()) {
    compactFile();
  }
}

/** Look up one quoted message by refIdx. */
export function getRefIndex(refIdx: string): RefIndexEntry | null {
  const store = loadFromFile();
  const entry = store.get(refIdx);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry._createdAt > TTL_MS) {
    store.delete(refIdx);
    return null;
  }
  return {
    content: entry.content,
    senderId: entry.senderId,
    senderName: entry.senderName,
    timestamp: entry.timestamp,
    isBot: entry.isBot,
    attachments: entry.attachments,
  };
}

/** Compact the store before process exit when needed. */
export function flushRefIndex(): void {
  if (cache && shouldCompact()) {
    compactFile();
  }
}
