import crypto from "node:crypto";

import type { CallId, CallRecord, CallState, NormalizedEvent } from "../types.js";
import { TerminalStates } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { findCall } from "./lookup.js";
import { addTranscriptEntry, transitionState } from "./state.js";
import { persistCallRecord } from "./store.js";
import {
  clearMaxDurationTimer,
  rejectTranscriptWaiter,
  resolveTranscriptWaiter,
  startMaxDurationTimer,
} from "./timers.js";
import { endCall } from "./outbound.js";

function shouldAcceptInbound(config: CallManagerContext["config"], from: string | undefined): boolean {
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
      const normalized = from?.replace(/\D/g, "") || "";
      const allowed = (allowFrom || []).some((num) => {
        const normalizedAllow = num.replace(/\D/g, "");
        return normalized.endsWith(normalizedAllow) || normalizedAllow.endsWith(normalized);
      });
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

function createInboundCall(params: {
  ctx: CallManagerContext;
  providerCallId: string;
  from: string;
  to: string;
}): CallRecord {
  const callId = crypto.randomUUID();

  const callRecord: CallRecord = {
    callId,
    providerCallId: params.providerCallId,
    provider: params.ctx.provider?.name || "twilio",
    direction: "inbound",
    state: "ringing",
    from: params.from,
    to: params.to,
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    metadata: {
      initialMessage: params.ctx.config.inboundGreeting || "Hello! How can I help you today?",
    },
  };

  params.ctx.activeCalls.set(callId, callRecord);
  params.ctx.providerCallIdMap.set(params.providerCallId, callId);
  persistCallRecord(params.ctx.storePath, callRecord);

  console.log(`[voice-call] Created inbound call record: ${callId} from ${params.from}`);
  return callRecord;
}

export function processEvent(ctx: CallManagerContext, event: NormalizedEvent): void {
  if (ctx.processedEventIds.has(event.id)) return;
  ctx.processedEventIds.add(event.id);

  let call = findCall({
    activeCalls: ctx.activeCalls,
    providerCallIdMap: ctx.providerCallIdMap,
    callIdOrProviderCallId: event.callId,
  });

  if (!call && event.direction === "inbound" && event.providerCallId) {
    if (!shouldAcceptInbound(ctx.config, event.from)) {
      // TODO: Could hang up the call here.
      return;
    }

    call = createInboundCall({
      ctx,
      providerCallId: event.providerCallId,
      from: event.from || "unknown",
      to: event.to || ctx.config.fromNumber || "unknown",
    });

    // Normalize event to internal ID for downstream consumers.
    event.callId = call.callId;
  }

  if (!call) return;

  if (event.providerCallId && !call.providerCallId) {
    call.providerCallId = event.providerCallId;
    ctx.providerCallIdMap.set(event.providerCallId, call.callId);
  }

  call.processedEventIds.push(event.id);

  switch (event.type) {
    case "call.initiated":
      transitionState(call, "initiated");
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
          await endCall(ctx, callId);
        },
      });
      break;

    case "call.active":
      transitionState(call, "active");
      break;

    case "call.speaking":
      transitionState(call, "speaking");
      break;

    case "call.speech":
      if (event.isFinal) {
        addTranscriptEntry(call, "user", event.transcript);
        resolveTranscriptWaiter(ctx, call.callId, event.transcript);
      }
      transitionState(call, "listening");
      break;

    case "call.ended":
      call.endedAt = event.timestamp;
      call.endReason = event.reason;
      transitionState(call, event.reason as CallState);
      clearMaxDurationTimer(ctx, call.callId);
      rejectTranscriptWaiter(ctx, call.callId, `Call ended: ${event.reason}`);
      ctx.activeCalls.delete(call.callId);
      if (call.providerCallId) ctx.providerCallIdMap.delete(call.providerCallId);
      break;

    case "call.error":
      if (!event.retryable) {
        call.endedAt = event.timestamp;
        call.endReason = "error";
        transitionState(call, "error");
        clearMaxDurationTimer(ctx, call.callId);
        rejectTranscriptWaiter(ctx, call.callId, `Call error: ${event.error}`);
        ctx.activeCalls.delete(call.callId);
        if (call.providerCallId) ctx.providerCallIdMap.delete(call.providerCallId);
      }
      break;
  }

  persistCallRecord(ctx.storePath, call);
}
