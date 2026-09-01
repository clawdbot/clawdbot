// Gateway restart sentinel recovery resumes pending continuations and outbound delivery.
import {
  resolveCorrelatedSubagentDelivery,
  settleCorrelatedSubagentDelivery,
} from "../agents/subagents/completion/subagent-completion-delivery.js";
import { REPLY_RUN_STILL_SHUTTING_DOWN_TEXT } from "../auto-reply/reply/get-reply-run-queue.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { dispatchReplyWithBufferedBlockDispatcherCore } from "../auto-reply/reply/provider-dispatcher.js";
import type { ChatType } from "../channels/chat-type.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { recordInboundSession } from "../channels/session.js";
import { dispatchAssembledChannelTurn } from "../channels/turn/lifecycle.js";
import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSystemMainSessionTarget } from "../config/sessions.js";
import { parseSessionThreadInfo } from "../config/sessions/thread-info.js";
import { formatErrorMessage, toErrorObject } from "../infra/errors.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
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
  drainPendingSessionDelivery,
  recoverPendingSessionDeliveries,
  type SessionDeliveryRecoveryLogger,
  type SettleSessionDeliveryFn,
} from "../infra/session-delivery-queue-recovery.js";
import {
  enqueueSessionDelivery,
  markSessionDeliveryAttemptStarted,
  markSessionDeliverySettlement,
  SessionDeliveryDeadLetteredError,
  SessionDeliverySafeRetryError,
  type QueuedSessionDelivery,
  type QueuedSessionDeliveryPayload,
  type SessionDeliveryRoute,
} from "../infra/session-delivery-queue-storage.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { isPendingControlPlaneUpdateRestartSentinel } from "../infra/update-control-plane-sentinel.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { stringifyRouteThreadId } from "../plugin-sdk/channel-route.js";
import type { OutboundReplyPayload } from "../plugin-sdk/reply-payload.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { removeCronRunContinuationSessionIfIdle } from "../tasks/cron-run-continuation-cleanup.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  sessionDeliveryOrigin,
} from "../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { deliverQueuedGeneratedMediaAgentTurn } from "./server-restart-sentinel-agent-delivery.js";
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
const RESTART_CONTINUATION_BUSY_RETRY_ERROR =
  "restart continuation deferred because previous run is still shutting down";
let latestUpdateRestartSentinel: RestartSentinelPayload | null = null;

/** Settles every queue entry through its durable producer before cron cleanup. */
export const settleQueuedSessionDelivery: SettleSessionDeliveryFn = async (entry, outcome) => {
  await settleCorrelatedSubagentDelivery(entry, outcome);
  await removeCronRunContinuationSessionIfIdle(entry.sessionKey, entry.id);
};

type QueuedAgentTurnSessionDelivery = Extract<QueuedSessionDelivery, { kind: "agentTurn" }>;

function sessionDeliveryStateDirArgs(stateDir?: string): [] | [string] {
  return stateDir === undefined ? [] : [stateDir];
}

function cloneRestartSentinelPayload(
  payload: RestartSentinelPayload | null,
): RestartSentinelPayload | null {
  return payload ? structuredClone(payload) : null;
}

function hasRoutableDeliveryContext(context?: {
  channel?: string;
  to?: string;
}): context is { channel: string; to: string } {
  return Boolean(context?.channel && context?.to);
}

function enqueueRestartSentinelWake(
  message: string,
  sessionKey: string,
  agentId?: string,
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  },
) {
  const eventOptions = {
    sessionKey,
    ...(deliveryContext ? { deliveryContext } : {}),
  };
  enqueueSystemEvent(message, agentId ? withSystemEventOwner(eventOptions, agentId) : eventOptions);
  requestHeartbeat({
    source: "restart-sentinel",
    intent: "immediate",
    reason: "wake",
    ...(agentId ? { agentId } : {}),
    sessionKey,
  });
}

