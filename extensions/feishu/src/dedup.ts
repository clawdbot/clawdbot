import os from "node:os";
import path from "node:path";
import { createDedupeCache, createPersistentDedupe } from "./dedup-runtime-api.js";

// Persistent TTL: 24 hours — survives restarts & WebSocket reconnects.
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const MEMORY_MAX_SIZE = 1_000;
const FILE_MAX_ENTRIES = 10_000;
const EVENT_DEDUP_TTL_MS = 5 * 60 * 1000;
const EVENT_MEMORY_MAX_SIZE = 2_000;
const processingClaims = createDedupeCache({
  ttlMs: EVENT_DEDUP_TTL_MS,
  maxSize: EVENT_MEMORY_MAX_SIZE,
});

function resolveStateDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
  if (stateOverride) {
    return stateOverride;
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), ["openclaw-vitest", String(process.pid)].join("-"));
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveNamespaceFilePath(namespace: string): string {
  const safe = namespace.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(resolveStateDirFromEnv(), "feishu", "dedup", `${safe}.json`);
}

const persistentDedupe = createPersistentDedupe({
  ttlMs: DEDUP_TTL_MS,
  memoryMaxSize: MEMORY_MAX_SIZE,
  fileMaxEntries: FILE_MAX_ENTRIES,
  resolveFilePath: resolveNamespaceFilePath,
});

function resolveEventDedupeKey(
  namespace: string,
  messageId: string | undefined | null,
): string | null {
  const trimmed = messageId?.trim();
  if (!trimmed) {
    return null;
  }
  return `${namespace}:${trimmed}`;
}

function normalizeMessageId(messageId: string | undefined | null): string | null {
  const trimmed = messageId?.trim();
  return trimmed ? trimmed : null;
}

export function tryBeginFeishuMessageProcessing(
  messageId: string | undefined | null,
  namespace = "global",
): boolean {
  return !processingClaims.check(resolveEventDedupeKey(namespace, messageId));
}

export function releaseFeishuMessageProcessing(
  messageId: string | undefined | null,
  namespace = "global",
): void {
  processingClaims.delete(resolveEventDedupeKey(namespace, messageId));
}

export async function claimUnprocessedFeishuMessage(params: {
  messageId: string | undefined | null;
  namespace?: string;
  log?: (...args: unknown[]) => void;
}): Promise<"claimed" | "duplicate" | "inflight" | "invalid"> {
  const { messageId, namespace = "global", log } = params;
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!normalizedMessageId) {
    return "invalid";
  }
  if (await hasProcessedFeishuMessage(normalizedMessageId, namespace, log)) {
    return "duplicate";
  }
  if (!tryBeginFeishuMessageProcessing(normalizedMessageId, namespace)) {
    return "inflight";
  }
  return "claimed";
}

export async function finalizeFeishuMessageProcessing(params: {
  messageId: string | undefined | null;
  namespace?: string;
  log?: (...args: unknown[]) => void;
  claimHeld?: boolean;
}): Promise<boolean> {
  const { messageId, namespace = "global", log, claimHeld = false } = params;
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!normalizedMessageId) {
    return false;
  }
  if (!claimHeld && !tryBeginFeishuMessageProcessing(normalizedMessageId, namespace)) {
    return false;
  }
  if (!(await tryRecordMessagePersistent(normalizedMessageId, namespace, log))) {
    releaseFeishuMessageProcessing(normalizedMessageId, namespace);
    return false;
  }
  return true;
}

export async function recordProcessedFeishuMessage(
  messageId: string | undefined | null,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!normalizedMessageId) {
    return false;
  }
  return await tryRecordMessagePersistent(normalizedMessageId, namespace, log);
}

export async function hasProcessedFeishuMessage(
  messageId: string | undefined | null,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!normalizedMessageId) {
    return false;
  }
  return hasRecordedMessagePersistent(normalizedMessageId, namespace, log);
}

export async function tryRecordMessagePersistent(
  messageId: string,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  return persistentDedupe.checkAndRecord(messageId, {
    namespace,
    onDiskError: (error) => {
      log?.(`feishu-dedup: disk error, falling back to memory: ${String(error)}`);
    },
  });
}

export async function hasRecordedMessagePersistent(
  messageId: string,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  return persistentDedupe.hasRecent(messageId, {
    namespace,
    onDiskError: (error) => {
      log?.(`feishu-dedup: persistent peek failed: ${String(error)}`);
    },
  });
}

export async function warmupDedupFromDisk(
  namespace: string,
  log?: (...args: unknown[]) => void,
): Promise<number> {
  return persistentDedupe.warmup(namespace, (error) => {
    log?.(`feishu-dedup: warmup disk error: ${String(error)}`);
  });
}
