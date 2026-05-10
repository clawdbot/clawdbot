import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { REPLY_RUN_STILL_SHUTTING_DOWN_TEXT } from "../auto-reply/reply/get-reply-run-queue.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import type { ChatType } from "../channels/chat-type.js";
import { sendDurableMessageBatch } from "../channels/message/runtime.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { recordInboundSession } from "../channels/session.js";
import { dispatchAssembledChannelTurn } from "../channels/turn/kernel.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { parseSessionThreadInfo } from "../config/sessions/thread-info.js";
import { formatErrorMessage } from "../infra/errors.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { ackDelivery, enqueueDelivery, failDelivery } from "../infra/outbound/delivery-queue.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import {
  finalizeUpdateRestartSentinelRunningVersion,
  formatRestartSentinelMessage,
  readRestartSentinel,
  removeRestartSentinelFile,
  type RestartSentinelContinuation,
  type RestartSentinelPayload,
  resolveRestartSentinelPath,
  summarizeRestartSentinel,
} from "../infra/restart-sentinel.js";
import {
  drainPendingSessionDeliveries,
  enqueueSessionDelivery,
  loadPendingSessionDelivery,
  recoverPendingSessionDeliveries,
  type QueuedSessionDelivery,
  type QueuedSessionDeliveryPayload,
  type SessionDeliveryRecoveryLogger,
  type SessionDeliveryRoute,
} from "../infra/session-delivery-queue.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { stringifyRouteThreadId } from "../plugin-sdk/channel-route.js";
import type { OutboundReplyPayload } from "../plugin-sdk/reply-payload.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
} from "../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { injectTimestamp, timestampOptsFromConfig } from "./server-methods/agent-timestamp.js";
import { loadSessionEntry } from "./session-utils.js";
import { runStartupTasks, type StartupTask } from "./startup-tasks.js";

const log = createSubsystemLogger("gateway/restart-sentinel");
const OUTBOUND_RETRY_DELAY_MS = 1_000;
const OUTBOUND_MAX_ATTEMPTS = 45;
const RESTART_CONTINUATION_BUSY_RETRY_DELAY_MS = process.env.VITEST ? 1 : 6_000;
const RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS = 20;
const RESTART_CONTINUATION_BUSY_RETRY_ERROR =
  "restart continuation deferred because previous run is still shutting down";
let latestUpdateRestartSentinel: RestartSentinelPayload | null = null;

type QueuedAgentTurnSessionDelivery = Extract<QueuedSessionDelivery, { kind: "agentTurn" }>;

function cloneRestartSentinelPayload(
  payload: RestartSentinelPayload | null,
): RestartSentinelPayload | null {
  if (!payload) {
    return null;
  }
  return JSON.parse(JSON.stringify(payload)) as RestartSentinelPayload;
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
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  },
) {
  enqueueSystemEvent(message, {
    sessionKey,
    ...(deliveryContext ? { deliveryContext } : {}),
  });
  requestHeartbeat({ source: "restart-sentinel", intent: "immediate", reason: "wake", sessionKey });
}

