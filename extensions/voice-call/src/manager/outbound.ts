import crypto from "node:crypto";

import { TerminalStates, type CallId, type CallRecord, type OutboundCallOptions } from "../types.js";
import type { CallMode } from "../config.js";
import { mapVoiceToPolly } from "../voice-mapping.js";
import type { CallManagerContext } from "./context.js";
import { getCallByProviderCallId } from "./lookup.js";
import { generateNotifyTwiml } from "./twiml.js";
import { addTranscriptEntry, transitionState } from "./state.js";
import { persistCallRecord } from "./store.js";
import { clearMaxDurationTimer, clearTranscriptWaiter, rejectTranscriptWaiter, waitForFinalTranscript } from "./timers.js";

export async function initiateCall(
  ctx: CallManagerContext,
  to: string,
  sessionKey?: string,
  options?: OutboundCallOptions | string,
): Promise<{ callId: CallId; success: boolean; error?: string }> {
  const opts: OutboundCallOptions =
    typeof options === "string" ? { message: options } : (options ?? {});
  const initialMessage = opts.message;
  const mode = opts.mode ?? ctx.config.outbound.defaultMode;

  if (!ctx.provider) {
    return { callId: "", success: false, error: "Provider not initialized" };
  }
  if (!ctx.webhookUrl) {
    return { callId: "", success: false, error: "Webhook URL not configured" };
  }

  if (ctx.activeCalls.size >= ctx.config.maxConcurrentCalls) {
    return {
      callId: "",
      success: false,
      error: `Maximum concurrent calls (${ctx.config.maxConcurrentCalls}) reached`,
    };
  }

  const callId = crypto.randomUUID();
  const from =
    ctx.config.fromNumber ||
    (ctx.provider?.name === "mock" ? "+15550000000" : undefined);
  if (!from) {
    return { callId: "", success: false, error: "fromNumber not configured" };
  }

  const callRecord: CallRecord = {
    callId,
    provider: ctx.provider.name,
    direction: "outbound",
    state: "initiated",
    from,
    to,
    sessionKey,
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    metadata: {
      ...(initialMessage && { initialMessage }),
      mode,
    },
  };

  ctx.activeCalls.set(callId, callRecord);
  persistCallRecord(ctx.storePath, callRecord);

  try {
    // For notify mode with a message, use inline TwiML with <Say>.
    let inlineTwiml: string | undefined;
    if (mode === "notify" && initialMessage) {
      const pollyVoice = mapVoiceToPolly(ctx.config.tts?.openai?.voice);
      inlineTwiml = generateNotifyTwiml(initialMessage, pollyVoice);
      console.log(`[voice-call] Using inline TwiML for notify mode (voice: ${pollyVoice})`);
    }

    const result = await ctx.provider.initiateCall({
      callId,
      from,
      to,
      webhookUrl: ctx.webhookUrl,
      inlineTwiml,
    });

    callRecord.providerCallId = result.providerCallId;
    ctx.providerCallIdMap.set(result.providerCallId, callId);
    persistCallRecord(ctx.storePath, callRecord);

    return { callId, success: true };
  } catch (err) {
    callRecord.state = "failed";
    callRecord.endedAt = Date.now();
    callRecord.endReason = "failed";
    persistCallRecord(ctx.storePath, callRecord);
    ctx.activeCalls.delete(callId);
    if (callRecord.providerCallId) {
      ctx.providerCallIdMap.delete(callRecord.providerCallId);
    }

    return {
      callId,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function speak(
  ctx: CallManagerContext,
  callId: CallId,
  text: string,
): Promise<{ success: boolean; error?: string }> {
  const call = ctx.activeCalls.get(callId);
  if (!call) return { success: false, error: "Call not found" };
  if (!ctx.provider || !call.providerCallId) return { success: false, error: "Call not connected" };
  if (TerminalStates.has(call.state)) return { success: false, error: "Call has ended" };

  try {
    transitionState(call, "speaking");
    persistCallRecord(ctx.storePath, call);

    addTranscriptEntry(call, "bot", text);

    const voice =
      ctx.provider?.name === "twilio" ? ctx.config.tts?.openai?.voice : undefined;
    await ctx.provider.playTts({
      callId,
      providerCallId: call.providerCallId,
      text,
      voice,
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function speakInitialMessage(
  ctx: CallManagerContext,
  providerCallId: string,
): Promise<void> {
  const call = getCallByProviderCallId({
    activeCalls: ctx.activeCalls,
    providerCallIdMap: ctx.providerCallIdMap,
    providerCallId,
  });
  if (!call) {
    console.warn(`[voice-call] speakInitialMessage: no call found for ${providerCallId}`);
    return;
  }

  const initialMessage = call.metadata?.initialMessage as string | undefined;
  const mode = (call.metadata?.mode as CallMode) ?? "conversation";

  if (!initialMessage) {
    console.log(`[voice-call] speakInitialMessage: no initial message for ${call.callId}`);
    return;
  }

  // Clear so we don't speak it again if the provider reconnects.
  if (call.metadata) {
    delete call.metadata.initialMessage;
    persistCallRecord(ctx.storePath, call);
  }

  console.log(`[voice-call] Speaking initial message for call ${call.callId} (mode: ${mode})`);
  const result = await speak(ctx, call.callId, initialMessage);
  if (!result.success) {
    console.warn(`[voice-call] Failed to speak initial message: ${result.error}`);
    return;
  }

  if (mode === "notify") {
    const delaySec = ctx.config.outbound.notifyHangupDelaySec;
    console.log(`[voice-call] Notify mode: auto-hangup in ${delaySec}s for call ${call.callId}`);
    setTimeout(async () => {
      const currentCall = ctx.activeCalls.get(call.callId);
      if (currentCall && !TerminalStates.has(currentCall.state)) {
        console.log(`[voice-call] Notify mode: hanging up call ${call.callId}`);
        await endCall(ctx, call.callId);
      }
    }, delaySec * 1000);
  }
}

export async function continueCall(
  ctx: CallManagerContext,
  callId: CallId,
  prompt: string,
): Promise<{ success: boolean; transcript?: string; error?: string }> {
  const call = ctx.activeCalls.get(callId);
  if (!call) return { success: false, error: "Call not found" };
  if (!ctx.provider || !call.providerCallId) return { success: false, error: "Call not connected" };
  if (TerminalStates.has(call.state)) return { success: false, error: "Call has ended" };

  try {
    await speak(ctx, callId, prompt);

    transitionState(call, "listening");
    persistCallRecord(ctx.storePath, call);

    await ctx.provider.startListening({ callId, providerCallId: call.providerCallId });

    const transcript = await waitForFinalTranscript(ctx, callId);

    // Best-effort: stop listening after final transcript.
    await ctx.provider.stopListening({ callId, providerCallId: call.providerCallId });

    return { success: true, transcript };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTranscriptWaiter(ctx, callId);
  }
}

export async function endCall(
  ctx: CallManagerContext,
  callId: CallId,
): Promise<{ success: boolean; error?: string }> {
  const call = ctx.activeCalls.get(callId);
  if (!call) return { success: false, error: "Call not found" };
  if (!ctx.provider || !call.providerCallId) return { success: false, error: "Call not connected" };
  if (TerminalStates.has(call.state)) return { success: true };

  try {
    await ctx.provider.hangupCall({
      callId,
      providerCallId: call.providerCallId,
      reason: "hangup-bot",
    });

    call.state = "hangup-bot";
    call.endedAt = Date.now();
    call.endReason = "hangup-bot";
    persistCallRecord(ctx.storePath, call);

    clearMaxDurationTimer(ctx, callId);
    rejectTranscriptWaiter(ctx, callId, "Call ended: hangup-bot");

    ctx.activeCalls.delete(callId);
    if (call.providerCallId) ctx.providerCallIdMap.delete(call.providerCallId);

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
