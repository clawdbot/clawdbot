import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import type { ChatType } from "../channels/chat-type.js";
import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { recordInboundSession } from "../channels/session.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveMainSessionKeyFromConfig } from "../config/sessions.js";
import { parseSessionThreadInfo } from "../config/sessions/thread-info.js";
import { formatErrorMessage } from "../infra/errors.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { ackDelivery, enqueueDelivery, failDelivery } from "../infra/outbound/delivery-queue.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveOutboundTarget } from "../infra/outbound/targets.js";
import {
  consumeRestartSentinel,
  formatRestartSentinelMessage,
  type RestartSentinelContinuation,
  summarizeRestartSentinel,
} from "../infra/restart-sentinel.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { recordInboundSessionAndDispatchReply } from "../plugin-sdk/inbound-reply-dispatch.js";
import type { OutboundReplyPayload } from "../plugin-sdk/reply-payload.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
} from "../utils/delivery-context.shared.js";
import { injectTimestamp, timestampOptsFromConfig } from "./server-methods/agent-timestamp.js";
import { loadSessionEntry } from "./session-utils.js";
import { runStartupTasks, type StartupTask } from "./startup-tasks.js";

const log = createSubsystemLogger("gateway/restart-sentinel");
const OUTBOUND_RETRY_DELAY_MS = 1_000;
const OUTBOUND_MAX_ATTEMPTS = 45;

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
  requestHeartbeatNow({ reason: "wake", sessionKey });
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
  // Persist one recoverable notice across the whole retry loop so a transient
  // failure does not leave behind a stale duplicate queue entry.
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
      const results = await deliverOutboundPayloads({
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
          await failDelivery(queueId, formatErrorMessage(err)).catch(() => {
            // Best-effort queue bookkeeping.
          });
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

type RestartContinuationRoute = {
  channel: string;
  to: string;
  accountId?: string;
  replyToId?: string;
  threadId?: string;
  chatType: ChatType;
};

function resolveRestartContinuationRoute(params: {
  channel?: string;
  to?: string;
  accountId?: string;
  replyToId?: string;
  threadId?: string;
  chatType: ChatType;
}): RestartContinuationRoute | undefined {
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

async function dispatchRestartSentinelContinuation(params: {
  deps: CliDeps;
  cfg: ReturnType<typeof loadSessionEntry>["cfg"];
  storePath: string;
  sessionKey: string;
  continuation: RestartSentinelContinuation;
  ts: number;
  route?: RestartContinuationRoute;
}) {
  if (params.continuation.kind === "systemEvent") {
    enqueueSystemEvent(params.continuation.text, {
      sessionKey: params.sessionKey,
      ...(params.route
        ? {
            deliveryContext: {
              channel: params.route.channel,
              to: params.route.to,
              ...(params.route.accountId ? { accountId: params.route.accountId } : {}),
              ...(params.route.threadId ? { threadId: params.route.threadId } : {}),
            },
          }
        : {}),
    });
    requestHeartbeatNow({ reason: "wake", sessionKey: params.sessionKey });
    return;
  }

  if (!params.route) {
    throw new Error("restart continuation route unavailable");
  }

  const route = params.route;
  const messageId = buildRestartContinuationMessageId({
    sessionKey: params.sessionKey,
    kind: params.continuation.kind,
    ts: params.ts,
  });
  const userMessage = params.continuation.message.trim();
  const agentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  let dispatchError: unknown;
  await recordInboundSessionAndDispatchReply({
    cfg: params.cfg,
    channel: route.channel,
    accountId: route.accountId,
    agentId,
    routeSessionKey: params.sessionKey,
    storePath: params.storePath,
    ctxPayload: finalizeInboundContext(
      {
        Body: userMessage,
        BodyForAgent: injectTimestamp(userMessage, timestampOptsFromConfig(params.cfg)),
        BodyForCommands: "",
        RawBody: userMessage,
        CommandBody: "",
        SessionKey: params.sessionKey,
        AccountId: route.accountId,
        MessageSid: messageId,
        Timestamp: Date.now(),
        Provider: route.channel,
        Surface: route.channel,
        ChatType: route.chatType,
        CommandAuthorized: false,
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
    ),
    recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher,
    deliver: async (payload) => {
      const outboundPayload = resolveRestartContinuationOutboundPayload({
        payload,
        messageId,
        replyToId: route.replyToId,
      });
      const results = await deliverOutboundPayloads({
        cfg: params.cfg,
        channel: route.channel,
        to: route.to,
        accountId: route.accountId,
        replyToId: route.replyToId,
        threadId: route.threadId,
        payloads: [outboundPayload],
        session: buildOutboundSessionContext({
          cfg: params.cfg,
          sessionKey: params.sessionKey,
        }),
        deps: params.deps,
        bestEffort: false,
      });
      if (results.length === 0) {
        throw new Error("restart continuation delivery returned no results");
      }
    },
    onRecordError: (err) => {
      log.warn(`restart continuation failed to record inbound session metadata: ${String(err)}`, {
        sessionKey: params.sessionKey,
      });
    },
    onDispatchError: (err) => {
      dispatchError ??= err;
    },
  });
  if (dispatchError) {
    throw dispatchError;
  }
}

async function loadRestartSentinelStartupTask(params: {
  deps: CliDeps;
}): Promise<StartupTask | null> {
  const sentinel = await consumeRestartSentinel();
  if (!sentinel) {
    return null;
  }
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
      return { status: "ran" as const };
    }

    const { baseSessionKey, threadId: sessionThreadId } = parseSessionThreadInfo(sessionKey);

    const { cfg, entry, canonicalKey, storePath } = loadSessionEntry(sessionKey);

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

    enqueueRestartSentinelWake(message, sessionKey, wakeDeliveryContext);

    const channelRaw = origin?.channel;
    const channel = channelRaw ? normalizeChannelId(channelRaw) : null;
    const to = origin?.to;
    const threadId =
      payload.threadId ??
      sessionThreadId ??
      (origin?.threadId != null ? String(origin.threadId) : undefined);
    let resolvedTo: string | undefined;
    let replyToId: string | undefined;
    let resolvedThreadId = threadId;

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
              ? String(replyTransport.threadId)
              : undefined
            : threadId;
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
    }

    if (!payload.continuation) {
      return { status: "ran" as const };
    }

    try {
      await dispatchRestartSentinelContinuation({
        deps: params.deps,
        cfg,
        storePath,
        sessionKey: canonicalKey,
        continuation: payload.continuation,
        ts: payload.ts,
        route: resolveRestartContinuationRoute({
          channel: channel ?? undefined,
          to: resolvedTo,
          accountId: origin?.accountId,
          replyToId,
          threadId: resolvedThreadId,
          chatType,
        }),
      });
    } catch (err) {
      log.warn(`${summary}: continuation delivery failed: ${String(err)}`, {
        sessionKey: canonicalKey,
        continuationKind: payload.continuation.kind,
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
