// Test-only queue inspection/claim wrappers over openTelegramIngressQueue.
// Prod claiming lives in the core ingress drain; transport tests use these to
// assert spool contents and drive claim states without a running drain.
import path from "node:path";
import {
  INGRESS_CLAIM_PROCESS_ID,
  processPidFromOwnerId,
  type ChannelIngressQueueClaim,
  type ChannelIngressQueueCorruptClaim,
  type ChannelIngressQueueRecord,
} from "openclaw/plugin-sdk/channel-outbound";
import type { TelegramBotInfo } from "./bot-info.js";
import {
  openTelegramIngressQueue,
  telegramSpooledUpdateLaneKey,
} from "./telegram-ingress-spool.js";
import {
  TELEGRAM_SPOOLED_UPDATE_PAYLOAD_VERSION,
  type TelegramSpooledUpdatePayload,
} from "./telegram-ingress-spool.payload.js";

type TelegramSpooledUpdateClaimOwner = {
  processId: string;
  processPid: number;
  claimedAt: number;
  claimToken?: string;
};

export type TelegramSpooledUpdate = {
  updateId: number;
  path: string;
  update: unknown;
  receivedAt: number;
  attempts?: number;
  lastAttemptAt?: number;
  lastError?: string;
  claim?: TelegramSpooledUpdateClaimOwner;
};

export type ClaimedTelegramSpooledUpdate = TelegramSpooledUpdate & {
  pendingPath: string;
};

export function telegramQueueEventId(updateId: number): string {
  return String(updateId).padStart(16, "0");
}

function spoolFileName(updateId: number): string {
  return `${telegramQueueEventId(updateId)}.json`;
}

function processingFileName(updateId: number): string {
  return `${spoolFileName(updateId)}.processing`;
}

function isValidUpdateId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parsePendingRecord(
  spoolDir: string,
  record: ChannelIngressQueueRecord<TelegramSpooledUpdatePayload>,
): TelegramSpooledUpdate | null {
  const payload = record.payload;
  if (
    payload.version !== TELEGRAM_SPOOLED_UPDATE_PAYLOAD_VERSION ||
    !isValidUpdateId(payload.updateId)
  ) {
    return null;
  }
  return {
    updateId: payload.updateId,
    path: path.join(spoolDir, spoolFileName(payload.updateId)),
    update: payload.update,
    receivedAt: payload.receivedAt,
    attempts: record.attempts,
    ...(record.lastAttemptAt === undefined ? {} : { lastAttemptAt: record.lastAttemptAt }),
    ...(record.lastError === undefined ? {} : { lastError: record.lastError }),
  };
}

function parseQueueClaim(
  spoolDir: string,
  record: ChannelIngressQueueClaim<TelegramSpooledUpdatePayload>,
): ClaimedTelegramSpooledUpdate | null {
  const update = parsePendingRecord(spoolDir, record);
  if (!update) {
    return null;
  }
  const claimRef = record.claim.token;
  return {
    ...update,
    path: path.join(spoolDir, processingFileName(update.updateId)),
    pendingPath: path.join(spoolDir, spoolFileName(update.updateId)),
    claim: {
      processId: record.claim.ownerId,
      processPid: processPidFromOwnerId(record.claim.ownerId),
      claimedAt: record.claim.claimedAt,
      claimToken: claimRef,
    },
  };
}

export async function listTelegramSpooledUpdates(params: {
  spoolDir: string;
  limit?: number | "all";
}): Promise<TelegramSpooledUpdate[]> {
  const records = await openTelegramIngressQueue(params.spoolDir).listPending({
    limit: params.limit ?? 100,
    orderBy: "id",
  });
  return records
    .flatMap((record) => {
      const update = parsePendingRecord(params.spoolDir, record);
      return update ? [update] : [];
    })
    .toSorted((a, b) => a.updateId - b.updateId);
}

export async function claimNextTelegramSpooledUpdate(params: {
  spoolDir: string;
  blockedLaneKeys?: Iterable<string>;
  botInfo?: TelegramBotInfo;
  candidateUpdateIds?: Iterable<number>;
  scanLimit?: number;
}): Promise<ClaimedTelegramSpooledUpdate | null> {
  const queue = openTelegramIngressQueue(params.spoolDir);
  const claimed = await queue.claimNext({
    ownerId: INGRESS_CLAIM_PROCESS_ID,
    blockedLaneKeys: params.blockedLaneKeys,
    ...(params.candidateUpdateIds === undefined
      ? {}
      : { candidateIds: [...params.candidateUpdateIds].map(telegramQueueEventId) }),
    orderBy: "id",
    scanLimit: params.scanLimit,
    deriveLaneKey: (record) => telegramSpooledUpdateLaneKey(record.payload.update, params.botInfo),
  });
  if (!claimed) {
    return null;
  }
  const update = parseQueueClaim(params.spoolDir, claimed);
  if (update) {
    return update;
  }
  await queue.fail(claimed, {
    reason: "invalid-spooled-update",
    message: "Telegram spooled update payload was invalid.",
  });
  return null;
}

export async function listTelegramSpooledUpdateClaims(params: {
  spoolDir: string;
}): Promise<ClaimedTelegramSpooledUpdate[]> {
  const claims = await openTelegramIngressQueue(params.spoolDir).listClaims();
  return claims
    .flatMap((claim) => {
      const update = parseQueueClaim(params.spoolDir, claim);
      return update ? [update] : [];
    })
    .toSorted((a, b) => a.updateId - b.updateId);
}

export async function recoverStaleTelegramSpooledUpdateClaims(params: {
  spoolDir: string;
  staleMs?: number;
  now?: number;
  shouldRecover?: (claim: ClaimedTelegramSpooledUpdate) => boolean | Promise<boolean>;
  shouldRecoverCorrupt?: (claim: ChannelIngressQueueCorruptClaim) => boolean | Promise<boolean>;
}): Promise<number> {
  const shouldRecover = params.shouldRecover;
  const shouldRecoverCorrupt = params.shouldRecoverCorrupt;
  return await openTelegramIngressQueue(params.spoolDir).recoverStaleClaims({
    staleMs: params.staleMs ?? 0,
    ...(params.now === undefined ? {} : { now: params.now }),
    ...(shouldRecover
      ? {
          shouldRecover: async (claim) => {
            const update = parseQueueClaim(params.spoolDir, claim);
            return update ? await shouldRecover(update) : false;
          },
        }
      : {}),
    ...(shouldRecoverCorrupt ? { shouldRecoverCorrupt } : {}),
  });
}
