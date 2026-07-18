// Telegram plugin module implements durable ingress enqueue + update_id mapping.
import os from "node:os";
import path from "node:path";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import { computeBackoff, type BackoffPolicy } from "openclaw/plugin-sdk/runtime-env";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { TelegramBotInfo } from "./bot-info.js";
import { getTelegramRuntime } from "./runtime.js";
import { getTelegramSequentialKey } from "./sequential-key.js";
import { normalizeTelegramStateAccountId } from "./state-account-id.js";
import {
  TELEGRAM_SPOOLED_UPDATE_PAYLOAD_VERSION,
  type TelegramSpooledUpdatePayload,
} from "./telegram-ingress-spool.payload.js";
const TELEGRAM_INGRESS_SPOOL_PREFIX = "ingress-spool-";
const TELEGRAM_SPOOLED_UPDATE_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TELEGRAM_SPOOLED_UPDATE_FAILED_MAX_ENTRIES = 1000;
const TELEGRAM_SPOOLED_UPDATE_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TELEGRAM_SPOOLED_UPDATE_COMPLETED_MAX_ENTRIES = 1000;
const TELEGRAM_SPOOLED_COMPLETION_RETRY_POLICY: BackoffPolicy = {
  initialMs: 250,
  maxMs: 5_000,
  factor: 2,
  jitter: 0.2,
};

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
    `${TELEGRAM_INGRESS_SPOOL_PREFIX}${normalizeTelegramStateAccountId(params.accountId)}`,
  );
}

function resolveTelegramUpdateId(update: unknown): number | null {
  if (!update || typeof update !== "object") {
    return null;
  }
  const value = (update as { update_id?: unknown }).update_id;
  return isValidUpdateId(value) ? value : null;
}

function telegramQueueEventId(updateId: number): string {
  return String(updateId).padStart(16, "0");
}

function resolveQueueParts(spoolDir: string): {
  accountId: string;
  stateDir: string;
} {
  const basename = path.basename(spoolDir);
  const accountId = normalizeTelegramStateAccountId(
    basename.startsWith(TELEGRAM_INGRESS_SPOOL_PREFIX)
      ? basename.slice(TELEGRAM_INGRESS_SPOOL_PREFIX.length)
      : basename,
  );
  const stateDir =
    basename.startsWith(TELEGRAM_INGRESS_SPOOL_PREFIX) &&
    path.basename(path.dirname(spoolDir)) === "telegram"
      ? path.dirname(path.dirname(spoolDir))
      : spoolDir;
  return { accountId, stateDir };
}

/** Open the account-scoped durable ingress queue for this spool directory. */
export function openTelegramIngressQueue(
  spoolDir: string,
): ChannelIngressQueue<TelegramSpooledUpdatePayload> {
  const parts = resolveQueueParts(spoolDir);
  return getTelegramRuntime().state.openChannelIngressQueue<TelegramSpooledUpdatePayload>({
    accountId: parts.accountId,
    stateDir: parts.stateDir,
  });
}

export function telegramSpooledUpdateLaneKey(update: unknown, botInfo?: TelegramBotInfo): string {
  return getTelegramSequentialKey({
    update: update as Parameters<typeof getTelegramSequentialKey>[0]["update"],
    ...(botInfo ? { me: botInfo } : {}),
  });
}

async function pruneTelegramIngressQueue(
  queue: ChannelIngressQueue<TelegramSpooledUpdatePayload>,
  now?: number,
): Promise<void> {
  await queue.prune({
    completedTtlMs: TELEGRAM_SPOOLED_UPDATE_COMPLETED_TTL_MS,
    completedMaxEntries: TELEGRAM_SPOOLED_UPDATE_COMPLETED_MAX_ENTRIES,
    failedTtlMs: TELEGRAM_SPOOLED_UPDATE_FAILED_TTL_MS,
    failedMaxEntries: TELEGRAM_SPOOLED_UPDATE_FAILED_MAX_ENTRIES,
    ...(now === undefined ? {} : { now }),
  });
}

/**
 * Durable-before-ack accept path: commit the update to the ingress queue.
 * Polling advances offset only after this returns; webhook returns 200 only after.
 */
export async function writeTelegramSpooledUpdate(params: {
  spoolDir: string;
  update: unknown;
  laneKey?: string;
  now?: number;
}): Promise<number> {
  const updateId = resolveTelegramUpdateId(params.update);
  if (updateId === null) {
    throw new Error("Telegram update missing numeric update_id.");
  }
  const receivedAt = params.now ?? Date.now();
  const queue = openTelegramIngressQueue(params.spoolDir);
  await pruneTelegramIngressQueue(queue, params.now);
  await queue.enqueue(
    telegramQueueEventId(updateId),
    {
      version: TELEGRAM_SPOOLED_UPDATE_PAYLOAD_VERSION,
      updateId,
      receivedAt,
      update: params.update,
    },
    {
      receivedAt,
      laneKey: params.laneKey ?? telegramSpooledUpdateLaneKey(params.update),
    },
  );
  return updateId;
}

/** Backoff for irrevocable-adoption completion retries (bot-message only). */
export function resolveSpooledUpdatePersistenceRetryDelayMs(attempt: number): number {
  return computeBackoff(TELEGRAM_SPOOLED_COMPLETION_RETRY_POLICY, attempt);
}
