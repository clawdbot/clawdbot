// Telegram plugin module implements telegram ingress spool behavior.
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueClaimRef,
  ChannelIngressQueueRecord,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { getTelegramRuntime } from "./runtime.js";

const SPOOL_VERSION = 1;
const TELEGRAM_INGRESS_SPOOL_PREFIX = "ingress-spool-";
export const TELEGRAM_SPOOLED_UPDATE_PROCESSING_STALE_MS = 6 * 60 * 60 * 1000;
const TELEGRAM_SPOOLED_UPDATE_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TELEGRAM_SPOOLED_UPDATE_FAILED_MAX_ENTRIES = 1000;
const TELEGRAM_SPOOLED_UPDATE_PROCESS_ID = `${process.pid}:${randomUUID()}`;

type TelegramSpooledUpdateClaimOwner = {
  processId: string;
  processPid: number;
  claimedAt: number;
  claimToken?: string;
};

type TelegramSpooledUpdatePayload = {
  version: number;
  updateId: number;
  receivedAt: number;
  update: unknown;
};

export type TelegramSpooledUpdate = {
  updateId: number;
  path: string;
  update: unknown;
  receivedAt: number;
  claim?: TelegramSpooledUpdateClaimOwner;
};

export type ClaimedTelegramSpooledUpdate = TelegramSpooledUpdate & {
  pendingPath: string;
};

function normalizeAccountId(accountId?: string) {
  const trimmed = accountId?.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}

function isValidUpdateId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function resolveTelegramIngressSpoolDir(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const stateDir = resolveStateDir(params.env, os.homedir);
  return path.join(
    stateDir,
    "telegram",
    `${TELEGRAM_INGRESS_SPOOL_PREFIX}${normalizeAccountId(params.accountId)}`,
  );
}

export function resolveTelegramUpdateId(update: unknown): number | null {
  if (!update || typeof update !== "object") {
    return null;
  }
  const value = (update as { update_id?: unknown }).update_id;
  return isValidUpdateId(value) ? value : null;
}

function spoolFileName(updateId: number): string {
  return `${String(updateId).padStart(16, "0")}.json`;
}

function processingFileName(updateId: number): string {
  return `${spoolFileName(updateId)}.processing`;
}

function queueEventId(updateId: number): string {
  return String(updateId).padStart(16, "0");
}

function pendingPath(spoolDir: string, updateId: number): string {
  return path.join(spoolDir, spoolFileName(updateId));
}

function processingPath(spoolDir: string, updateId: number): string {
  return path.join(spoolDir, processingFileName(updateId));
}

function resolveQueueParts(spoolDir: string): {
  accountId: string;
  stateDir: string;
} {
  const basename = path.basename(spoolDir);
  const accountId = normalizeAccountId(
    basename.startsWith(TELEGRAM_INGRESS_SPOOL_PREFIX)
      ? basename.slice(TELEGRAM_INGRESS_SPOOL_PREFIX.length)
      : basename,
  );
  const stateDir =
    basename.startsWith(TELEGRAM_INGRESS_SPOOL_PREFIX) &&
    path.basename(path.dirname(spoolDir)) === "telegram"
      ? path.dirname(path.dirname(spoolDir))
      : spoolDir;
  return {
    accountId,
    stateDir,
  };
}

function createTelegramIngressQueue(
  spoolDir: string,
): ChannelIngressQueue<TelegramSpooledUpdatePayload> {
  const parts = resolveQueueParts(spoolDir);
  return getTelegramRuntime().state.openChannelIngressQueue<TelegramSpooledUpdatePayload>({
    accountId: parts.accountId,
    stateDir: parts.stateDir,
  });
}

async function pruneTelegramIngressQueue(
  queue: ChannelIngressQueue<TelegramSpooledUpdatePayload>,
  now?: number,
): Promise<void> {
  await queue.prune({
    failedTtlMs: TELEGRAM_SPOOLED_UPDATE_FAILED_TTL_MS,
    failedMaxEntries: TELEGRAM_SPOOLED_UPDATE_FAILED_MAX_ENTRIES,
    ...(now === undefined ? {} : { now }),
  });
}

function processPidFromOwnerId(ownerId: string): number {
  const pid = Number.parseInt(ownerId.split(":", 1)[0] ?? "", 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : -1;
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    return code !== "ESRCH" && code !== "EINVAL";
  }
}

function isFreshClaimOwner(claim: TelegramSpooledUpdateClaimOwner): boolean {
  return Date.now() - claim.claimedAt < TELEGRAM_SPOOLED_UPDATE_PROCESSING_STALE_MS;
}

function parseQueueRecord(
  spoolDir: string,
  record: ChannelIngressQueueRecord<TelegramSpooledUpdatePayload>,
): TelegramSpooledUpdate | null {
  const payload = record.payload;
  if (payload.version !== SPOOL_VERSION || !isValidUpdateId(payload.updateId)) {
    return null;
  }
  return {
    updateId: payload.updateId,
    path: pendingPath(spoolDir, payload.updateId),
    update: payload.update,
    receivedAt: payload.receivedAt,
  };
}

