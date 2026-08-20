// Voice Call plugin module implements events behavior.
import crypto from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { redactIdentifier } from "openclaw/plugin-sdk/logging-core";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { isAllowlistedCaller, normalizePhoneNumber } from "../allowlist.js";
import { resolveVoiceCallEffectiveConfig, resolveVoiceCallSessionKey } from "../config.js";
import type { CallRecord, NormalizedEvent } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { finalizeCall } from "./lifecycle.js";
import { findCall } from "./lookup.js";
import { endCall } from "./outbound.js";
import {
  appendCallReplayKey,
  releaseRejectedProviderCall,
  rememberManagerReplayKey,
  reserveRejectedProviderCall,
} from "./replay-keys.js";
import { addTranscriptEntry, transitionState } from "./state.js";
import { persistCallRecord } from "./store.js";
import { resolveTranscriptWaiter, startMaxDurationTimer } from "./timers.js";

const log = createSubsystemLogger("voice-call/events");

type EventContext = Pick<
  CallManagerContext,
  | "activeCalls"
  | "providerCallIdMap"
  | "processedEventIds"
  | "rejectedProviderCallIds"
  | "provider"
  | "config"
  | "coreSession"
  | "storePath"
  | "transcriptWaiters"
  | "maxDurationTimers"
  | "endCallOperations"
  | "onCallAnswered"
  | "streamSessionIssuer"
>;

export type ProcessEventResult =
  | { kind: "ignored"; replayable?: true }
  | { kind: "processed"; replayable?: true }
  | {
      kind: "final-speech";
      call: CallRecord;
      transcript: string;
      waiterResolved: boolean;
    };

function shouldAcceptInbound(config: EventContext["config"], from: string | undefined): boolean {
  const { inboundPolicy: policy, allowFrom } = config;

  switch (policy) {
    case "disabled":
      log.info("Inbound call rejected: policy is disabled");
      return false;

    case "open":
      log.info("Inbound call accepted: policy is open");
      return true;

    case "allowlist":
    case "pairing": {
      const normalized = normalizePhoneNumber(from);
      if (!normalized) {
        log.info("Inbound call rejected: missing caller ID");
        return false;
      }
      const allowed = isAllowlistedCaller(normalized, allowFrom);
      const status = allowed ? "accepted" : "rejected";
      log.info(`Inbound call ${status}: caller=${redactIdentifier(from)} allowlisted=${allowed}`);
      return allowed;
    }

    default:
      return false;
  }
}

function createWebhookCall(params: {
  ctx: EventContext;
  providerCallId: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
}): CallRecord {
  const callId = crypto.randomUUID();
  const effective = resolveVoiceCallEffectiveConfig(
    params.ctx.config,
    params.direction === "inbound" ? params.to : undefined,
  );
  const effectiveConfig = effective.config;

  const callRecord: CallRecord = {
    callId,
    providerCallId: params.providerCallId,
    provider: params.ctx.provider?.name || "twilio",
    direction: params.direction,
    state: "ringing",
    from: params.from,
    to: params.to,
    sessionKey: resolveVoiceCallSessionKey({
      config: effectiveConfig,
      callId,
      phone: params.direction === "outbound" ? params.to : params.from,
      coreSession: params.ctx.coreSession,
    }),
    agentId: normalizeAgentId(effectiveConfig.agentId),
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    metadata: {
      initialMessage:
        params.direction === "inbound"
          ? effectiveConfig.inboundGreeting || "Hello! How can I help you today?"
          : undefined,
      ...(effective.numberRouteKey ? { numberRouteKey: effective.numberRouteKey } : {}),
    },
  };

  persistCallRecord(params.ctx.storePath, callRecord);
  params.ctx.activeCalls.set(callId, callRecord);
  params.ctx.providerCallIdMap.set(params.providerCallId, callId);

  log.info(
    `Created ${params.direction} call record: ${callId} caller=${redactIdentifier(params.from)}`,
  );
  return callRecord;
}

function persistRejectedInboundCall(params: {
  ctx: EventContext;
  event: NormalizedEvent;
  dedupeKey: string;
  providerCallId: string;
}): void {
  const callId = params.event.callId || params.providerCallId;
  const now = Date.now();
  const rejectedCall: CallRecord = {
    callId,
    providerCallId: params.providerCallId,
    provider: params.ctx.provider?.name || "twilio",
    direction: "inbound",
    state: "hangup-bot",
    from: params.event.from || "unknown",
    to: params.event.to || params.ctx.config.fromNumber || "unknown",
    startedAt: params.event.timestamp || now,
    endedAt: now,
    endReason: "hangup-bot",
    transcript: [],
    processedEventIds: [params.dedupeKey],
    metadata: { rejectionReason: "inbound-policy" },
  };
  persistCallRecord(params.ctx.storePath, rejectedCall);
}

