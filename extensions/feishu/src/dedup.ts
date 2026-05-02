import os from "node:os";
import path from "node:path";
import { createPersistentDedupe } from "./dedup-runtime-api.js";
import {
  releaseFeishuMessageProcessing,
  tryBeginFeishuMessageProcessing,
} from "./processing-claims.js";

// Persistent TTL: 24 hours — survives restarts & WebSocket reconnects.
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const MEMORY_MAX_SIZE = 1_000;
const FILE_MAX_ENTRIES = 10_000;

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

function normalizeMessageId(messageId: string | undefined | null): string | null {
  const trimmed = messageId?.trim();
  return trimmed ? trimmed : null;
}

export { releaseFeishuMessageProcessing, tryBeginFeishuMessageProcessing };

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

async function hasRecordedMessagePersistent(
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