function parseQueueClaim(
  spoolDir: string,
  record: ChannelIngressQueueClaim<TelegramSpooledUpdatePayload>,
): ClaimedTelegramSpooledUpdate | null {
  const update = parseQueueRecord(spoolDir, record);
  if (!update) {
    return null;
  }
  return {
    ...update,
    path: processingPath(spoolDir, update.updateId),
    pendingPath: pendingPath(spoolDir, update.updateId),
    claim: {
      processId: record.claim.ownerId,
      processPid: processPidFromOwnerId(record.claim.ownerId),
      claimedAt: record.claim.claimedAt,
      claimToken: record.claim.token,
    },
  };
}

function sortTelegramUpdates<T extends TelegramSpooledUpdate>(updates: T[]): T[] {
  return updates.toSorted((a, b) => a.updateId - b.updateId);
}

function queueMutationTarget(update: TelegramSpooledUpdate): string | ChannelIngressQueueClaimRef {
  const id = queueEventId(update.updateId);
  return update.claim?.claimToken ? { id, claim: { token: update.claim.claimToken } } : id;
}

export function isTelegramSpooledUpdateClaimOwnedByOtherLiveProcess(
  claim: ClaimedTelegramSpooledUpdate,
): boolean {
  return Boolean(
    claim.claim &&
    claim.claim.processId !== TELEGRAM_SPOOLED_UPDATE_PROCESS_ID &&
    isFreshClaimOwner(claim.claim) &&
    processExists(claim.claim.processPid),
  );
}

export async function writeTelegramSpooledUpdate(params: {
  spoolDir: string;
  update: unknown;
  now?: number;
}): Promise<number> {
  const updateId = resolveTelegramUpdateId(params.update);
  if (updateId === null) {
    throw new Error("Telegram update missing numeric update_id.");
  }
  const receivedAt = params.now ?? Date.now();
  const queue = createTelegramIngressQueue(params.spoolDir);
  await pruneTelegramIngressQueue(queue, params.now);
  await queue.enqueue(
    queueEventId(updateId),
    {
      version: SPOOL_VERSION,
      updateId,
      receivedAt,
      update: params.update,
    },
    { receivedAt },
  );
  return updateId;
}

export async function listTelegramSpooledUpdates(params: {
  spoolDir: string;
  limit?: number | "all";
}): Promise<TelegramSpooledUpdate[]> {
  const records = await createTelegramIngressQueue(params.spoolDir).listPending({
    limit: params.limit ?? 100,
    orderBy: "id",
  });
  return sortTelegramUpdates(
    records.flatMap((record) => {
      const update = parseQueueRecord(params.spoolDir, record);
      return update ? [update] : [];
    }),
  );
}

export async function deleteTelegramSpooledUpdate(update: TelegramSpooledUpdate): Promise<void> {
  await createTelegramIngressQueue(path.dirname(update.path)).delete(queueMutationTarget(update));
}

export async function claimTelegramSpooledUpdate(
  update: TelegramSpooledUpdate,
): Promise<ClaimedTelegramSpooledUpdate | null> {
  const spoolDir = path.dirname(update.path);
  const claimed = await createTelegramIngressQueue(spoolDir).claim(queueEventId(update.updateId), {
    ownerId: TELEGRAM_SPOOLED_UPDATE_PROCESS_ID,
  });
  return claimed ? parseQueueClaim(spoolDir, claimed) : null;
}

export async function releaseTelegramSpooledUpdateClaim(
  update: ClaimedTelegramSpooledUpdate,
): Promise<void> {
  await createTelegramIngressQueue(path.dirname(update.pendingPath)).release(
    queueMutationTarget(update),
  );
}

export async function failTelegramSpooledUpdateClaim(params: {
  update: ClaimedTelegramSpooledUpdate;
  reason: string;
  message: string;
  now?: number;
}): Promise<boolean> {
  const queue = createTelegramIngressQueue(path.dirname(params.update.pendingPath));
  const failed = await queue.fail(queueMutationTarget(params.update), {
    reason: params.reason,
    message: params.message,
    ...(params.now === undefined ? {} : { failedAt: params.now }),
  });
  await pruneTelegramIngressQueue(queue, params.now);
  return failed;
}

export async function listTelegramSpooledUpdateClaims(params: {
  spoolDir: string;
}): Promise<ClaimedTelegramSpooledUpdate[]> {
  const claims = await createTelegramIngressQueue(params.spoolDir).listClaims();
  return sortTelegramUpdates(
    claims.flatMap((claim) => {
      const update = parseQueueClaim(params.spoolDir, claim);
      return update ? [update] : [];
    }),
  );
}

export async function recoverStaleTelegramSpooledUpdateClaims(params: {
  spoolDir: string;
  staleMs?: number;
  now?: number;
  shouldRecover?: (claim: ClaimedTelegramSpooledUpdate) => boolean | Promise<boolean>;
}): Promise<number> {
  const shouldRecover = params.shouldRecover;
  return await createTelegramIngressQueue(params.spoolDir).recoverStaleClaims({
    staleMs: params.staleMs ?? TELEGRAM_SPOOLED_UPDATE_PROCESSING_STALE_MS,
    ...(params.now === undefined ? {} : { now: params.now }),
    ...(shouldRecover
      ? {
          shouldRecover: async (claim: ChannelIngressQueueClaim<TelegramSpooledUpdatePayload>) => {
            const update = parseQueueClaim(params.spoolDir, claim);
            return update ? await shouldRecover(update) : false;
          },
        }
      : {}),
  });
}
