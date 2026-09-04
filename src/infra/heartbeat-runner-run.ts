import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS } from "../auto-reply/heartbeat.js";
import { resolveResponsePrefixTemplate } from "../auto-reply/reply/response-prefix-template.js";
import { resolveSourceReplyDeliveryMode } from "../auto-reply/reply/source-reply-delivery-mode.js";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import { sendDurableMessageBatchCore } from "../channels/message/runtime.js";
import { formatErrorMessage } from "./errors.js";
import { emitHeartbeatEvent, resolveIndicatorType } from "./heartbeat-events.js";
import {
  isHeartbeatTypingEnabled,
  heartbeatLog,
  resolveHeartbeatChannelPlugin,
  resolveHeartbeatTypingIntervalSeconds,
} from "./heartbeat-runner-config.js";
import {
  classifyHeartbeatAgentOutcome,
  finalizeHeartbeatOutcome,
} from "./heartbeat-runner-delivery.js";
import {
  invokeHeartbeatAgentRun,
  prepareHeartbeatRunStage,
  resolveHeartbeatWakeStage,
  type HeartbeatRunOptions,
} from "./heartbeat-runner-execution.js";
import { createHeartbeatTypingCallbacks } from "./heartbeat-typing.js";
import {
  HEARTBEAT_SKIP_PREEMPTED,
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  type HeartbeatRunResult,
} from "./heartbeat-wake.js";
import { resolveAgentOutboundIdentity } from "./outbound/identity.js";
import { buildOutboundSessionContext } from "./outbound/session-context.js";

const log = heartbeatLog;

export async function runHeartbeatOnce(opts: HeartbeatRunOptions): Promise<HeartbeatRunResult> {
  const wake = await resolveHeartbeatWakeStage(opts);
  if (wake.kind === "skipped") {
    return { status: "skipped", reason: wake.reason };
  }
  const prepared = await prepareHeartbeatRunStage(wake);
  if (prepared.kind === "skipped") {
    return { status: "skipped", reason: prepared.reason };
  }
  const { cfg, agentId, startedAt } = wake;
  const { delivery, visibility, replyPrefix, runSessionKey } = prepared;
  const { outboundPolicySessionKey, hasRelayableExecCompletion } = prepared;

  if (!visibility.showAlerts && !visibility.showOk && !visibility.useIndicator) {
    emitHeartbeatEvent({
      status: "skipped",
      reason: "alerts-disabled",
      durationMs: Date.now() - startedAt,
      channel: delivery.channel !== "none" ? delivery.channel : undefined,
      accountId: delivery.accountId,
    });
    return { status: "skipped", reason: "alerts-disabled" };
  }
  const resolveHeartbeatResponsePrefix = () =>
    resolveResponsePrefixTemplate(
      replyPrefix.responsePrefix,
      replyPrefix.responsePrefixContextProvider(),
    );
  const resolveHeartbeatOkText = () => {
    const responsePrefix = resolveHeartbeatResponsePrefix();
    return responsePrefix ? `${responsePrefix} ${HEARTBEAT_TOKEN}` : HEARTBEAT_TOKEN;
  };
  const outboundSession = buildOutboundSessionContext({
    cfg,
    agentId,
    sessionKey: runSessionKey,
    policySessionKey: outboundPolicySessionKey,
  });
  const outboundIdentity = resolveAgentOutboundIdentity(cfg, agentId);
  const hasChatDelivery = Boolean(
    delivery.channel !== "none" && delivery.to && (visibility.showAlerts || visibility.showOk),
  );
  const heartbeatTypingIntervalSeconds = resolveHeartbeatTypingIntervalSeconds(cfg);
  const heartbeatChannelPlugin =
    delivery.channel !== "none" ? resolveHeartbeatChannelPlugin(delivery.channel) : undefined;
  const heartbeatTyping =
    delivery.channel !== "none" &&
    isHeartbeatTypingEnabled({
      cfg,
      agentId,
      hasChatDelivery,
    })
      ? createHeartbeatTypingCallbacks({
          cfg,
          target: {
            channel: delivery.channel,
            ...(delivery.to !== undefined ? { to: delivery.to } : {}),
            ...(delivery.accountId !== undefined ? { accountId: delivery.accountId } : {}),
            ...(delivery.threadId !== undefined ? { threadId: delivery.threadId } : {}),
          },
          ...(heartbeatChannelPlugin ? { plugin: heartbeatChannelPlugin } : {}),
          ...(opts.deps ? { deps: opts.deps } : {}),
          ...(heartbeatTypingIntervalSeconds !== undefined
            ? { typingIntervalSeconds: heartbeatTypingIntervalSeconds }
            : {}),
          log,
        })
      : undefined;
  const maybeSendHeartbeatOk = async () => {
    if (!visibility.showOk || delivery.channel === "none" || !delivery.to) {
      return false;
    }
    try {
      const heartbeatPlugin = resolveHeartbeatChannelPlugin(delivery.channel);
      if (heartbeatPlugin?.heartbeat?.checkReady) {
        const readiness = await heartbeatPlugin.heartbeat.checkReady({
          cfg,
          accountId: delivery.accountId,
          deps: opts.deps,
        });
        if (!readiness.ok) {
          return false;
        }
      }
      const send = await sendDurableMessageBatchCore({
        cfg,
        channel: delivery.channel,
        to: delivery.to,
        accountId: delivery.accountId,
        threadId: delivery.threadId,
        payloads: [{ text: resolveHeartbeatOkText() }],
        session: outboundSession,
        identity: outboundIdentity,
        deps: opts.deps,
      });
      if (send.status === "failed" || send.status === "partial_failed") {
        throw send.error;
      }
      return send.status === "sent";
    } catch (err) {
      log.warn(`heartbeat: HEARTBEAT_OK delivery failed: ${formatErrorMessage(err)}`);
      return false;
    }
  };

  try {
    await heartbeatTyping?.onReplyStart();
    const agentRun = await invokeHeartbeatAgentRun(opts, wake, prepared);
    if (agentRun.kind !== "completed") {
      const reason =
        agentRun.kind === "busy"
          ? HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT
          : agentRun.kind === "preempted"
            ? HEARTBEAT_SKIP_PREEMPTED
            : "agent-runner-cancelled";
      emitHeartbeatEvent({ status: "skipped", reason, durationMs: Date.now() - startedAt });
      return { status: "skipped", reason };
    }
    const outcome = classifyHeartbeatAgentOutcome({
      agentRun,
      hasRelayableExecCompletion,
      suppressUnmarkedSourceReplies:
        resolveSourceReplyDeliveryMode({
          cfg,
          ctx: { ChatType: delivery.chatType, Provider: delivery.channel },
        }) === "message_tool_only",
      responsePrefix: resolveHeartbeatResponsePrefix(),
      ackMaxChars: DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
    });
    return await finalizeHeartbeatOutcome({
      opts,
      wake,
      prepared,
      outcome,
      maybeSendHeartbeatOk,
      outboundSession,
      outboundIdentity,
    });
  } catch (err) {
    const reason = formatErrorMessage(err);
    emitHeartbeatEvent({
      status: "failed",
      reason,
      durationMs: Date.now() - startedAt,
      channel: delivery.channel !== "none" ? delivery.channel : undefined,
      accountId: delivery.accountId,
      indicatorType: visibility.useIndicator ? resolveIndicatorType("failed") : undefined,
    });
    log.error(`heartbeat failed: ${reason}`, { error: reason });
    return { status: "failed", reason };
  } finally {
    heartbeatTyping?.onCleanup?.();
  }
}
