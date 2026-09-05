import { sendDurableMessageBatchCore } from "../channels/message/runtime.js";
// Durable outbound notice ownership for restart-sentinel recovery.
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
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
  drainPendingDeliveriesCore,
  withActiveDeliveryClaim,
} from "../infra/outbound/delivery-queue-recovery.js";
import {
  ackDelivery,
  failDelivery,
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  failPendingDelivery,
  findDeliveryIntentOwner,
  loadPendingDelivery,
  reserveDeliveryAttempt,
} from "../infra/outbound/delivery-queue-storage.js";
import {
  createMessageSentEmitter,
  type MessageSentEvent,
} from "../infra/outbound/message-sent-hook.js";
import { acceptedPreparedOutboundEntries } from "../infra/outbound/prepared-batch.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { stringifyRouteThreadId } from "../plugin-sdk/channel-route.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";
import { withTimeout } from "../utils/with-timeout.js";

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

type GatewayLifecycleNotice = RestartSentinelNoticeRoute & {
  cfg: OpenClawConfig;
  message: string;
  sessionKey?: string;
};

/** Resolve once before an update can replace lazily loaded channel modules. */
export function resolveGatewayLifecycleNoticeRoute(params: {
  cfg: OpenClawConfig;
  deliveryContext?: DeliveryContext;
  threadId?: string;
}): RestartSentinelNoticeRoute | undefined {
  const origin = params.deliveryContext;
  const channel = origin?.channel ? normalizeChannelId(origin.channel) : null;
  if (!channel || !origin?.to) {
    return undefined;
  }
  const resolved = resolveOutboundTarget({
    cfg: params.cfg,
    channel,
    to: origin.to,
    accountId: origin.accountId,
    mode: "implicit",
  });
  if (!resolved.ok) {
    return undefined;
  }
  const threadId = params.threadId ?? stringifyRouteThreadId(origin.threadId);
  const transport = getChannelPlugin(channel)?.threading?.resolveReplyTransport?.({
    cfg: params.cfg,
    accountId: origin.accountId,
    threadId,
  });
  return {
    channel,
    to: resolved.to,
    accountId: origin.accountId,
    replyToId: transport?.replyToId ?? undefined,
    threadId:
      transport && Object.hasOwn(transport, "threadId")
        ? stringifyRouteThreadId(transport.threadId)
        : threadId,
  };
}

/** Await one durable attempt; recovery retains failed custody without delaying shutdown. */
export async function sendGatewayLifecycleNotice(
  params: GatewayLifecycleNotice & {
    deps: CliDeps;
    deliveryIntentId: string;
  },
): Promise<boolean> {
  let delivered = false;
  try {
    await withTimeout(
      (async () => {
        const queued = await enqueueGatewayLifecycleNotice(params, params.deliveryIntentId);
        if (!queued.created) {
          return;
        }
        await deliverGatewayLifecycleNoticeAttempt(
          {
            ...params,
            summary: "update.run notice",
            queueId: queued.id,
          },
          () => {
            delivered = true;
          },
        );
      })(),
      10_000,
      "update.run notice",
    );
  } catch (error) {
    log.warn(`update.run notice failed: ${formatErrorMessage(error)}`);
  }
  return delivered;
}

type RestartSentinelNoticeEnqueueResult = { id: string; created: boolean };

// Duplicate gateway startup paths share the same producer outcome. A caller
// must not report durable custody while the first producer has no queue row.
const activeRestartNoticeEnqueues = new Map<string, Promise<RestartSentinelNoticeEnqueueResult>>();

export async function enqueueRestartSentinelNotice(
  params: GatewayLifecycleNotice & {
    sessionKey: string;
    revision: number;
    deliveryIntentId?: string;
  },
): Promise<RestartSentinelNoticeEnqueueResult> {
  return await enqueueGatewayLifecycleNotice(
    params,
    params.deliveryIntentId ?? `restart-sentinel-notice:${params.sessionKey}:${params.revision}`,
  );
}

async function enqueueGatewayLifecycleNotice(
  params: GatewayLifecycleNotice,
  deliveryIntentId: string,
): Promise<RestartSentinelNoticeEnqueueResult> {
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
  params: GatewayLifecycleNotice,
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
  params: GatewayLifecycleNotice,
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
  params: GatewayLifecycleNotice & {
    deps: CliDeps;
    sessionKey: string;
    summary: string;
    queueId: string;
  },
): Promise<boolean> {
  let delivered = false;
  const claim = await deliverGatewayLifecycleNoticeAttempt(params, () => {
    delivered = true;
  });
  if (claim.status === "claimed-by-other-owner") {
    log.info(`${params.summary}: durable restart notice claimed by recovery`, {
      sessionKey: params.sessionKey,
    });
  }
  if (claim.status === "claimed-by-other-owner" || !claim.value) {
    await drainFailedRestartSentinelNotice(params);
  }
  // Only the observed platform send proves delivery; recovery owns its own receipts.
  return delivered;
}

async function deliverGatewayLifecycleNoticeAttempt(
  params: GatewayLifecycleNotice & { deps: CliDeps; summary: string; queueId: string },
  onDelivered?: () => void,
) {
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
  return await withActiveDeliveryClaim(params.queueId, async () => {
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
      const send = await sendDurableMessageBatchCore({
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
      // Capture the platform fact before queue settlement or hooks can stall.
      // A bounded caller must still report a sent acknowledgement on timeout.
      if (results.length > 0) {
        onDelivered?.();
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
}
