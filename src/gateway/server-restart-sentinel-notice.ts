// Durable outbound notice ownership for restart-sentinel recovery.
import { sendDurableMessageBatch } from "../channels/message/runtime.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  findPlatformMessageRejectedError,
  isProvenDeliveryNotSentError,
} from "../infra/delivery-recovery.shared.js";
import { formatErrorMessage } from "../infra/errors.js";
import { OUTBOUND_DELIVERY_LOG_SCOPE } from "../infra/outbound/deliver-log.js";
import { prepareOutboundPayloadBatch } from "../infra/outbound/deliver-prepare.js";
import { stageAndEnqueueOutboundDelivery } from "../infra/outbound/deliver-queue-admission.js";
import type { OutboundDeliveryResult } from "../infra/outbound/deliver-types.js";
import { deliverOutboundPayloadsInternal } from "../infra/outbound/deliver.js";
import { runOutboundDeliveryCommitHooks } from "../infra/outbound/delivery-commit-hooks.js";
import {
  withStableDeliveryPreparation,
  type StableDeliveryPreparationOwner,
} from "../infra/outbound/delivery-queue-preparation.js";
import {
  failPendingDelivery,
  findDeliveryIntentOwner,
  loadPendingDelivery,
  reserveDeliveryAttempt,
} from "../infra/outbound/delivery-queue-storage.js";
import {
  ackDelivery,
  drainPendingDeliveriesCore,
  failDelivery,
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  withActiveDeliveryClaim,
} from "../infra/outbound/delivery-queue.js";
import {
  createMessageSentEmitter,
  type MessageSentEvent,
} from "../infra/outbound/message-sent-hook.js";
import { acceptedPreparedOutboundEntries } from "../infra/outbound/prepared-batch.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";

const log = createSubsystemLogger("gateway/restart-sentinel");
const RESTART_NOTICE_RECOVERY_DELAY_MS = process.env.VITEST ? 1 : 1_000;
const RESTART_NOTICE_MAX_ATTEMPTS = 45;
const RESTART_NOTICE_RECOVERY_MAX_CYCLES = RESTART_NOTICE_MAX_ATTEMPTS + 1;

type RestartSentinelNoticeRoute = {
  channel: string;
  to: string;
  accountId?: string;
  replyToId?: string;
  threadId?: string;
};

type RestartSentinelNoticeEnqueueResult = { id: string; created: boolean };

// Duplicate gateway startup paths share the same producer outcome. A caller
// must not report durable custody while the first producer has no queue row.
const activeRestartNoticeEnqueues = new Map<string, Promise<RestartSentinelNoticeEnqueueResult>>();

export async function enqueueRestartSentinelNotice(
  params: RestartSentinelNoticeRoute & {
    cfg: OpenClawConfig;
    message: string;
    sessionKey: string;
    revision: number;
  },
): Promise<RestartSentinelNoticeEnqueueResult> {
  const deliveryIntentId = `restart-sentinel-notice:${params.sessionKey}:${params.revision}`;
  const active = activeRestartNoticeEnqueues.get(deliveryIntentId);
  if (active) {
    await active;
    return { id: deliveryIntentId, created: false };
  }
  const enqueue = enqueueRestartSentinelNoticeOwned(params, deliveryIntentId);
  activeRestartNoticeEnqueues.set(deliveryIntentId, enqueue);
  try {
    return await enqueue;
  } finally {
    if (activeRestartNoticeEnqueues.get(deliveryIntentId) === enqueue) {
      activeRestartNoticeEnqueues.delete(deliveryIntentId);
    }
  }
}

async function enqueueRestartSentinelNoticeOwned(
  params: RestartSentinelNoticeRoute & {
    cfg: OpenClawConfig;
    message: string;
    sessionKey: string;
    revision: number;
  },
  deliveryIntentId: string,
): Promise<RestartSentinelNoticeEnqueueResult> {
  const claim = await withActiveDeliveryClaim(deliveryIntentId, async () => {
    const preparation = await withStableDeliveryPreparation({
      id: deliveryIntentId,
      run: async (owner) =>
        await enqueueRestartSentinelNoticeClaimed(params, deliveryIntentId, owner),
    });
    if (preparation.status === "claimed") {
      return preparation.value;
    }
    if (findDeliveryIntentOwner(deliveryIntentId)) {
      return { id: deliveryIntentId, created: false };
    }
    throw new Error(`Restart sentinel notice has an active producer without durable custody`);
  });
  if (claim.status === "claimed") {
    return claim.value;
  }
  if (findDeliveryIntentOwner(deliveryIntentId)) {
    return { id: deliveryIntentId, created: false };
  }
  throw new Error(`Restart sentinel notice has an active producer without durable custody`);
}

