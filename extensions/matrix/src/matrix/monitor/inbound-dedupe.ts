import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { createAsyncLock } from "../async-lock.js";
import { resolveMatrixStateFilePath } from "../client/storage.js";
import type { MatrixAuth } from "../client/types.js";
import { LogService } from "../sdk/logger.js";

const INBOUND_DEDUPE_FILENAME = "inbound-dedupe.json";
const STORE_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 20_000;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 250;

type StoredMatrixInboundDedupeEntry = {
  key: string;
  ts: number;
};

type StoredMatrixInboundDedupeState = {
  version: number;
  entries: StoredMatrixInboundDedupeEntry[];
};

export type MatrixInboundEventDeduper = {
  claimEvent: (params: { roomId: string; eventId: string }) => boolean;
  commitEvent: (params: { roomId: string; eventId: string }) => Promise<void>;
  releaseEvent: (params: { roomId: string; eventId: string }) => void;
  flush: () => Promise<void>;
  stop: () => Promise<void>;
};

function normalizeEventPart(value: string): string {
  return value.trim();
}

function buildEventKey(params: { roomId: string; eventId: string }): string {
  const roomId = normalizeEventPart(params.roomId);
  const eventId = normalizeEventPart(params.eventId);
  return roomId && eventId ? `${roomId}|${eventId}` : "";
}

function resolveInboundDedupeStatePath(params: {
  auth: MatrixAuth;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): string {
  return resolveMatrixStateFilePath({
    auth: params.auth,
    env: params.env,
    stateDir: params.stateDir,
    filename: INBOUND_DEDUPE_FILENAME,
  });
}

function normalizeTimestamp(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  return Math.max(0, Math.floor(raw));
}

function pruneSeenEvents(params: {
  seen: Map<string, number>;
  ttlMs: number;
  maxEntries: number;
  nowMs: number;
}) {
  const { seen, ttlMs, maxEntries, nowMs } = params;
  if (ttlMs > 0) {
    const cutoff = nowMs - ttlMs;
    for (const [key, ts] of seen) {
      if (ts < cutoff) {
        seen.delete(key);
      }
    }
  }
  const max = Math.max(0, Math.floor(maxEntries));
  if (max <= 0) {
    seen.clear();
    return;
  }
  while (seen.size > max) {
    const oldestKey = seen.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    seen.delete(oldestKey);
  }
}

function toStoredState(params: {
  seen: Map<string, number>;
  ttlMs: number;
  maxEntries: number;
  nowMs: number;
}): StoredMatrixInboundDedupeState {
  pruneSeenEvents(params);
  return {
    version: STORE_VERSION,
    entries: Array.from(params.seen.entries()).map(([key, ts]) => ({ key, ts })),
  };
}

async function readStoredState(
  storagePath: string,
): Promise<StoredMatrixInboundDedupeState | null> {
  const { value } = await readJsonFileWithFallback<StoredMatrixInboundDedupeState | null>(
    storagePath,
    null,
  );
  if (value?.version !== STORE_VERSION || !Array.isArray(value.entries)) {
    return null;
  }
  return value;
}

export async function createMatrixInboundEventDeduper(params: {
  auth: MatrixAuth;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  storagePath?: string;
  ttlMs?: number;
  maxEntries?: number;
  nowMs?: () => number;
}): Promise<MatrixInboundEventDeduper> {
  const nowMs = params.nowMs ?? (() => Date.now());
  const ttlMs =
    typeof params.ttlMs === "number" && Number.isFinite(params.ttlMs)
      ? Math.max(0, Math.floor(params.ttlMs))
      : DEFAULT_TTL_MS;
  const maxEntries =
    typeof params.maxEntries === "number" && Number.isFinite(params.maxEntries)
      ? Math.max(0, Math.floor(params.maxEntries))
      : DEFAULT_MAX_ENTRIES;
  const storagePath =
    params.storagePath ??
    resolveInboundDedupeStatePath({
      auth: params.auth,
      env: params.env,
      stateDir: params.stateDir,
    });

  const seen = new Map<string, number>();
  const pending = new Set<string>();
  const persistLock = createAsyncLock();

  try {
    const stored = await readStoredState(storagePath);
    for (const entry of stored?.entries ?? []) {
      if (!entry || typeof entry.key !== "string") {
        continue;
      }
      const key = entry.key.trim();
      const ts = normalizeTimestamp(entry.ts);
      if (!key || ts === null) {
        continue;
      }
      seen.set(key, ts);
    }
    pruneSeenEvents({ seen, ttlMs, maxEntries, nowMs: nowMs() });
  } catch (err) {
    LogService.warn("MatrixInboundDedupe", "Failed loading Matrix inbound dedupe store:", err);
  }

  let dirty = false;
  let persistTimer: NodeJS.Timeout | null = null;
  let persistPromise: Promise<void> | null = null;

  const persist = async () => {
    dirty = false;
    const payload = toStoredState({
      seen,
      ttlMs,
      maxEntries,
      nowMs: nowMs(),
    });
    try {
      await persistLock(async () => {
        await writeJsonFileAtomically(storagePath, payload);
      });
    } catch (err) {
      dirty = true;
      throw err;
    }
  };

  const flush = async (): Promise<void> => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    for (;;) {
      if (!dirty && !persistPromise) {
        break;
      }
      if (dirty && !persistPromise) {
        persistPromise = persist().finally(() => {
          persistPromise = null;
        });
      }
      await persistPromise;
    }
  };

  const schedulePersist = () => {
    dirty = true;
    if (persistTimer) {
      return;
    }
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void flush().catch((err) => {
        LogService.warn(
          "MatrixInboundDedupe",
          "Failed persisting Matrix inbound dedupe store:",
          err,
        );
      });
    }, PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
  };

  return {
    claimEvent: ({ roomId, eventId }) => {
      const key = buildEventKey({ roomId, eventId });
      if (!key) {
        return true;
      }
      pruneSeenEvents({ seen, ttlMs, maxEntries, nowMs: nowMs() });
      if (seen.has(key) || pending.has(key)) {
        return false;
      }
      pending.add(key);
      return true;
    },
    commitEvent: async ({ roomId, eventId }) => {
      const key = buildEventKey({ roomId, eventId });
      if (!key) {
        return;
      }
      pending.delete(key);
      const ts = nowMs();
      seen.delete(key);
      seen.set(key, ts);
      pruneSeenEvents({ seen, ttlMs, maxEntries, nowMs: nowMs() });
      schedulePersist();
    },
    releaseEvent: ({ roomId, eventId }) => {
      const key = buildEventKey({ roomId, eventId });
      if (!key) {
        return;
      }
      pending.delete(key);
    },
    flush,
    stop: async () => {
      try {
        await flush();
      } catch (err) {
        LogService.warn(
          "MatrixInboundDedupe",
          "Failed to flush Matrix inbound dedupe store during stop():",
          err,
        );
      }
    },
  };
}
