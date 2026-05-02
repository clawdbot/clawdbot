import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChatType } from "../channels/chat-type.js";
import { resolveStateDir } from "../config/paths.js";
import { generateSecureUuid } from "./secure-random.js";

const QUEUE_DIRNAME = "session-delivery-queue";
const FAILED_DIRNAME = "failed";
const TMP_SWEEP_MAX_AGE_MS = 5_000;

type SessionDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

export type SessionDeliveryRoute = {
  channel: string;
  to: string;
  accountId?: string;
  replyToId?: string;
  threadId?: string;
  chatType: ChatType;
};

export type QueuedSessionDeliveryPayload =
  | {
      kind: "systemEvent";
      sessionKey: string;
      text: string;
      deliveryContext?: SessionDeliveryContext;
      idempotencyKey?: string;
    }
  | {
      kind: "agentTurn";
      sessionKey: string;
      message: string;
      messageId: string;
      route?: SessionDeliveryRoute;
      deliveryContext?: SessionDeliveryContext;
      idempotencyKey?: string;
    };

export type QueuedSessionDelivery = QueuedSessionDeliveryPayload & {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
};

function getErrnoCode(err: unknown): string | null {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code?: unknown }).code)
    : null;
}

function buildEntryId(idempotencyKey?: string): string {
  if (!idempotencyKey) {
    return generateSecureUuid();
  }
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

async function unlinkBestEffort(filePath: string): Promise<void> {
  await fs.promises.unlink(filePath).catch(() => undefined);
}

async function unlinkStaleTmpBestEffort(filePath: string, now: number): Promise<void> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      return;
    }
    if (now - stat.mtimeMs < TMP_SWEEP_MAX_AGE_MS) {
      return;
    }
    await unlinkBestEffort(filePath);
  } catch (err) {
    if (getErrnoCode(err) !== "ENOENT") {
      throw err;
    }
  }
}

async function writeQueueEntry(filePath: string, entry: QueuedSessionDelivery): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(entry, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.promises.rename(tmp, filePath);
}

async function readQueueEntry(filePath: string): Promise<QueuedSessionDelivery> {
  return JSON.parse(await fs.promises.readFile(filePath, "utf-8")) as QueuedSessionDelivery;
}

export function resolveSessionDeliveryQueueDir(stateDir?: string): string {
  const base = stateDir ?? resolveStateDir();
  return path.join(base, QUEUE_DIRNAME);
}

function resolveFailedDir(stateDir?: string): string {
  return path.join(resolveSessionDeliveryQueueDir(stateDir), FAILED_DIRNAME);
}

function resolveQueueEntryPaths(
  id: string,
  stateDir?: string,
): {
  jsonPath: string;
  deliveredPath: string;
} {
  const queueDir = resolveSessionDeliveryQueueDir(stateDir);
  return {
    jsonPath: path.join(queueDir, `${id}.json`),
    deliveredPath: path.join(queueDir, `${id}.delivered`),
  };
}

async function ensureSessionDeliveryQueueDir(stateDir?: string): Promise<string> {
  const queueDir = resolveSessionDeliveryQueueDir(stateDir);
  await fs.promises.mkdir(queueDir, { recursive: true, mode: 0o700 });
  await fs.promises.mkdir(resolveFailedDir(stateDir), { recursive: true, mode: 0o700 });
  return queueDir;
}

export async function enqueueSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  stateDir?: string,
): Promise<string> {
  const queueDir = await ensureSessionDeliveryQueueDir(stateDir);
  const id = buildEntryId(params.idempotencyKey);
  const filePath = path.join(queueDir, `${id}.json`);

  if (params.idempotencyKey) {
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.isFile()) {
        return id;
      }
    } catch (err) {
      if (getErrnoCode(err) !== "ENOENT") {
        throw err;
      }
    }
  }

  await writeQueueEntry(filePath, {
    ...params,
    id,
    enqueuedAt: Date.now(),
    retryCount: 0,
  });
  return id;
}

export async function ackSessionDelivery(id: string, stateDir?: string): Promise<void> {
  const { jsonPath, deliveredPath } = resolveQueueEntryPaths(id, stateDir);
  try {
    await fs.promises.rename(jsonPath, deliveredPath);
  } catch (err) {
    const code = getErrnoCode(err);
    if (code === "ENOENT") {
      await unlinkBestEffort(deliveredPath);
      return;
    }
    throw err;
  }
  await unlinkBestEffort(deliveredPath);
}

export async function failSessionDelivery(
  id: string,
  error: string,
  stateDir?: string,
): Promise<void> {
  const filePath = path.join(resolveSessionDeliveryQueueDir(stateDir), `${id}.json`);
  const entry = await readQueueEntry(filePath);
  entry.retryCount += 1;
  entry.lastAttemptAt = Date.now();
  entry.lastError = error;
  await writeQueueEntry(filePath, entry);
}

export async function loadPendingSessionDelivery(
  id: string,
  stateDir?: string,
): Promise<QueuedSessionDelivery | null> {
  const { jsonPath } = resolveQueueEntryPaths(id, stateDir);
  try {
    const stat = await fs.promises.stat(jsonPath);
    if (!stat.isFile()) {
      return null;
    }
    return await readQueueEntry(jsonPath);
  } catch (err) {
    if (getErrnoCode(err) === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function loadPendingSessionDeliveries(
  stateDir?: string,
): Promise<QueuedSessionDelivery[]> {
  const queueDir = resolveSessionDeliveryQueueDir(stateDir);
  let files: string[];
  try {
    files = await fs.promises.readdir(queueDir);
  } catch (err) {
    if (getErrnoCode(err) === "ENOENT") {
      return [];
    }
    throw err;
  }

  const now = Date.now();
  for (const file of files) {
    if (file.endsWith(".delivered")) {
      await unlinkBestEffort(path.join(queueDir, file));
    } else if (file.endsWith(".tmp")) {
      await unlinkStaleTmpBestEffort(path.join(queueDir, file), now);
    }
  }

  const entries: QueuedSessionDelivery[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(queueDir, file);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }
      entries.push(await readQueueEntry(filePath));
    } catch {
      continue;
    }
  }
  return entries;
}

export async function moveSessionDeliveryToFailed(id: string, stateDir?: string): Promise<void> {
  const queueDir = resolveSessionDeliveryQueueDir(stateDir);
  const failedDir = resolveFailedDir(stateDir);
  await fs.promises.mkdir(failedDir, { recursive: true, mode: 0o700 });
  await fs.promises.rename(path.join(queueDir, `${id}.json`), path.join(failedDir, `${id}.json`));
}