async function enqueueRestartSentinelNoticeClaimed(
  params: RestartSentinelNoticeRoute & {
    cfg: OpenClawConfig;
    message: string;
    sessionKey: string;
    revision: number;
  },
  deliveryIntentId: string,
  preparationOwner: StableDeliveryPreparationOwner,
): Promise<RestartSentinelNoticeEnqueueResult> {
  const delivery = {
    cfg: params.cfg,
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    replyToId: params.replyToId,
    threadId: params.threadId,
    payloads: [{ text: params.message }],
    session: buildOutboundSessionContext({ cfg: params.cfg, sessionKey: params.sessionKey }),
    bestEffort: false,
    queuePolicy: "required" as const,
    completionRetention: "permanent" as const,
    maxRetries: RESTART_NOTICE_MAX_ATTEMPTS,
    deliveryIntentId,
  };
  const preparedBatch = await prepareOutboundPayloadBatch(delivery, {
    onBeforeFirstModifier: preparationOwner.beforeFirstModifier,
  });
  preparationOwner.markPrepared();
  const queued = await stageAndEnqueueOutboundDelivery(delivery, preparedBatch, {
    getStablePreparation: preparationOwner.current,
  });
  if (!queued?.created) {
    throw new Error("Restart sentinel notice could not acquire durable queue custody");
  }
  preparationOwner.markPublished();
  return queued;
}

async function waitForRecoveryDrain(): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, RESTART_NOTICE_RECOVERY_DELAY_MS);
    timer.unref?.();
  });
}

async function drainFailedRestartSentinelNotice(params: {
  cfg: OpenClawConfig;
  queueId: string;
  sessionKey: string;
  summary: string;
}): Promise<void> {
  for (let cycle = 1; cycle <= RESTART_NOTICE_RECOVERY_MAX_CYCLES; cycle += 1) {
    const beforeDrain = await loadPendingDelivery(params.queueId).catch((error: unknown) => {
      log.warn(`${params.summary}: restart notice recovery reload failed: ${String(error)}`, {
        queueId: params.queueId,
        sessionKey: params.sessionKey,
        cycle,
      });
      return undefined;
    });
    if (beforeDrain === null) {
      return;
    }
    const attemptCount = beforeDrain
      ? Math.max(beforeDrain.attemptCount ?? 0, beforeDrain.retryCount)
      : 0;
    // Atomic queue reservation blocks attempt 46. Exhausted rows get an
    // immediate terminal drain; live retry attempts retain one-second spacing.
    if (attemptCount < RESTART_NOTICE_MAX_ATTEMPTS) {
      await waitForRecoveryDrain();
    }
    await drainPendingDeliveriesCore({
      drainKey: `restart-recovery:${params.queueId}`,
      logLabel: `${params.summary}: restart notice recovery`,
      cfg: params.cfg,
      log,
      deliver: deliverOutboundPayloadsInternal,
      selectEntry: (entry) => ({
        match: entry.id === params.queueId,
        // The caller already waits between attempts. Recovery still reconciles
        // send-attempt evidence before it permits recipient-visible replay.
        bypassBackoff: true,
      }),
    }).catch((error: unknown) => {
      log.warn(`${params.summary}: restart notice recovery drain failed: ${String(error)}`, {
        queueId: params.queueId,
        sessionKey: params.sessionKey,
        cycle,
      });
    });
  }
  const pending = await loadPendingDelivery(params.queueId).catch((error: unknown) => {
    log.warn(`${params.summary}: restart notice terminal reload failed: ${String(error)}`, {
      queueId: params.queueId,
      sessionKey: params.sessionKey,
    });
    return undefined;
  });
  if (pending === null) {
    return;
  }
  log.warn(`${params.summary}: restart notice remains queued after bounded recovery`, {
    queueId: params.queueId,
    sessionKey: params.sessionKey,
    retryCount: pending?.retryCount ?? null,
    attemptCount: pending?.attemptCount ?? null,
    maxAttempts: RESTART_NOTICE_MAX_ATTEMPTS,
  });
}

