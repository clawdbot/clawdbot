// Gateway restart sentinel recovery.
// Resumes pending restart continuations and outbound delivery after process restart.

import { settleCorrelatedSubagentDelivery } from "../agents/subagents/completion/subagent-completion-delivery.js";
import type { ChatType } from "../channels/chat-type.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSystemMainSessionTarget } from "../config/sessions.js";
import { parseSessionThreadInfo } from "../config/sessions/thread-info.js";
import { formatErrorMessage } from "../infra/errors.js";
import { requestHeartbeatRaw as requestHeartbeat } from "../infra/heartbeat-wake.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import {
  clearRestartSentinelIfRevision,
  finalizeUpdateRestartSentinelRunningVersion,
  formatRestartSentinelMessage,
  readRestartSentinel,
  type RestartSentinelContinuation,
  type RestartSentinelPayload,
  summarizeRestartSentinel,
} from "../infra/restart-sentinel.js";
import {
  drainPendingSessionDeliveries,
  recoverPendingSessionDeliveries,
  type SessionDeliveryRecoveryLogger,
  type SettleSessionDeliveryFn,
} from "../infra/session-delivery-queue-recovery.js";
import {
  enqueueSessionDelivery,
  loadPendingSessionDelivery,
  type QueuedSessionDelivery,
  type QueuedSessionDeliveryPayload,
  type SessionDeliveryRoute,
} from "../infra/session-delivery-queue-storage.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../infra/system-events.js";
import { isPendingControlPlaneUpdateRestartSentinel } from "../infra/update-control-plane-sentinel.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { stringifyRouteThreadId } from "../plugin-sdk/channel-route.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { removeCronRunContinuationSessionIfIdle } from "../tasks/cron-run-continuation-cleanup.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  sessionDeliveryOrigin,
} from "../utils/delivery-context.shared.js";
import {
  deliverQueuedSessionDeliveryCore,
  isRestartContinuationBusyRetry,
} from "./server-restart-sentinel-delivery.js";
import {
  deliverRestartSentinelNotice,
  enqueueRestartSentinelNotice,
} from "./server-restart-sentinel-notice.js";
import { loadSessionEntry } from "./session-utils.js";
import { runStartupTasks, type StartupTask } from "./startup-tasks.js";

const log = createSubsystemLogger("gateway/restart-sentinel");
const RESTART_CONTINUATION_BUSY_RETRY_DELAY_MS = process.env.VITEST ? 1 : 6_000;
const RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS = 20;
const CONTROL_PLANE_UPDATE_PENDING_RETRY_DELAY_MS = process.env.VITEST ? 1 : 2_000;
const CONTROL_PLANE_UPDATE_PENDING_MAX_ATTEMPTS = 900;
let latestUpdateRestartSentinel: RestartSentinelPayload | null = null;

export async function deliverQueuedSessionDelivery(params: {
  deps: CliDeps;
  entry: QueuedSessionDelivery;
  stateDir?: string;
}) {
  const entry = params.entry;
  // Only owner-tagged targetless wakes bypass the fork delivery owner. Session-bound or
  // managed rows stay on the claim-validating path so restart cannot widen their authority.
  if (
    entry.kind !== "systemEvent" ||
    !entry.agentId ||
    entry.expectedSessionId ||
    entry.managedDelegateArtifactDelivery
  ) {
    return deliverQueuedSessionDeliveryCore(params);
  }

  const { canonicalKey } = loadSessionEntry(entry.sessionKey);
  const eventOptions = {
    sessionKey: canonicalKey,
    trusted: true,
    ...(entry.awaitPromptAdoption ? { sessionDeliveryAwaitsTurnAdoption: true } : {}),
    ...(entry.deliveryContext ? { deliveryContext: entry.deliveryContext } : {}),
    ...(entry.traceparent ? { traceparent: entry.traceparent } : {}),
    sessionDeliveryAckId: entry.id,
    ...(params.stateDir ? { sessionDeliveryAckStateDir: params.stateDir } : {}),
  };
  enqueueSystemEvent(entry.text, withSystemEventOwner(eventOptions, entry.agentId));
  requestHeartbeat({
    source: "restart-sentinel",
    intent: "immediate",
    reason: "wake",
    agentId: entry.agentId,
    sessionKey: canonicalKey,
  });
}

