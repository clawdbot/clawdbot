import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
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
  summarizeRestartSentinel,
} from "../infra/restart-sentinel.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
} from "../utils/delivery-context.shared.js";
import { loadSessionEntry } from "./session-utils.js";

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

export async function scheduleRestartSentinelWake(params: { deps: CliDeps }) {
  const sentinel = await consumeRestartSentinel();
  if (!sentinel) {
    return;
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

  if (!sessionKey) {
    const mainSessionKey = resolveMainSessionKeyFromConfig();
    enqueueSystemEvent(message, { sessionKey: mainSessionKey });
    return;
  }

  const { baseSessionKey, threadId: sessionThreadId } = parseSessionThreadInfo(sessionKey);

  const { cfg, entry } = loadSessionEntry(sessionKey);

  // Prefer delivery context from sentinel (captured at restart) over session store
  // Handles race condition where store wasn't flushed before restart
  const sentinelContext = payload.deliveryContext;
  let sessionDeliveryContext = deliveryContextFromSession(entry);
  if (
    !hasRoutableDeliveryContext(sessionDeliveryContext) &&
    baseSessionKey &&
    baseSessionKey !== sessionKey
  ) {
    const { entry: baseEntry } = loadSessionEntry(baseSessionKey);
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
  if (!channel || !to) {
    return;
  }

  const resolved = resolveOutboundTarget({
    channel,
    to,
    cfg,
    accountId: origin?.accountId,
    mode: "implicit",
  });
  if (!resolved.ok) {
    return;
  }

  const threadId =
    payload.threadId ??
    sessionThreadId ??
    (origin?.threadId != null ? String(origin.threadId) : undefined);

  const replyTransport =
    getChannelPlugin(channel)?.threading?.resolveReplyTransport?.({
      cfg,
      accountId: origin?.accountId,
      threadId,
    }) ?? null;
  const replyToId = replyTransport?.replyToId ?? undefined;
  const resolvedThreadId =
    replyTransport && Object.hasOwn(replyTransport, "threadId")
      ? replyTransport.threadId != null
        ? String(replyTransport.threadId)
        : undefined
      : threadId;
  const outboundSession = buildOutboundSessionContext({
    cfg,
    sessionKey,
  });

  await deliverRestartSentinelNotice({
    deps: params.deps,
    cfg,
    sessionKey,
    summary,
    message,
    channel,
    to: resolved.to,
    accountId: origin?.accountId,
    replyToId,
    threadId: resolvedThreadId,
    session: outboundSession,
  });
}

export function shouldWakeFromRestartSentinel() {
  return !process.env.VITEST && process.env.NODE_ENV !== "test";
}
