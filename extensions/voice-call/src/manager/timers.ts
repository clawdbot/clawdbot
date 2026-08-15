// Voice Call plugin module implements timers behavior.
import { TerminalStates, type CallId, type CallRecord } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { persistCallRecord } from "./store.js";
import {
  resolveVoiceCallSecondsTimerDelayMs,
  resolveVoiceCallTimerDelayMs,
} from "./timer-delays.js";

// Max-duration and transcript-waiter timers for active voice calls.

type TimerContext = Pick<
  CallManagerContext,
  "activeCalls" | "maxDurationTimers" | "config" | "storePath" | "transcriptWaiters"
>;
type MaxDurationTimerContext = Pick<
  TimerContext,
  "activeCalls" | "maxDurationTimers" | "config" | "storePath"
>;
type TranscriptWaiterContext = Pick<TimerContext, "transcriptWaiters">;

/** Clear and forget the max-duration timer for a call. */
export function clearMaxDurationTimer(
  ctx: Pick<MaxDurationTimerContext, "maxDurationTimers">,
  callId: CallId,
): void {
  const timer = ctx.maxDurationTimers.get(callId);
  if (timer) {
    clearTimeout(timer);
    ctx.maxDurationTimers.delete(callId);
  }
}

/** Start or replace the max-duration timer for a call. */
export function startMaxDurationTimer(params: {
  ctx: MaxDurationTimerContext;
  callId: CallId;
  onTimeout: (callId: CallId) => Promise<void>;
  timeoutMs?: number;
}): void {
  clearMaxDurationTimer(params.ctx, params.callId);

  const maxDurationMs =
    params.timeoutMs === undefined
      ? resolveVoiceCallSecondsTimerDelayMs(params.ctx.config.maxDurationSeconds)
      : resolveVoiceCallTimerDelayMs(params.timeoutMs);
  console.log(
    `[voice-call] Starting max duration timer (${Math.ceil(maxDurationMs / 1000)}s) for call ${params.callId}`,
  );

  const timer = setTimeout(() => {
    void (async () => {
      params.ctx.maxDurationTimers.delete(params.callId);
      const call = params.ctx.activeCalls.get(params.callId);
      if (call && !TerminalStates.has(call.state)) {
        console.log(
          `[voice-call] Max duration reached (${Math.ceil(maxDurationMs / 1000)}s), ending call ${params.callId}`,
        );
        call.endReason = "timeout";
        persistCallRecord(params.ctx.storePath, call);
        // Provider-specific timeout handling owns the actual hangup after state persistence.
        await params.onTimeout(params.callId);
      }
    })();
  }, maxDurationMs);

  params.ctx.maxDurationTimers.set(params.callId, timer);
}

/** Backfill max-duration enforcement from the first live conversation signal. */
export function ensureMaxDurationTimerForLiveCall(params: {
  ctx: MaxDurationTimerContext;
  call: CallRecord;
  liveAt: number;
  onTimeout: (callId: CallId) => Promise<void>;
}): void {
  if (params.call.answeredAt) {
    return;
  }

  // Realtime streams can prove the call is live before an answered callback;
  // use that first live signal so stale cleanup can skip it without losing
  // maxDurationSeconds enforcement.
  params.call.answeredAt = params.liveAt;
  startMaxDurationTimer({
    ctx: params.ctx,
    callId: params.call.callId,
    onTimeout: params.onTimeout,
  });
}

/** Clear and forget a pending final-transcript waiter. */
export function clearTranscriptWaiter(ctx: TranscriptWaiterContext, callId: CallId): void {
  const waiter = ctx.transcriptWaiters.get(callId);
  if (!waiter) {
    return;
  }
  clearTimeout(waiter.timeout);
  ctx.transcriptWaiters.delete(callId);
}

/** Reject a pending transcript waiter during call finalization or error paths. */
export function rejectTranscriptWaiter(
  ctx: TranscriptWaiterContext,
  callId: CallId,
  reason: string,
): void {
  const waiter = ctx.transcriptWaiters.get(callId);
  if (!waiter) {
    return;
  }
  clearTranscriptWaiter(ctx, callId);
  waiter.reject(new Error(reason));
}

/** Resolve a transcript waiter when the matching turn's final transcript arrives. */
export function resolveTranscriptWaiter(
  ctx: TranscriptWaiterContext,
  callId: CallId,
  transcript: string,
  turnToken?: string,
): boolean {
  const waiter = ctx.transcriptWaiters.get(callId);
  if (!waiter) {
    return false;
  }
  if (waiter.turnToken && waiter.turnToken !== turnToken) {
    return false;
  }
  clearTranscriptWaiter(ctx, callId);
  waiter.resolve(transcript);
  return true;
}

/** Wait for the next final transcript for a call, optionally scoped to a turn token. */
export function waitForFinalTranscript(
  ctx: TimerContext,
  callId: CallId,
  turnToken?: string,
): Promise<string> {
  if (ctx.transcriptWaiters.has(callId)) {
    return Promise.reject(new Error("Already waiting for transcript"));
  }

  const timeoutMs = resolveVoiceCallTimerDelayMs(ctx.config.transcriptTimeoutMs);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ctx.transcriptWaiters.delete(callId);
      reject(new Error(`Timed out waiting for transcript after ${timeoutMs}ms`));
    }, timeoutMs);

    ctx.transcriptWaiters.set(callId, { resolve, reject, timeout, turnToken });
  });
}
