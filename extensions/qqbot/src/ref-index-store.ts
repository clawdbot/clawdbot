import fs from "node:fs";
import path from "node:path";
import { debugLog, debugError } from "./utils/debug-log.js";
import { getQQBotDataDir } from "./utils/platform.js";

/** Summary stored for one quoted message. */
export interface RefIndexEntry {
  content: string;
  senderId: string;
  senderName?: string;
  timestamp: number;
  isBot?: boolean;
  attachments?: RefAttachmentSummary[];
}

/** Attachment summary persisted alongside a ref index entry. */
export interface RefAttachmentSummary {
  type: "image" | "voice" | "video" | "file" | "unknown";
  filename?: string;
  contentType?: string;
  transcript?: string;
  transcriptSource?: "stt" | "asr" | "tts" | "fallback";
  localPath?: string;
  url?: string;
}

const STORAGE_DIR = getQQBotDataDir("data");
const REF_INDEX_FILE = path.join(STORAGE_DIR, "ref-index.jsonl");
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

/** Lazily load the JSONL store into memory. */
function loadFromFile(): Map<string, RefIndexEntry & { _createdAt: number }> {
  if (cache !== null) {
    return cache;
  }

  cache = new Map();
  totalLinesOnDisk = 0;

  try {
    if (!fs.existsSync(REF_INDEX_FILE)) {
      return cache;
    }

    const raw = fs.readFileSync(REF_INDEX_FILE, "utf-8");
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

        cache.set(entry.k, {
          ...entry.v,
          _createdAt: entry.t,
        });
      } catch {}
    }

    debugLog(
      `[ref-index-store] Loaded ${cache.size} entries from ${totalLinesOnDisk} lines (${expired} expired)`,
    );

    if (shouldCompact()) {
      compactFile();
    }
  } catch (err) {
    debugError(`[ref-index-store] Failed to load: ${String(err)}`);
    cache = new Map();
  }

  return cache;
}

/** Append one record to the JSONL file. */
function appendLine(line: RefIndexLine): void {
  try {
    ensureDir();
    fs.appendFileSync(REF_INDEX_FILE, JSON.stringify(line) + "\n", "utf-8");
    totalLinesOnDisk++;
  } catch (err) {
    debugError(`[ref-index-store] Failed to append: ${String(err)}`);
  }
}

function ensureDir(): void {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

function shouldCompact(): boolean {
  if (!cache) {
    return false;
  }
  return totalLinesOnDisk > cache.size * COMPACT_THRESHOLD_RATIO && totalLinesOnDisk > 1000;
}

function compactFile(): void {
  if (!cache) {
    return;
  }

  const before = totalLinesOnDisk;
  try {
    ensureDir();
    const tmpPath = REF_INDEX_FILE + ".tmp";
    const lines: string[] = [];

    for (const [key, entry] of cache) {
      const line: RefIndexLine = {
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
      };
      lines.push(JSON.stringify(line));
    }

    fs.writeFileSync(tmpPath, lines.join("\n") + "\n", "utf-8");
    fs.renameSync(tmpPath, REF_INDEX_FILE);
    totalLinesOnDisk = cache.size;
    debugLog(`[ref-index-store] Compacted: ${before} lines → ${totalLinesOnDisk} lines`);
  } catch (err) {
    debugError(
      `[ref-index-store] Compact failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`,
    );
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
  store.set(refIdx, {
    content: entry.content,
    senderId: entry.senderId,
    senderName: entry.senderName,
    timestamp: entry.timestamp,
    isBot: entry.isBot,
    attachments: entry.attachments,
    _createdAt: now,
  });

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

/** Format a ref-index entry into text suitable for model context. */
export function formatRefEntryForAgent(entry: RefIndexEntry): string {
  const parts: string[] = [];

  if (entry.content.trim()) {
    parts.push(entry.content);
  }

  if (entry.attachments?.length) {
    for (const att of entry.attachments) {
      const sourceHint = att.localPath ? ` (${att.localPath})` : att.url ? ` (${att.url})` : "";
      switch (att.type) {
        case "image":
          parts.push(`[image${att.filename ? `: ${att.filename}` : ""}${sourceHint}]`);
          break;
        case "voice":
          if (att.transcript) {
            const sourceMap = {
              stt: "local STT",
              asr: "platform ASR",
              tts: "TTS source",
              fallback: "fallback text",
            };
            const sourceTag = att.transcriptSource
              ? ` - ${sourceMap[att.transcriptSource] || att.transcriptSource}`
              : "";
            parts.push(`[voice message (content: "${att.transcript}"${sourceTag})${sourceHint}]`);
          } else {
            parts.push(`[voice message${sourceHint}]`);
          }
          break;
        case "video":
          parts.push(`[video${att.filename ? `: ${att.filename}` : ""}${sourceHint}]`);
          break;
        case "file":
          parts.push(`[file${att.filename ? `: ${att.filename}` : ""}${sourceHint}]`);
          break;
        default:
          parts.push(`[attachment${att.filename ? `: ${att.filename}` : ""}${sourceHint}]`);
      }
    }
  }

  return parts.join(" ") || "[empty message]";
}

/** Compact the store before process exit when needed. */
export function flushRefIndex(): void {
  if (cache && shouldCompact()) {
    compactFile();
  }
}

/** Return ref-index stats for diagnostics. */
export function getRefIndexStats(): {
  size: number;
  maxEntries: number;
  totalLinesOnDisk: number;
  filePath: string;
} {
  const store = loadFromFile();
  return {
    size: store.size,
    maxEntries: MAX_ENTRIES,
    totalLinesOnDisk,
    filePath: REF_INDEX_FILE,
  };
}
