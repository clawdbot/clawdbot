// Voice Call plugin module implements lifecycle behavior.
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { TerminalStates, type CallRecord, type EndReason } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { transitionState } from "./state.js";
import { persistCallRecord } from "./store.js";
import { clearMaxDurationTimer, rejectTranscriptWaiter } from "./timers.js";

// Shared call finalization path for manager and webhook lifecycle exits.

const log = createSubsystemLogger("voice-call/lifecycle");

type CallLifecycleContext = Pick<
  CallManagerContext,
  "activeCalls" | "providerCallIdMap" | "storePath"
> &
  Partial<Pick<CallManagerContext, "transcriptWaiters" | "maxDurationTimers">>;

/** Remove a provider-call mapping only when it still points at this call. */
function removeProviderCallMapping(
  providerCallIdMap: Map<string, string>,
  call: Pick<CallRecord, "callId" | "providerCallId">,
): void {
  if (!call.providerCallId) {
    return;
  }
  const mappedCallId = providerCallIdMap.get(call.providerCallId);
  if (mappedCallId === call.callId) {
    providerCallIdMap.delete(call.providerCallId);
  }
}

/** Persist terminal state, clean timers/waiters, and remove active call indexes. */
export function finalizeCall(params: {
  ctx: CallLifecycleContext;
  call: CallRecord;
  endReason: EndReason;
  endedAt?: number;
  transcriptRejectReason?: string;
}): void {
  const { ctx, call, endReason } = params;
  const previousState = call.state;

  call.endedAt = params.endedAt ?? Date.now();
  call.endReason = endReason;
  transitionState(call, endReason);
  persistCallRecord(ctx.storePath, call);

  if (!TerminalStates.has(previousState) && TerminalStates.has(call.state)) {
    log.info(
      `[voice-call] Call finalized callId=${call.callId} providerCallId=${call.providerCallId ?? "unknown"} endReason=${endReason}`,
    );
  }

  if (ctx.maxDurationTimers) {
    clearMaxDurationTimer({ maxDurationTimers: ctx.maxDurationTimers }, call.callId);
  }
  if (ctx.transcriptWaiters) {
    rejectTranscriptWaiter(
      { transcriptWaiters: ctx.transcriptWaiters },
      call.callId,
      params.transcriptRejectReason ?? `Call ended: ${endReason}`,
    );
  }

  ctx.activeCalls.delete(call.callId);
  removeProviderCallMapping(ctx.providerCallIdMap, call);
}