export async function deliverRestartSentinelNotice(
  params: RestartSentinelNoticeRoute & {
    deps: CliDeps;
    cfg: OpenClawConfig;
    sessionKey: string;
    summary: string;
    message: string;
    queueId: string;
  },
): Promise<void> {
  const messageSentEvents: MessageSentEvent[] = [];
  const flushTerminalObservers = async (
    results: readonly OutboundDeliveryResult[],
    runId?: string,
  ): Promise<void> => {
    const { emitMessageSent } = createMessageSentEmitter({
      hookRunner: getGlobalHookRunner(),
      channel: params.channel,
      to: params.to,
      accountId: params.accountId,
      sessionKeyForInternalHooks: params.sessionKey,
      runId,
      logPrefix: OUTBOUND_DELIVERY_LOG_SCOPE,
    });
    for (const event of messageSentEvents) {
      emitMessageSent(event);
    }
    messageSentEvents.length = 0;
    if (results.length > 0) {
      await runOutboundDeliveryCommitHooks(results);
    }
  };
  const claim = await withActiveDeliveryClaim(params.queueId, async () => {
    try {
      const reservation = await reserveDeliveryAttempt(params.queueId, RESTART_NOTICE_MAX_ATTEMPTS);
      if (reservation.status === "exhausted") {
        return false;
      }
    } catch (err) {
      log.warn(
        `${params.summary}: outbound delivery attempt reservation failed; queued for recovery: ${formatErrorMessage(err)}`,
        {
          channel: params.channel,
          to: params.to,
          sessionKey: params.sessionKey,
        },
      );
      return false;
    }
    try {
      const pending = await loadPendingDelivery(params.queueId);
      if (!pending) {
        return true;
      }
      const session = buildOutboundSessionContext({
        cfg: params.cfg,
        sessionKey: params.sessionKey,
      });
      const send = await sendDurableMessageBatch({
        cfg: params.cfg,
        channel: params.channel,
        to: params.to,
        accountId: params.accountId,
        replyToId: params.replyToId,
        threadId: params.threadId,
        payloads: acceptedPreparedOutboundEntries(pending.preparedBatch).map(
          (entry) => entry.payload,
        ),
        preparedBatch: pending.preparedBatch,
        session,
        deps: params.deps,
        bestEffort: false,
        skipQueue: true,
        deliveryQueueId: params.queueId,
        deferCommitHooks: true,
        onMessageSentEvent: (event) => messageSentEvents.push(event),
      });
      if (send.status === "failed" || send.status === "partial_failed") {
        throw send.error;
      }
      const results = send.status === "sent" ? send.results : [];
      if (send.status === "sent" && results.length === 0) {
        throw new Error("outbound delivery returned no results");
      }
      try {
        await ackDelivery(params.queueId);
        await flushTerminalObservers(results, pending.preparedBatch.runId);
        return true;
      } catch (err) {
        const error = formatErrorMessage(err);
        await (results.length > 0 ? failDeliveryAfterPlatformSend : failDelivery)(
          params.queueId,
          error,
        ).catch(() => undefined);
        log.warn(`${params.summary}: outbound delivery ack failed; queued for recovery: ${error}`, {
          channel: params.channel,
          to: params.to,
          sessionKey: params.sessionKey,
        });
        return false;
      }
    } catch (err) {
      // The send path records platform-attempt evidence on this queue row.
      // Durable recovery owns retries so ambiguous outcomes are reconciled
      // before another recipient-visible send can begin.
      const error = formatErrorMessage(err);
      const permanentRejection = findPlatformMessageRejectedError(err);
      if (permanentRejection) {
        try {
          const pending = await loadPendingDelivery(params.queueId);
          if (pending) {
            const settled = await failPendingDelivery({
              id: params.queueId,
              expectedStatus: "pending",
              lastError: error,
              entry: pending,
            });
            if (settled.status === "failed") {
              await flushTerminalObservers([], pending.preparedBatch.runId);
            }
          }
        } catch (persistError) {
          log.warn(
            `${params.summary}: permanent rejection persistence failed; queued for recovery: ${formatErrorMessage(persistError)}`,
            {
              channel: params.channel,
              to: params.to,
              sessionKey: params.sessionKey,
            },
          );
          return false;
        }
        log.warn(`${params.summary}: outbound delivery permanently rejected: ${error}`, {
          channel: params.channel,
          to: params.to,
          sessionKey: params.sessionKey,
        });
        return true;
      }
      const recordFailure = isProvenDeliveryNotSentError(err)
        ? failDeliveryBeforePlatformSend
        : failDelivery;
      await recordFailure(params.queueId, error).catch(() => undefined);
      log.warn(`${params.summary}: outbound delivery failed; queued for recovery: ${String(err)}`, {
        channel: params.channel,
        to: params.to,
        sessionKey: params.sessionKey,
      });
      return false;
    }
  });
  if (claim.status === "claimed-by-other-owner") {
    log.info(`${params.summary}: durable restart notice claimed by recovery`, {
      sessionKey: params.sessionKey,
    });
  }
  const needsRecovery =
    claim.status === "claimed-by-other-owner" || (claim.status === "claimed" && !claim.value);
  if (needsRecovery) {
    await drainFailedRestartSentinelNotice({
      cfg: params.cfg,
      queueId: params.queueId,
      sessionKey: params.sessionKey,
      summary: params.summary,
    });
  }
}
