import crypto from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isAllowlistedCaller, normalizePhoneNumber } from "../allowlist.js";
import type { CallRecord, NormalizedEvent } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { finalizeCall } from "./lifecycle.js";
import { findCall } from "./lookup.js";
import { endCall } from "./outbound.js";
import { addTranscriptEntry, transitionState } from "./state.js";
import { persistCallRecord } from "./store.js";
import { resolveTranscriptWaiter, startMaxDurationTimer } from "./timers.js";

type EventContext = Pick<
  CallManagerContext,
  | "activeCalls"
  | "providerCallIdMap"
  | "processedEventIds"
  | "rejectedProviderCallIds"
  | "provider"
  | "config"
  | "storePath"
  | "transcriptWaiters"
  | "maxDurationTimers"
  | "onCallAnswered"
>;

function shouldAcceptInbound(config: EventContext["config"], from: string | undefined): boolean {
  const { inboundPolicy: policy, allowFrom } = config;

  switch (policy) {
    case "disabled":
      console.log("[voice-call] Inbound call rejected: policy is disabled");
      return false;

    case "open":
      console.log("[voice-call] Inbound call accepted: policy is open");
      return true;

    case "allowlist":
    case "pairing": {
      const normalized = normalizePhoneNumber(from);
      if (!normalized) {
        console.log("[voice-call] Inbound call rejected: missing caller ID");
        return false;
      }
      const allowed = isAllowlistedCaller(normalized, allowFrom);
      const status = allowed ? "accepted" : "rejected";
      console.log(
        `[voice-call] Inbound call ${status}: ${from} ${allowed ? "is in" : "not in"} allowlist`,
      );
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

  const callRecord: CallRecord = {
    callId,
    providerCallId: params.providerCallId,
    provider: params.ctx.provider?.name || "twilio",
    direction: params.direction,
    state: "ringing",
    from: params.from,
    to: params.to,
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    metadata: {
      initialMessage:
        params.direction === "inbound"
          ? params.ctx.config.inboundGreeting || "Hello! How can I help you today?"
          : undefined,
    },
  };

  params.ctx.activeCalls.set(callId, callRecord);
  params.ctx.providerCallIdMap.set(params.providerCallId, callId);
  persistCallRecord(params.ctx.storePath, callRecord);

  console.log(
    `[voice-call] Created ${params.direction} call record: ${callId} from ${params.from}`,
  );
  return callRecord;
}

export function processEvent(ctx: EventContext, event: NormalizedEvent): void {
  const dedupeKey = event.dedupeKey || event.id;
  if (ctx.processedEventIds.has(dedupeKey)) {
    return;
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
        console.warn(
          `[voice-call] Inbound call rejected by policy but no provider to hang up (providerCallId: ${pid}, from: ${event.from}); call will time out on provider side.`,
        );
        return;
      }
      ctx.processedEventIds.add(dedupeKey);
      if (ctx.rejectedProviderCallIds.has(pid)) {
        return;
      }
      ctx.rejectedProviderCallIds.add(pid);
      const callId = event.callId ?? pid;
      console.log(`[voice-call] Rejecting inbound call by policy: ${pid}`);
      void ctx.provider
        .hangupCall({
          callId,
          providerCallId: pid,
          reason: "hangup-bot",
        })
        .catch((err) => {
          ctx.rejectedProviderCallIds.delete(pid);
          const message = formatErrorMessage(err);
          console.warn(`[voice-call] Failed to reject inbound call ${pid}:`, message);
        });
      return;
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
    return;
  }

  if (event.providerCallId && event.providerCallId !== call.providerCallId) {
    const previousProviderCallId = call.providerCallId;
    call.providerCallId = event.providerCallId;
    ctx.providerCallIdMap.set(event.providerCallId, call.callId);
    if (previousProviderCallId) {
      const mapped = ctx.providerCallIdMap.get(previousProviderCallId);
      if (mapped === call.callId) {
        ctx.providerCallIdMap.delete(previousProviderCallId);
      }
    }
  }

  const shouldCommitReplayKey = !(event.type === "call.error" && event.retryable);
  if (shouldCommitReplayKey) {
    ctx.processedEventIds.add(dedupeKey);
    call.processedEventIds.push(dedupeKey);
  }

  switch (event.type) {
    case "call.initiated":
      transitionState(call, "initiated");
      if (call.direction === "inbound" && call.providerCallId && ctx.provider?.answerCall) {
        void ctx.provider
          .answerCall({
            callId: call.callId,
            providerCallId: call.providerCallId,
          })
          .catch((err) => {
            const message = formatErrorMessage(err);
            console.warn(
              `[voice-call] Failed to answer inbound call ${call.providerCallId}:`,
              message,
            );
          });
      }
      break;

    case "call.ringing":
      transitionState(call, "ringing");
      break;

    case "call.answered":
      call.answeredAt = event.timestamp;
      transitionState(call, "answered");
      startMaxDurationTimer({
        ctx,
        callId: call.callId,
        onTimeout: async (callId) => {
          await endCall(ctx, callId, { reason: "timeout" });
        },
      });
      ctx.onCallAnswered?.(call);
      break;

    case "call.active":
      transitionState(call, "active");
      break;

    case "call.speaking":
      transitionState(call, "speaking");
      break;

    case "call.speech":
      if (event.isFinal) {
        const hadWaiter = ctx.transcriptWaiters.has(call.callId);
        const resolved = resolveTranscriptWaiter(
          ctx,
          call.callId,
          event.transcript,
          event.turnToken,
        );
        if (hadWaiter && !resolved) {
          console.warn(
            `[voice-call] Ignoring speech event with mismatched turn token for ${call.callId}`,
          );
          break;
        }
        addTranscriptEntry(call, "user", event.transcript);
      }
      transitionState(call, "listening");
      break;

    case "call.silence":
    case "call.dtmf":
      break;

    case "call.ended":
      finalizeCall({
        ctx,
        call,
        endReason: event.reason,
        endedAt: event.timestamp,
      });
      return;

    case "call.error":
      if (!event.retryable) {
        finalizeCall({
          ctx,
          call,
          endReason: "error",
          endedAt: event.timestamp,
          transcriptRejectReason: `Call error: ${event.error}`,
        });
        return;
      }
      // Keep retryable provider errors replayable so a redelivery can still
      // drive later recovery or terminal handling for the same event key.
      break;
  }

  persistCallRecord(ctx.storePath, call);
}