async function waitForRetry(delayMs: number) {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

const buildRestartContinuationMessageId = (params: {
  sessionKey: string;
  kind: RestartSentinelContinuation["kind"];
  revision: number;
}) => `restart-sentinel:${params.sessionKey}:${params.kind}:${params.revision}`;

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

function isRestartContinuationBusyPayload(payload: OutboundReplyPayload): boolean {
  return (
    typeof payload.text === "string" && payload.text.trim() === REPLY_RUN_STILL_SHUTTING_DOWN_TEXT
  );
}

function isRestartContinuationBusyRetry(entry: QueuedSessionDelivery | null): boolean {
  return entry?.lastError === RESTART_CONTINUATION_BUSY_RETRY_ERROR;
}

function resolveQueuedRestartContinuationMessageId(entry: QueuedAgentTurnSessionDelivery): string {
  if (isRestartContinuationBusyRetry(entry) && entry.retryCount > 0) {
    return `${entry.messageId}:retry:${entry.retryCount}`;
  }
  return entry.messageId;
}

function resolveQueuedSessionDeliveryContext(entry: QueuedSessionDelivery):
  | {
      channel?: string;
      to?: string;
      accountId?: string;
      threadId?: string | number;
    }
  | undefined {
  if (entry.kind === "agentTurn" && entry.route) {
    return {
      channel: entry.route.channel,
      to: entry.route.to,
      ...(entry.route.accountId ? { accountId: entry.route.accountId } : {}),
      ...(entry.route.threadId ? { threadId: entry.route.threadId } : {}),
    };
  }
  return entry.deliveryContext;
}

export async function deliverQueuedSessionDelivery(params: {
  deps: CliDeps;
  entry: QueuedSessionDelivery;
  stateDir?: string;
  resolveGatewayContext?: import("./server-methods/types.js").GatewayContextResolver;
}) {
  const queuedEntry = resolveCorrelatedSubagentDelivery(params.entry);
  const { cfg, agentId, entry, storePath, canonicalKey } = loadSessionEntry(queuedEntry.sessionKey);
  const deliveryContext = resolveQueuedSessionDeliveryContext(queuedEntry);

  if (queuedEntry.kind === "systemEvent") {
    const { agentId: systemEventAgentId, text } = queuedEntry;
    enqueueRestartSentinelWake(text, canonicalKey, systemEventAgentId, deliveryContext);
    return;
  }

  if (
    queuedEntry.expectedSessionId &&
    (!entry?.sessionId || entry.sessionId !== queuedEntry.expectedSessionId)
  ) {
    log.warn("restart continuation skipped: session changed", {
      sessionKey: canonicalKey,
      queueId: queuedEntry.id,
      expectedSessionId: queuedEntry.expectedSessionId,
      actualSessionId: entry?.sessionId ?? null,
    });
    enqueueRestartSentinelWake(queuedEntry.message, canonicalKey, undefined, deliveryContext);
    return;
  }

  if (!queuedEntry.route) {
    enqueueRestartSentinelWake(queuedEntry.message, canonicalKey, undefined, deliveryContext);
    return;
  }

  if (
    await deliverQueuedGeneratedMediaAgentTurn({
      entry: queuedEntry,
      canonicalKey,
      agentId,
      storePath,
      sessionEntry: entry,
      ...(params.stateDir !== undefined ? { stateDir: params.stateDir } : {}),
      ...(params.resolveGatewayContext
        ? { resolveGatewayContext: params.resolveGatewayContext }
        : {}),
    })
  ) {
    return;
  }
  if (queuedEntry.deliveryStartedAt !== undefined) {
    await markSessionDeliverySettlement(
      queuedEntry,
      "moved-to-failed",
      ...sessionDeliveryStateDirArgs(params.stateDir),
    );
    throw new SessionDeliveryDeadLetteredError(
      "queued agent turn dead-lettered after an interrupted unproven attempt",
    );
  }

  const route = queuedEntry.route;
  const messageId = resolveQueuedRestartContinuationMessageId(queuedEntry);
  const userMessage = queuedEntry.message.trim();
  let dispatchError: unknown;
  const ctxPayload = finalizeInboundContext(
    {
      // The per-message timestamp prefix is applied at the single LLM boundary
      // (normalizeMessagesForLlmBoundary) from each message's own timestamp, so
      // the current turn and historical turns carry identical bytes on the wire.
      // See: https://github.com/openclaw/openclaw/issues/3658
      Body: userMessage,
      BodyForAgent: userMessage,
      BodyForCommands: "",
      RawBody: userMessage,
      CommandBody: "",
      SessionKey: canonicalKey,
      AccountId: route.accountId,
      MessageSid: messageId,
      Timestamp: Date.now(),
      InputProvenance: {
        kind: "internal_system",
        sourceChannel: route.channel,
        sourceTool: "restart-sentinel",
      },
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      ChatType: route.chatType,
      CommandAuthorized: true,
      GatewayClientScopes: ["operator.admin"],
      GatewayClientCaps: [],
      ReplyToId: route.replyToId,
      OriginatingChannel: route.channel,
      OriginatingTo: route.to,
      ExplicitDeliverRoute: false,
      MessageThreadId: route.threadId,
    },
    {
      forceBodyForCommands: true,
      forceChatType: true,
    },
  );
  await dispatchAssembledChannelTurn({
    cfg,
    channel: route.channel,
    accountId: route.accountId,
    agentId,
    routeSessionKey: canonicalKey,
    storePath,
    ctxPayload,
    recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcherCore,
    replyOptions: {
      sourceReplyDeliveryMode: "message_tool_only",
    },
    // Preflight remains retryable. Ownership starts only after the agent runner
    // has durably adopted the turn and before it can execute tools or reply.
    turnAdoptionLifecycle: {
      admission: "cancel-only",
      onAdopted: () =>
        markSessionDeliveryAttemptStarted(
          queuedEntry,
          ...sessionDeliveryStateDirArgs(params.stateDir),
        ),
    },
    delivery: {
      preparePayload: (payload) => {
        if (isRestartContinuationBusyPayload(payload)) {
          throw new SessionDeliverySafeRetryError(RESTART_CONTINUATION_BUSY_RETRY_ERROR);
        }
        return payload;
      },
      durable: false,
      // Restart continuations are internal lifecycle turns. Visible follow-up
      // must go through the message tool; automatic final delivery stays off.
      deliver: async () => ({ visibleReplySent: false }),
      onError: (err, info) => {
        dispatchError ??= err;
        log.warn(`restart continuation dispatch failed during ${info.kind}: ${String(err)}`, {
          sessionKey: canonicalKey,
        });
      },
    },
    record: {
      onRecordError: (err) => {
        log.warn(`restart continuation failed to record inbound session metadata: ${String(err)}`, {
          sessionKey: canonicalKey,
        });
      },
    },
  });
  if (dispatchError) {
    throw toErrorObject(dispatchError, "Non-Error thrown");
  }
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
    idempotencyKey,
  };
}

async function drainRestartContinuationQueue(params: {
  deps: CliDeps;
  entryId: string;
  log: SessionDeliveryRecoveryLogger;
}) {
  for (let attempt = 1; attempt <= RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS; attempt += 1) {
    const queued = await drainPendingSessionDelivery({
      id: params.entryId,
      logLabel: "restart continuation",
      log: params.log,
      bypassBackoff: true,
      deliver: (entry, context = {}) =>
        deliverQueuedSessionDelivery({
          deps: params.deps,
          entry,
          ...(context.stateDir !== undefined ? { stateDir: context.stateDir } : {}),
        }),
      onSettled: settleQueuedSessionDelivery,
    });

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
  resolveGatewayContext?: import("./server-methods/types.js").GatewayContextResolver;
}) {
  await recoverPendingSessionDeliveries({
    deliver: (entry, context = {}) =>
      deliverQueuedSessionDelivery({
        deps: params.deps,
        entry,
        ...(context.stateDir !== undefined ? { stateDir: context.stateDir } : {}),
        ...(params.resolveGatewayContext
          ? { resolveGatewayContext: params.resolveGatewayContext }
          : {}),
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
          }, "restart-sentinel:wake").catch((err: unknown) => {
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