async function waitForOutboundRetry(delayMs: number) {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

async function deliverRestartSentinelNotice(params: {
  deps: CliDeps;
  cfg: ReturnType<typeof loadSessionEntry>["cfg"];
  sessionKey: string;
  summary: string;
  message: string;
  channel: string;
  to: string;
  accountId?: string;
  replyToId?: string;
  threadId?: string;
  session: ReturnType<typeof buildOutboundSessionContext>;
}) {
  const payloads = [{ text: params.message }];
  const queueId = await enqueueDelivery({
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    replyToId: params.replyToId,
    threadId: params.threadId,
    payloads,
    bestEffort: false,
  }).catch(() => null);
  for (let attempt = 1; attempt <= OUTBOUND_MAX_ATTEMPTS; attempt += 1) {
    try {
      const send = await sendDurableMessageBatch({
        cfg: params.cfg,
        channel: params.channel,
        to: params.to,
        accountId: params.accountId,
        replyToId: params.replyToId,
        threadId: params.threadId,
        payloads,
        session: params.session,
        deps: params.deps,
        bestEffort: false,
        skipQueue: true,
      });
      if (send.status === "failed" || send.status === "partial_failed") {
        throw send.error;
      }
      const results = send.status === "sent" ? send.results : [];
      if (results.length > 0) {
        if (queueId) {
          await ackDelivery(queueId).catch(() => {});
        }
        return;
      }
      throw new Error("outbound delivery returned no results");
    } catch (err) {
      const retrying = attempt < OUTBOUND_MAX_ATTEMPTS;
      const suffix = retrying ? `; retrying in ${OUTBOUND_RETRY_DELAY_MS}ms` : "";
      log.warn(`${params.summary}: outbound delivery failed${suffix}: ${String(err)}`, {
        channel: params.channel,
        to: params.to,
        sessionKey: params.sessionKey,
        attempt,
        maxAttempts: OUTBOUND_MAX_ATTEMPTS,
      });
      if (!retrying) {
        if (queueId) {
          await failDelivery(queueId, formatErrorMessage(err)).catch(() => undefined);
        }
        return;
      }
      await waitForOutboundRetry(OUTBOUND_RETRY_DELAY_MS);
    }
  }
}

function buildRestartContinuationMessageId(params: {
  sessionKey: string;
  kind: RestartSentinelContinuation["kind"];
  ts: number;
}) {
  return `restart-sentinel:${params.sessionKey}:${params.kind}:${params.ts}`;
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

function resolveRestartContinuationOutboundPayload(params: {
  payload: OutboundReplyPayload;
  messageId: string;
  replyToId?: string;
}): OutboundReplyPayload {
  if (params.payload.replyToId !== params.messageId) {
    return params.payload;
  }
  const payload: OutboundReplyPayload = { ...params.payload };
  delete payload.replyToId;
  return params.replyToId ? { ...payload, replyToId: params.replyToId } : payload;
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

async function deliverQueuedSessionDelivery(params: {
  deps: CliDeps;
  entry: QueuedSessionDelivery;
}) {
  const { cfg, storePath, canonicalKey } = loadSessionEntry(params.entry.sessionKey);
  const queuedDeliveryContext = resolveQueuedSessionDeliveryContext(params.entry);

  if (params.entry.kind === "systemEvent") {
    enqueueSystemEvent(params.entry.text, {
      sessionKey: canonicalKey,
      ...(queuedDeliveryContext
        ? {
            deliveryContext: {
              ...queuedDeliveryContext,
            },
          }
        : {}),
    });
    requestHeartbeat({
      source: "restart-sentinel",
      intent: "immediate",
      reason: "wake",
      sessionKey: canonicalKey,
    });
    return;
  }

  if (!params.entry.route) {
    enqueueSystemEvent(params.entry.message, {
      sessionKey: canonicalKey,
      ...(queuedDeliveryContext
        ? {
            deliveryContext: {
              ...queuedDeliveryContext,
            },
          }
        : {}),
    });
    requestHeartbeat({
      source: "restart-sentinel",
      intent: "immediate",
      reason: "wake",
      sessionKey: canonicalKey,
    });
    return;
  }

  const route = params.entry.route;
  const messageId = resolveQueuedRestartContinuationMessageId(params.entry);
  const userMessage = params.entry.message.trim();
  const agentId = resolveSessionAgentId({
    sessionKey: canonicalKey,
    config: cfg,
  });
  let dispatchError: unknown;
  const ctxPayload = finalizeInboundContext(
    {
      Body: userMessage,
      BodyForAgent: injectTimestamp(userMessage, timestampOptsFromConfig(cfg)),
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
      ReplyToId: route.replyToId,
      OriginatingChannel: route.channel,
      OriginatingTo: route.to,
      ExplicitDeliverRoute: true,
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
    dispatchReplyWithBufferedBlockDispatcher,
    delivery: {
      preparePayload: (payload) => {
        if (isRestartContinuationBusyPayload(payload)) {
          throw new Error(RESTART_CONTINUATION_BUSY_RETRY_ERROR);
        }
        return resolveRestartContinuationOutboundPayload({
          payload,
          messageId,
          replyToId: route.replyToId,
        });
      },
      durable: (_payload, info) =>
        info.kind === "final"
          ? {
              to: route.to,
              replyToId: route.replyToId,
              threadId: route.threadId,
              deps: params.deps,
            }
          : false,
      deliver: async (payload) => {
        const send = await sendDurableMessageBatch({
          cfg,
          channel: route.channel,
          to: route.to,
          accountId: route.accountId,
          replyToId: route.replyToId,
          threadId: route.threadId,
          payloads: [payload],
          session: buildOutboundSessionContext({
            cfg,
            sessionKey: canonicalKey,
          }),
          deps: params.deps,
          bestEffort: false,
        });
        if (send.status === "failed" || send.status === "partial_failed") {
          throw send.error;
        }
        const results = send.status === "sent" ? send.results : [];
        if (results.length === 0) {
          throw new Error("restart continuation delivery returned no results");
        }
      },
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
    throw dispatchError;
  }
}

function buildQueuedRestartContinuation(params: {
  sessionKey: string;
  continuation: RestartSentinelContinuation;
  route?: SessionDeliveryRoute;
  ts: number;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
}): QueuedSessionDeliveryPayload {
  const idempotencyKey = buildRestartContinuationMessageId({
    sessionKey: params.sessionKey,
    kind: params.continuation.kind,
    ts: params.ts,
  });
  if (params.continuation.kind === "systemEvent") {
    return {
      kind: "systemEvent",
      sessionKey: params.sessionKey,
      text: params.continuation.text,
      ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
      idempotencyKey,
      maxRetries: RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS,
    };
  }
  return {
    kind: "agentTurn",
    sessionKey: params.sessionKey,
    message: params.continuation.message,
    messageId: idempotencyKey,
    maxRetries: RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS,
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
    await drainPendingSessionDeliveries({
      drainKey: `restart-continuation:${params.entryId}`,
      logLabel: "restart continuation",
      log: params.log,
      deliver: (entry) => deliverQueuedSessionDelivery({ deps: params.deps, entry }),
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
    await waitForOutboundRetry(RESTART_CONTINUATION_BUSY_RETRY_DELAY_MS);
  }
}

export async function recoverPendingRestartContinuationDeliveries(params: {
  deps: CliDeps;
  log?: SessionDeliveryRecoveryLogger;
  maxEnqueuedAt?: number;
}) {
  await recoverPendingSessionDeliveries({
    deliver: (entry) => deliverQueuedSessionDelivery({ deps: params.deps, entry }),
    log: params.log ?? log,
    maxEnqueuedAt: params.maxEnqueuedAt,
  });
}

async function loadRestartSentinelStartupTask(params: {
  deps: CliDeps;
}): Promise<StartupTask | null> {
  const sentinel = await readRestartSentinel();
  if (!sentinel) {
    return null;
  }
  const sentinelPath = resolveRestartSentinelPath();
  const payload = sentinel.payload;
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
    if (!sessionKey) {
      const mainSessionKey = resolveMainSessionKeyFromConfig();
      enqueueSystemEvent(message, { sessionKey: mainSessionKey });
      if (payload.continuation) {
        log.warn(`${summary}: continuation skipped: restart sentinel sessionKey unavailable`, {
          sessionKey: mainSessionKey,
          continuationKind: payload.continuation.kind,
        });
      }
      await removeRestartSentinelFile(sentinelPath);
      return { status: "ran" as const };
    }

    const { baseSessionKey, threadId: sessionThreadId } = parseSessionThreadInfo(sessionKey);

    const { cfg, entry, canonicalKey } = loadSessionEntry(sessionKey);

    const sentinelContext = payload.deliveryContext;
    let sessionDeliveryContext = deliveryContextFromSession(entry);
    let chatType = entry?.origin?.chatType ?? "direct";
    if (
      !hasRoutableDeliveryContext(sessionDeliveryContext) &&
      baseSessionKey &&
      baseSessionKey !== sessionKey
    ) {
      const { entry: baseEntry } = loadSessionEntry(baseSessionKey);
      chatType = entry?.origin?.chatType ?? baseEntry?.origin?.chatType ?? "direct";
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
      continuationQueueId = await enqueueSessionDelivery(
        buildQueuedRestartContinuation({
          sessionKey: canonicalKey,
          continuation: payload.continuation,
          ts: payload.ts,
          route: continuationRoute,
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

    await removeRestartSentinelFile(sentinelPath);
    const routedAgentTurnContinuation =
      payload.continuation?.kind === "agentTurn" && continuationRoute !== undefined;
    if (!routedAgentTurnContinuation) {
      enqueueRestartSentinelWake(message, sessionKey, wakeDeliveryContext);
    }

    if (resolvedTo && channel) {
      const outboundSession = buildOutboundSessionContext({
        cfg,
        sessionKey: canonicalKey,
      });

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
        session: outboundSession,
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

export async function scheduleRestartSentinelWake(params: { deps: CliDeps }) {
  const task = await loadRestartSentinelStartupTask(params);
  if (!task) {
    return;
  }
  await runStartupTasks({ tasks: [task], log });
}

export function shouldWakeFromRestartSentinel() {
  return !process.env.VITEST && process.env.NODE_ENV !== "test";
}

export async function refreshLatestUpdateRestartSentinel(): Promise<RestartSentinelPayload | null> {
  const finalized = await finalizeUpdateRestartSentinelRunningVersion();
  const sentinel = finalized ?? (await readRestartSentinel());
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