export function processEvent(ctx: EventContext, event: NormalizedEvent): ProcessEventResult {
  const dedupeKey = event.dedupeKey || event.id;
  if (ctx.processedEventIds.has(dedupeKey)) {
    return { kind: "ignored" };
  }

  let call = findCall({
    activeCalls: ctx.activeCalls,
    providerCallIdMap: ctx.providerCallIdMap,
    callIdOrProviderCallId: event.callId,
  });

  const providerCallId = event.providerCallId;
  const eventDirection =
    event.direction === "inbound" || event.direction === "outbound" ? event.direction : undefined;

  // Auto-register untracked calls arriving via webhook. This covers both
  // true inbound calls and externally-initiated outbound-api calls (e.g. calls
  // placed directly via the Twilio REST API pointing at our webhook URL).
  if (!call && providerCallId && eventDirection) {
    // Apply inbound policy for true inbound calls; external outbound-api calls
    // are implicitly trusted because the caller controls the webhook URL.
    if (eventDirection === "inbound" && !shouldAcceptInbound(ctx.config, event.from)) {
      const pid = providerCallId;
      if (!ctx.provider) {
        log.warn(
          `Inbound call rejected by policy but no provider to hang up (providerCallId: ${pid}, caller=${redactIdentifier(event.from)}); call will time out on provider side.`,
        );
        return { kind: "ignored" };
      }
      if (ctx.rejectedProviderCallIds.has(pid)) {
        return { kind: "ignored" };
      }
      const callId = event.callId ?? pid;
      persistRejectedInboundCall({ ctx, event, dedupeKey, providerCallId: pid });
      const rejectionReservation = reserveRejectedProviderCall(ctx.rejectedProviderCallIds, pid);
      if (rejectionReservation === undefined) {
        return { kind: "ignored" };
      }
      rememberManagerReplayKey(ctx.processedEventIds, dedupeKey);
      log.info(`Rejecting inbound call by policy: ${pid}`);
      void ctx.provider
        .hangupCall({
          callId,
          providerCallId: pid,
          reason: "hangup-bot",
        })
        .catch((err: unknown) => {
          releaseRejectedProviderCall(ctx.rejectedProviderCallIds, pid, rejectionReservation);
          const message = formatErrorMessage(err);
          log.warn(`Failed to reject inbound call ${pid}: ${message}`);
        });
      return { kind: "processed" };
    }

    call = createWebhookCall({
      ctx,
      providerCallId,
      direction: eventDirection === "outbound" ? "outbound" : "inbound",
      from: event.from || "unknown",
      to: event.to || ctx.config.fromNumber || "unknown",
    });

    // Normalize event to internal ID for downstream consumers.
    event.callId = call.callId;
  }

  if (!call) {
    return { kind: "ignored", replayable: true };
  }

  const activeCall = call;
  const previousCall = {
    state: activeCall.state,
    providerCallId: activeCall.providerCallId,
    answeredAt: activeCall.answeredAt,
    endedAt: activeCall.endedAt,
    endReason: activeCall.endReason,
    transcriptLength: activeCall.transcript.length,
    processedEventIds: [...activeCall.processedEventIds],
  };
  const shouldCommitReplayKey = !(event.type === "call.error" && event.retryable);
  const effects: Array<() => void> = [];
  let result: ProcessEventResult = { kind: "processed" };
  const startDurationTimer = () => {
    startMaxDurationTimer({
      ctx,
      callId: activeCall.callId,
      onTimeout: (callId) => endCall(ctx, callId, { reason: "timeout" }),
    });
  };
  const prepareLiveDurationTimer = () => {
    if (!activeCall.answeredAt) {
      activeCall.answeredAt = event.timestamp;
      effects.push(startDurationTimer);
    }
  };
  const publishProviderCallId = (terminal = false) => {
    if (!event.providerCallId || event.providerCallId === previousCall.providerCallId) {
      return;
    }
    if (!terminal) {
      ctx.providerCallIdMap.set(event.providerCallId, activeCall.callId);
    }
    if (previousCall.providerCallId) {
      const mapped = ctx.providerCallIdMap.get(previousCall.providerCallId);
      if (mapped === activeCall.callId) {
        ctx.providerCallIdMap.delete(previousCall.providerCallId);
      }
    }
  };

  try {
    if (event.providerCallId && event.providerCallId !== activeCall.providerCallId) {
      activeCall.providerCallId = event.providerCallId;
    }
    if (shouldCommitReplayKey) {
      appendCallReplayKey(activeCall.processedEventIds, dedupeKey);
    }

    switch (event.type) {
      case "call.initiated": {
        transitionState(activeCall, "initiated");
        const inboundProvider = ctx.provider;
        const inboundProviderCallId = activeCall.providerCallId;
        const answerInboundCall = inboundProvider?.answerCall?.bind(inboundProvider);
        if (activeCall.direction === "inbound" && inboundProviderCallId && answerInboundCall) {
          effects.push(() => {
            const inboundStreamSession =
              ctx.config.realtime?.enabled &&
              inboundProvider?.name === "telnyx" &&
              ctx.streamSessionIssuer
                ? ctx.streamSessionIssuer({
                    providerName: "telnyx",
                    callId: activeCall.callId,
                    from: activeCall.from,
                    to: activeCall.to,
                    direction: "inbound",
                  })
                : undefined;
            void answerInboundCall({
              callId: activeCall.callId,
              providerCallId: inboundProviderCallId,
              ...(inboundStreamSession
                ? {
                    streamUrl: inboundStreamSession.streamUrl,
                    streamAuthToken: inboundStreamSession.token,
                  }
                : {}),
            }).catch((err: unknown) => {
              const message = formatErrorMessage(err);
              log.warn(`Failed to answer inbound call ${activeCall.providerCallId}: ${message}`);
            });
          });
        }
        break;
      }

      case "call.ringing":
        transitionState(activeCall, "ringing");
        break;

      case "call.answered":
        activeCall.answeredAt = event.timestamp;
        transitionState(activeCall, "answered");
        effects.push(startDurationTimer, () => ctx.onCallAnswered?.(activeCall));
        break;

      case "call.active":
        transitionState(activeCall, "active");
        break;

      case "call.speaking":
      case "call.assistant-speech":
        prepareLiveDurationTimer();
        transitionState(activeCall, "speaking");
        if (event.type === "call.assistant-speech" && event.transcript.trim()) {
          addTranscriptEntry(activeCall, "bot", event.transcript);
        }
        break;

      case "call.speech":
        if (event.isFinal && event.transcript.trim()) {
          const waiter = ctx.transcriptWaiters.get(activeCall.callId);
          if (waiter?.turnToken && waiter.turnToken !== event.turnToken) {
            log.warn(`Ignoring speech event with mismatched turn token for ${activeCall.callId}`);
            result = { kind: "ignored" };
            break;
          }
          addTranscriptEntry(activeCall, "user", event.transcript);
          result = {
            kind: "final-speech",
            call: activeCall,
            transcript: event.transcript,
            waiterResolved: Boolean(waiter),
          };
          if (waiter) {
            effects.push(() => {
              resolveTranscriptWaiter(ctx, activeCall.callId, event.transcript, event.turnToken);
            });
          }
        }
        prepareLiveDurationTimer();
        transitionState(activeCall, "listening");
        break;

      case "call.silence":
      case "call.dtmf":
        break;

      case "call.ended":
        finalizeCall({
          ctx,
          call: activeCall,
          endReason: event.reason,
          endedAt: event.timestamp,
        });
        publishProviderCallId(true);
        rememberManagerReplayKey(ctx.processedEventIds, dedupeKey);
        return { kind: "processed" };

      case "call.error":
        if (!event.retryable) {
          finalizeCall({
            ctx,
            call: activeCall,
            endReason: "error",
            endedAt: event.timestamp,
            transcriptRejectReason: `Call error: ${event.error}`,
          });
          publishProviderCallId(true);
          rememberManagerReplayKey(ctx.processedEventIds, dedupeKey);
          return { kind: "processed" };
        }
        // Retryable provider errors remain uncommitted for a later redelivery.
        result = { kind: "processed", replayable: true };
        break;
    }

    // Persist reversible call mutations before publishing dedupe, timers, or waiters.
    persistCallRecord(ctx.storePath, activeCall);
    publishProviderCallId();
    if (shouldCommitReplayKey) {
      rememberManagerReplayKey(ctx.processedEventIds, dedupeKey);
    }
  } catch (err) {
    Object.assign(activeCall, {
      state: previousCall.state,
      providerCallId: previousCall.providerCallId,
      answeredAt: previousCall.answeredAt,
      endedAt: previousCall.endedAt,
      endReason: previousCall.endReason,
    });
    activeCall.transcript.length = previousCall.transcriptLength;
    activeCall.processedEventIds.splice(
      0,
      activeCall.processedEventIds.length,
      ...previousCall.processedEventIds,
    );
    throw err;
  }
  for (const effect of effects) {
    effect();
  }
  return result;
}
