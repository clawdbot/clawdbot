import { appendCronStyleCurrentTimeLine } from "../agents/current-time.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { prepareReplyConversation } from "../auto-reply/reply/prompt-session-context.js";
import {
  REPLY_OPERATION_RUN_STATE,
  resolveReplyOperationAgentTurn,
  type ReplyOperationRunState,
} from "../auto-reply/reply/reply-operation-run-state.js";
import { withReplySystemEventContext } from "../auto-reply/reply/system-event-session-key.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { formatErrorMessage } from "./errors.js";
import { createHeartbeatDispatch, deliverHeartbeatDispatch } from "./heartbeat-dispatch.js";
import { emitHeartbeatEvent, resolveIndicatorType } from "./heartbeat-events.js";
import {
  heartbeatLog,
  isHeartbeatTypingEnabled,
  resolveHeartbeatChannelPlugin,
  resolveHeartbeatTimeoutOverrideSeconds,
  resolveHeartbeatTypingIntervalSeconds,
} from "./heartbeat-runner-config.js";
import {
  prepareHeartbeatRunStage,
  resolveHeartbeatWakeStage,
  type HeartbeatRunOptions,
} from "./heartbeat-runner-execution.js";
import { createHeartbeatTypingCallbacks } from "./heartbeat-typing.js";
import { getHeartbeatWakeAbortSignal, type HeartbeatRunResult } from "./heartbeat-wake.js";

export async function runHeartbeatOnce(opts: HeartbeatRunOptions): Promise<HeartbeatRunResult> {
  const wake = await resolveHeartbeatWakeStage(opts);
  if (wake.kind === "skipped") {
    return { status: "skipped", reason: wake.reason };
  }
  const prepared = await prepareHeartbeatRunStage(wake);
  if (prepared.kind === "skipped") {
    return { status: "skipped", reason: prepared.reason };
  }
  const { cfg, agentId, heartbeat, startedAt } = wake;
  const { delivery, visibility, sender, runSessionKey, suppressOriginatingContext } = prepared;
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
  const policy = createHeartbeatDispatch(opts, wake, prepared);
  const state: ReplyOperationRunState = { heartbeat: policy };
  const signal = getHeartbeatWakeAbortSignal();
  const channel = delivery.channel !== "none" ? delivery.channel : undefined;
  const typing =
    channel &&
    isHeartbeatTypingEnabled({
      cfg,
      agentId,
      hasChatDelivery: Boolean(delivery.to && (visibility.showAlerts || visibility.showOk)),
    })
      ? createHeartbeatTypingCallbacks({
          cfg,
          target: { ...delivery, channel },
          plugin: resolveHeartbeatChannelPlugin(channel),
          deps: opts.deps,
          typingIntervalSeconds: resolveHeartbeatTypingIntervalSeconds(cfg),
          log: heartbeatLog,
        })
      : undefined;
  try {
    const { dispatchInboundMessageWithRoutedChannelDispatcher } =
      await import("../auto-reply/dispatch.js");
    await typing?.onReplyStart();
    const heartbeatContext = {
      Body: appendCronStyleCurrentTimeLine(prepared.prompt, cfg, startedAt),
      From: sender,
      To: sender,
      OriginatingChannel: !suppressOriginatingContext ? channel : undefined,
      OriginatingTo: !suppressOriginatingContext ? delivery.to : undefined,
      AccountId: delivery.accountId,
      ChatType: delivery.chatType,
      MessageThreadId: delivery.threadId,
      InternalTurnSource: prepared.hasExecCompletion
        ? "exec"
        : prepared.hasCronEvents
          ? "cron"
          : "heartbeat",
      SessionKey: runSessionKey,
      AgentId: agentId,
    } satisfies MsgContext;
    await dispatchInboundMessageWithRoutedChannelDispatcher({
      cfg,
      ctx: heartbeatContext,
      replyResolver: opts.deps?.getReplyFromConfig,
      suppressOutboundHooks: true,
      replyOptions: withReplySystemEventContext<InternalGetReplyOptions>(
        {
          isHeartbeat: true,
          replyConversation: prepareReplyConversation({
            ctx: heartbeatContext,
            sessionEntry: suppressOriginatingContext ? undefined : prepared.conversationEntry,
            isHeartbeat: true,
          }),
          [REPLY_OPERATION_RUN_STATE]: state,
          heartbeatModelOverride: heartbeat?.model?.trim(),
          ...(prepared.usesHeartbeatResponseTool
            ? {
                enableHeartbeatTool: true,
                forceHeartbeatTool: true,
                sourceReplyDeliveryMode: "message_tool_only",
              }
            : {}),
          abortSignal: signal,
          timeoutOverrideSeconds: resolveHeartbeatTimeoutOverrideSeconds(cfg, heartbeat),
          bootstrapContextMode: heartbeat?.lightContext === true ? "lightweight" : undefined,
          disableBlockStreaming: true,
          suppressToolProgressMessages: true,
          suppressDefaultToolProgressMessages: true,
          onModelSelected: prepared.replyPrefix.onModelSelected,
          onSessionPrepared: (binding) => {
            // Capture initialization's exact identity once; later replacements cannot inherit delivery.
            if (
              !policy.prepared.policySessionEntry &&
              !prepared.outboundPolicySessionKey &&
              binding.sessionKey === prepared.sessionKey &&
              binding.storePath === prepared.storePath &&
              binding.lifecycleRevision !== undefined
            ) {
              policy.prepared = {
                ...prepared,
                policySessionEntry: {
                  sessionId: binding.sessionId,
                  lifecycleRevision: binding.lifecycleRevision,
                  updatedAt: startedAt,
                },
              };
            }
          },
        },
        {
          sessionKey: prepared.inspectsRunQueue ? prepared.sessionKey : runSessionKey,
          events: prepared.inspectsRunQueue ? prepared.genericEvents : [],
        },
      ),
      dispatcherOptions: {
        deliver: (payload) =>
          deliverHeartbeatDispatch(policy, payload, state.agentTurnOwner?.abortSignal ?? signal),
      },
    });
    if (policy.result) {
      return policy.result;
    }
    const execution = resolveReplyOperationAgentTurn(state);
    const reason =
      execution === "superseded"
        ? "preempted"
        : execution === "cancelled"
          ? "agent-runner-cancelled"
          : "requests-in-flight";
    emitHeartbeatEvent({ status: "skipped", reason, durationMs: Date.now() - startedAt });
    return { status: "skipped", reason };
  } catch (error) {
    if (policy.result) {
      return policy.result;
    }
    const reason = formatErrorMessage(error);
    emitHeartbeatEvent({
      status: "failed",
      reason,
      durationMs: Date.now() - startedAt,
      channel,
      accountId: delivery.accountId,
      indicatorType: visibility.useIndicator ? resolveIndicatorType("failed") : undefined,
    });
    heartbeatLog.error(`heartbeat failed: ${reason}`, { error: reason });
    return { status: "failed", reason };
  } finally {
    typing?.onCleanup?.();
  }
}
