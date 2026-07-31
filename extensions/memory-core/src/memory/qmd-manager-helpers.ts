import crypto from "node:crypto";
import path from "node:path";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { ResolvedQmdConfig } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { isFutureDateTimestampMs, MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export const SEARCH_PENDING_UPDATE_WAIT_MS = 500;
export const MAX_QMD_OUTPUT_CHARS = 200_000;
export const QMD_EMBED_BACKOFF_BASE_MS = 60_000;
export const QMD_EMBED_BACKOFF_MAX_MS = 60 * 60 * 1000;

const QMD_EMBED_LEASE_MIN_WAIT_MS = 15 * 60 * 1000;
const QMD_WRITE_LEASE_MIN_WAIT_MS = 5 * 60 * 1000;
const QMD_EMBED_QUEUE_KEY = Symbol.for("openclaw.qmdEmbedQueueTail");
const QMD_UPDATE_QUEUE_KEY = Symbol.for("openclaw.qmdUpdateQueueState");
const IGNORED_MEMORY_WATCH_DIR_NAMES = new Set([
  ".git",
  ".cache",
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".pnpm-store",
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
]);

type QmdEmbedQueueState = {
  tail: Promise<void>;
};

type QmdUpdateQueueState = {
  tails: Map<string, Promise<void>>;
};

export function qmdUsesVectors(searchMode: ResolvedQmdConfig["searchMode"]): boolean {
  return searchMode !== "search";
}

export function buildQmdProcessPath(rawPath: string | undefined): string {
  const nodeBinDir = path.dirname(process.execPath);
  const entries = rawPath?.split(path.delimiter).filter(Boolean) ?? [];
  if (entries.includes(nodeBinDir)) {
    return rawPath ?? nodeBinDir;
  }
  return [...entries, nodeBinDir].join(path.delimiter);
}

export function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : fallback;
}

export function getQmdEmbedQueueState(): QmdEmbedQueueState {
  return resolveGlobalSingleton<QmdEmbedQueueState>(QMD_EMBED_QUEUE_KEY, () => ({
    tail: Promise.resolve(),
  }));
}

export function getQmdUpdateQueueState(): QmdUpdateQueueState {
  return resolveGlobalSingleton<QmdUpdateQueueState>(QMD_UPDATE_QUEUE_KEY, () => ({
    tails: new Map<string, Promise<void>>(),
  }));
}

export function normalizeHanBm25Query(query: string): string {
  const trimmed = query.trim();
  // Keep Han/CJK BM25 queries intact so OpenClaw search semantics match direct qmd search.
  return trimmed;
}

export function parseQmdStatusVectorCount(raw: string): number | null {
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*Vectors(?:\s*[:=]\s*|\s+)(\d+)\b/i);
    if (match?.[1]) {
      const count = Number.parseInt(match[1], 10);
      if (Number.isFinite(count)) {
        return count;
      }
    }
  }
  return null;
}

export function resolveStableJitterMs(params: { seed: string; windowMs: number }): number {
  if (params.windowMs <= 0) {
    return 0;
  }
  const hash = crypto.createHash("sha256").update(params.seed).digest();
  const bucket = hash.readUInt32BE(0);
  return bucket % (Math.floor(params.windowMs) + 1);
}

function resolveQmdWriteLeaseOptions(expectedMs: number, minWaitMs: number) {
  const expected = Math.max(1, expectedMs);
  return {
    leaseMs: Math.min(MAX_TIMER_TIMEOUT_MS, Math.max(minWaitMs, expected * 2)),
    waitMs: Math.min(MAX_TIMER_TIMEOUT_MS, Math.max(minWaitMs, expected * 6)),
  };
}

// Cross-process serialization for qmd embeds (heavy ML work, serialized globally).
export function resolveQmdEmbedLeaseOptions(embedTimeoutMs: number) {
  return resolveQmdWriteLeaseOptions(embedTimeoutMs, QMD_EMBED_LEASE_MIN_WAIT_MS);
}

// One per-agent write lease shared by the update and embed phases (both write the
// same qmd index.sqlite), so a foreground `memory search` dirty-sync and a
// background gateway update/embed never write the same store at once
// (writer-vs-writer SQLITE_BUSY, #66339). Sized to the slower of the two writes
// so a contending caller waits for the in-flight write instead of erroring.
export function resolveQmdStoreWriteLeaseOptions(updateTimeoutMs: number, embedTimeoutMs: number) {
  return resolveQmdWriteLeaseOptions(
    Math.max(updateTimeoutMs, embedTimeoutMs),
    QMD_WRITE_LEASE_MIN_WAIT_MS,
  );
}

function hasIgnoredMemoryWatchSegment(relativePath: string): boolean {
  const parts = relativePath
    .split(path.sep)
    .map((segment) => normalizeLowercaseStringOrEmpty(segment))
    .filter(Boolean);
  return parts.some((segment) => IGNORED_MEMORY_WATCH_DIR_NAMES.has(segment));
}

export function shouldIgnoreMemoryWatchPath(watchPath: string, roots: readonly string[]): boolean {
  const normalized = path.normalize(watchPath);
  let matchedRelative: string | null = null;
  let matchedRootLength = -1;
  for (const watchRoot of roots) {
    const normalizedRoot = path.normalize(watchRoot);
    const relative = path.relative(normalizedRoot, normalized);
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      if (normalizedRoot.length > matchedRootLength) {
        matchedRelative = relative;
        matchedRootLength = normalizedRoot.length;
      }
    }
  }
  if (matchedRelative !== null) {
    if (matchedRelative === "") {
      return false;
    }
    return hasIgnoredMemoryWatchSegment(matchedRelative);
  }
  return hasIgnoredMemoryWatchSegment(normalized);
}

export function isEmbedBackoffActive(embedBackoffUntil: number | null): boolean {
  return embedBackoffUntil !== null && isFutureDateTimestampMs(embedBackoffUntil);
}