/** Settles every queue entry through its durable producer before cron cleanup. */
export const settleQueuedSessionDelivery: SettleSessionDeliveryFn = async (entry, outcome) => {
  await settleCorrelatedSubagentDelivery(entry, outcome);
  await removeCronRunContinuationSessionIfIdle(entry.sessionKey, entry.id);
};

function cloneRestartSentinelPayload(
  payload: RestartSentinelPayload | null,
): RestartSentinelPayload | null {
  if (!payload) {
    return null;
  }
  return structuredClone(payload);
}

function hasRoutableDeliveryContext(context?: {
  channel?: string;
  to?: string;
}): context is { channel: string; to: string } {
  return Boolean(context?.channel && context?.to);
}

async function waitForRetry(delayMs: number) {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

function buildRestartContinuationMessageId(params: {
  sessionKey: string;
  kind: RestartSentinelContinuation["kind"];
  revision: number;
}) {
  return `restart-sentinel:${params.sessionKey}:${params.kind}:${params.revision}`;
}

function resolveRestartContinuationRoute(params: {
  channel?: string;
  to?: string;
  accountId?: string;
  replyToId?: string;
  threadId?: string;
  chatType: ChatType;
}): SessionDeliveryRoute | undefined {
  if (!params.channel || !params.to) {
    return undefined;
  }
  return {
    channel: params.channel,
    to: params.to,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    ...(params.threadId ? { threadId: params.threadId } : {}),
    chatType: params.chatType,
  };
}

function buildQueuedRestartContinuation(params: {
  sessionKey: string;
  agentId?: string;
  continuation: RestartSentinelContinuation;
  route?: SessionDeliveryRoute;
  expectedSessionId?: string | undefined;
  revision: number;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  idempotencyKey?: string;
}): QueuedSessionDeliveryPayload {
  const idempotencyKey =
    params.idempotencyKey ??
    buildRestartContinuationMessageId({
      sessionKey: params.sessionKey,
      kind: params.continuation.kind,
      revision: params.revision,
    });
  if (params.continuation.kind === "systemEvent") {
    return {
      kind: "systemEvent",
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      text: params.continuation.text,
      ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
      ...(params.continuation.traceparent ? { traceparent: params.continuation.traceparent } : {}),
      idempotencyKey,
      maxRetries: RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS,
      completionRetention: "permanent",
    };
  }
  return {
    kind: "agentTurn",
    sessionKey: params.sessionKey,
    message: params.continuation.message,
    messageId: idempotencyKey,
    ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
    maxRetries: RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS,
    completionRetention: "permanent",
    ...(params.route ? { route: params.route } : {}),
    ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
    ...(params.continuation.traceparent ? { traceparent: params.continuation.traceparent } : {}),
    idempotencyKey,
  };
}

async function drainRestartContinuationQueue(params: {
  deps: CliDeps;
  entryId: string;
  log: SessionDeliveryRecoveryLogger;
}) {
  for (let attempt = 1; attempt <= RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS; attempt += 1) {
    await drainPendingSessionDeliveries({
      drainKey: `restart-continuation:${params.entryId}`,
      logLabel: "restart continuation",
      log: params.log,
      deliver: (entry, context = {}) =>
        deliverQueuedSessionDelivery({
          deps: params.deps,
          entry,
          ...(context.stateDir !== undefined ? { stateDir: context.stateDir } : {}),
        }),
      onSettled: settleQueuedSessionDelivery,
      selectEntry: (entry) => ({
        match: entry.id === params.entryId,
        bypassBackoff: true,
      }),
    });

    const queued = await loadPendingSessionDelivery(params.entryId);
    if (!isRestartContinuationBusyRetry(queued)) {
      return;
    }
    if (attempt >= RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS) {
      return;
    }
    params.log.info(
      `restart continuation: entry ${params.entryId} still waiting for the previous run to clear; retrying in ${RESTART_CONTINUATION_BUSY_RETRY_DELAY_MS}ms`,
    );
    await waitForRetry(RESTART_CONTINUATION_BUSY_RETRY_DELAY_MS);
  }
}

export async function recoverPendingRestartContinuationDeliveries(params: {
  deps: CliDeps;
  log?: SessionDeliveryRecoveryLogger;
  maxEnqueuedAt?: number;
}) {
  await recoverPendingSessionDeliveries({
    deliver: (entry, context = {}) =>
      deliverQueuedSessionDelivery({
        deps: params.deps,
        entry,
        ...(context.stateDir !== undefined ? { stateDir: context.stateDir } : {}),
      }),
    log: params.log ?? log,
    maxEnqueuedAt: params.maxEnqueuedAt,
    onSettled: settleQueuedSessionDelivery,
  });
}

async function loadRestartSentinelStartupTask(params: {
  deps: CliDeps;
  attempt?: number;
}): Promise<StartupTask | null> {
  const sentinel = await readRestartSentinel();
  if (!sentinel) {
    return null;
  }
  const payload = sentinel.payload;
  const sentinelRevision = sentinel.revision;
  if (payload.kind === "update") {
    recordLatestUpdateRestartSentinel(payload);
  }
  const sessionKey = payload.sessionKey?.trim();
  const message = formatRestartSentinelMessage(payload);
  const summary = summarizeRestartSentinel(payload);
  const wakeDeliveryContext = mergeDeliveryContext(
    payload.threadId != null
      ? { ...payload.deliveryContext, threadId: payload.threadId }
      : payload.deliveryContext,
    undefined,
  );

  const run = async () => {
    if (isPendingControlPlaneUpdateRestartSentinel(payload)) {
      const attempt = params.attempt ?? 0;
      if (attempt < CONTROL_PLANE_UPDATE_PENDING_MAX_ATTEMPTS) {
        const timer = setTimeout(() => {
          void runWithGatewayIndependentRootWorkAdmission(async () => {
            await scheduleRestartSentinelWakeAttempt({
              deps: params.deps,
              attempt: attempt + 1,
            });
          }).catch((err: unknown) => {
            log.warn(`restart sentinel pending update retry failed: ${formatErrorMessage(err)}`);
          });
        }, CONTROL_PLANE_UPDATE_PENDING_RETRY_DELAY_MS);
        timer.unref?.();
        return { status: "skipped" as const, reason: "update-restart-pending" };
      }
      log.warn(`${summary}: update restart sentinel remained pending after retry window`, {
        sessionKey,
        reason: payload.stats?.reason ?? null,
      });
    }

    if (!sessionKey) {
      const controlPlaneOnlyConfigRestart =
        (payload.kind === "config-patch" || payload.kind === "config-apply") &&
        (typeof payload.message !== "string" || payload.message.trim().length === 0) &&
        !payload.continuation &&
        !payload.deliveryContext &&
        payload.threadId == null;
      if (controlPlaneOnlyConfigRestart) {
        // A targetless config acknowledgement has no agent turn to resume.
        // Synthesizing a main-session wake races real restart recovery and spends a model turn.
        const consumed = await clearRestartSentinelIfRevision(sentinelRevision);
        if (!consumed) {
          log.info(`${summary}: newer restart sentinel preserved while consuming config restart`);
        }
        return { status: "ran" as const };
      }
      const systemTarget = resolveSystemMainSessionTarget(getRuntimeConfig());
      const mainSessionKey = systemTarget.sessionKey;
      const wakeQueueId = await enqueueSessionDelivery(
        buildQueuedRestartContinuation({
          sessionKey: mainSessionKey,
          agentId: systemTarget.agentId,
          continuation: { kind: "systemEvent", text: message },
          revision: sentinelRevision,
          idempotencyKey: `restart-sentinel-wake:${mainSessionKey}:${sentinelRevision}`,
        }),
      );
      if (payload.continuation) {
        log.warn(`${summary}: continuation skipped: restart sentinel sessionKey unavailable`, {
          sessionKey: mainSessionKey,
          continuationKind: payload.continuation.kind,
        });
      }
      const consumed = await clearRestartSentinelIfRevision(sentinelRevision);
      if (!consumed) {
        log.info(`${summary}: newer restart sentinel preserved while draining durable wake`);
      }
      await drainRestartContinuationQueue({ deps: params.deps, entryId: wakeQueueId, log });
      return { status: "ran" as const };
    }

    const { baseSessionKey, threadId: sessionThreadId } = parseSessionThreadInfo(sessionKey);

    const { cfg, entry, canonicalKey } = loadSessionEntry(sessionKey);

    const sentinelContext = payload.deliveryContext;
    let sessionDeliveryContext = deliveryContextFromSession(entry);
    let chatType = sessionDeliveryOrigin(entry)?.chatType ?? "direct";
    if (
      !hasRoutableDeliveryContext(sessionDeliveryContext) &&
      baseSessionKey &&
      baseSessionKey !== sessionKey
    ) {
      const { entry: baseEntry } = loadSessionEntry(baseSessionKey);
      chatType =
        sessionDeliveryOrigin(entry)?.chatType ??
        sessionDeliveryOrigin(baseEntry)?.chatType ??
        "direct";
      sessionDeliveryContext = mergeDeliveryContext(
        sessionDeliveryContext,
        deliveryContextFromSession(baseEntry),
      );
    }

    const origin = mergeDeliveryContext(sentinelContext, sessionDeliveryContext);

    const channelRaw = origin?.channel;
    const channel = channelRaw ? normalizeChannelId(channelRaw) : null;
    const to = origin?.to;
    const threadId =
      payload.threadId ??
      sessionThreadId ??
      (origin?.threadId != null ? stringifyRouteThreadId(origin.threadId) : undefined);
    let resolvedTo: string | undefined;
    let replyToId: string | undefined;
    let resolvedThreadId = threadId;
    let continuationQueueId: string | undefined;
    let wakeQueueId: string | undefined;
    let noticeQueueId: string | undefined;
    let noticeQueueCreated = false;
    let continuationRoute: SessionDeliveryRoute | undefined;

    if (channel && to) {
      const resolved = resolveOutboundTarget({
        channel,
        to,
        cfg,
        accountId: origin?.accountId,
        mode: "implicit",
      });
      if (resolved.ok) {
        resolvedTo = resolved.to;
        const replyTransport =
          getChannelPlugin(channel)?.threading?.resolveReplyTransport?.({
            cfg,
            accountId: origin?.accountId,
            threadId,
          }) ?? null;
        replyToId = replyTransport?.replyToId ?? undefined;
        resolvedThreadId =
          replyTransport && Object.hasOwn(replyTransport, "threadId")
            ? replyTransport.threadId != null
              ? stringifyRouteThreadId(replyTransport.threadId)
              : undefined
            : threadId;
      }
    }

    if (payload.continuation) {
      continuationRoute = resolveRestartContinuationRoute({
        channel: channel ?? undefined,
        to: resolvedTo,
        accountId: origin?.accountId,
        replyToId,
        threadId: resolvedThreadId,
        chatType,
      });
    }

    const routedAgentTurnContinuation =
      payload.continuation?.kind === "agentTurn" && continuationRoute !== undefined;
    if (!routedAgentTurnContinuation) {
      wakeQueueId = await enqueueSessionDelivery(
        buildQueuedRestartContinuation({
          sessionKey: canonicalKey,
          continuation: { kind: "systemEvent", text: message },
          revision: sentinelRevision,
          deliveryContext: wakeDeliveryContext,
          idempotencyKey: `restart-sentinel-wake:${canonicalKey}:${sentinelRevision}`,
        }),
      );
    }

    if (payload.continuation) {
      continuationQueueId = await enqueueSessionDelivery(
        buildQueuedRestartContinuation({
          sessionKey: canonicalKey,
          continuation: payload.continuation,
          revision: sentinelRevision,
          route: continuationRoute,
          expectedSessionId: entry?.sessionId,
          deliveryContext:
            resolvedTo && channel
              ? {
                  channel,
                  to: resolvedTo,
                  ...(origin?.accountId ? { accountId: origin.accountId } : {}),
                  ...(resolvedThreadId ? { threadId: resolvedThreadId } : {}),
                }
              : wakeDeliveryContext,
        }),
      );
    }

    if (resolvedTo && channel) {
      const queuedNotice = await enqueueRestartSentinelNotice({
        cfg,
        channel,
        to: resolvedTo,
        accountId: origin?.accountId,
        replyToId,
        threadId: resolvedThreadId,
        message,
        sessionKey: canonicalKey,
        revision: sentinelRevision,
      });
      noticeQueueId = queuedNotice.id;
      noticeQueueCreated = queuedNotice.created;
    }

    // Every downstream intent is durable before consuming the singleton. A
    // failed or stale compare-delete cannot lose work or remove a newer row.
    const consumed = await clearRestartSentinelIfRevision(sentinelRevision);
    if (!consumed) {
      log.info(`${summary}: newer restart sentinel preserved while draining durable work`, {
        sessionKey: canonicalKey,
      });
    }

    if (wakeQueueId) {
      await drainRestartContinuationQueue({ deps: params.deps, entryId: wakeQueueId, log });
    }

    if (resolvedTo && channel && noticeQueueId && noticeQueueCreated) {
      await deliverRestartSentinelNotice({
        deps: params.deps,
        cfg,
        sessionKey: canonicalKey,
        summary,
        message,
        channel,
        to: resolvedTo,
        accountId: origin?.accountId,
        replyToId,
        threadId: resolvedThreadId,
        queueId: noticeQueueId,
      });
    } else if (noticeQueueId && !noticeQueueCreated) {
      log.info(`${summary}: durable restart notice already owned`, {
        sessionKey: canonicalKey,
      });
    }

    if (continuationQueueId) {
      await drainRestartContinuationQueue({
        deps: params.deps,
        entryId: continuationQueueId,
        log,
      });
    }

    return { status: "ran" as const };
  };

  return {
    source: "restart-sentinel",
    ...(sessionKey ? { sessionKey } : {}),
    run,
  };
}

async function scheduleRestartSentinelWakeAttempt(params: { deps: CliDeps; attempt: number }) {
  const task = await loadRestartSentinelStartupTask(params);
  if (!task) {
    return;
  }
  await runStartupTasks({ tasks: [task], log });
}

export async function scheduleRestartSentinelWake(params: { deps: CliDeps }) {
  await scheduleRestartSentinelWakeAttempt({ ...params, attempt: 0 });
}

export async function refreshLatestUpdateRestartSentinel(): Promise<RestartSentinelPayload | null> {
  const current = await readRestartSentinel();
  if (
    current?.payload.kind === "update" &&
    isPendingControlPlaneUpdateRestartSentinel(current.payload)
  ) {
    latestUpdateRestartSentinel = cloneRestartSentinelPayload(current.payload);
    return cloneRestartSentinelPayload(latestUpdateRestartSentinel);
  }
  const finalized = await finalizeUpdateRestartSentinelRunningVersion();
  const sentinel = finalized ?? current;
  if (sentinel?.payload.kind === "update") {
    latestUpdateRestartSentinel = cloneRestartSentinelPayload(sentinel.payload);
  }
  return cloneRestartSentinelPayload(latestUpdateRestartSentinel);
}

export function getLatestUpdateRestartSentinel(): RestartSentinelPayload | null {
  return cloneRestartSentinelPayload(latestUpdateRestartSentinel);
}

export function recordLatestUpdateRestartSentinel(payload: RestartSentinelPayload): void {
  latestUpdateRestartSentinel = cloneRestartSentinelPayload(payload);
}
