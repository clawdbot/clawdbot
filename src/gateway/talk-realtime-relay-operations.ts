import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { createDeferredCore } from "../shared/deferred.js";
import { buildRealtimeVoiceAgentCancelProviderResult } from "../talk/agent-run-control-shared.js";
import {
  controlRealtimeVoiceAgentRun,
  type RealtimeVoiceAgentControlResult,
} from "../talk/agent-run-control.js";
import { registerClientVoiceConsultRun } from "../talk/client-voice-session.js";
import type {
  RealtimeVoiceCloseOptions,
  RealtimeVoiceToolResultOptions,
} from "../talk/provider-types.js";
import type { TalkEvent } from "../talk/talk-session-controller.js";
import { abortChatRunById } from "./chat-abort.js";
import { formatError } from "./server-utils.js";
import {
  submitForcedTalkRealtimeRelayToolResult,
  submitRelayAgentControlProviderResults,
} from "./talk-realtime-relay-forced-consults.js";
import {
  broadcastToolResultToOwner,
  clearRelayAgentToolCall,
  completeAfterToolResultSubmissions,
  submitFinalProviderToolResult,
  suppressedToolResultOptions,
  trackAgentFinalToolResult,
  trackPendingWorkingToolResult,
} from "./talk-realtime-relay-provider-results.js";
import {
  MAX_AUDIO_BASE64_BYTES,
  MAX_RELAY_SESSIONS_GLOBAL,
  MAX_RELAY_SESSIONS_PER_CONN,
  drainingRelaySessions,
  ensureRelayTurn,
  noFallbackRelayOutputFlush,
  publishTalkRealtimeRelayEvent,
  relaySessions,
  resolveRelayProviderToolCallId,
  type RelaySession,
} from "./talk-realtime-relay-state.js";
import {
  bindRelaySessionKey,
  closeRelayVoiceSession,
  enqueueRelayVoiceTranscript,
  ensureRelayVoiceSession,
  resolveRelayAgentId,
} from "./talk-realtime-relay-voice.js";
import { decodeTalkRelayAudioBase64 } from "./talk-relay-audio-base64.js";
import {
  closeExpiredTalkRelaySessions,
  closeTalkRelaySessionsForConnection,
  requireActiveTalkRelaySession,
} from "./talk-relay-session-lifecycle.js";
import { forgetUnifiedTalkSession } from "./talk-session-registry.js";

const TURN_BOUND_CANCELLATION_DRAIN_MS = 1_000;

/** Ensure a gateway-relay call has its durable record before transcript-free RPCs. */
export function ensureTalkRealtimeRelayVoiceSession(params: {
  relaySessionId: string;
  connId: string;
  sessionKey: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  bindRelaySessionKey(session, params.sessionKey);
  if (!ensureRelayVoiceSession(session)) {
    throw new Error("Realtime relay voice session could not be created");
  }
  const buffered = session.pendingVoiceTranscripts.splice(0);
  for (const entry of buffered) {
    enqueueRelayVoiceTranscript(session, entry.role, entry.text);
  }
}

function abortRelayAgentRuns(session: RelaySession, reason: string): void {
  for (const [runId, sessionKey] of session.activeAgentRuns) {
    abortChatRunById(session.context, {
      runId,
      sessionKey,
      stopReason: reason,
    });
  }
  session.activeAgentRuns.clear();
  session.activeAgentToolCalls.clear();
}

/** Releases relay-local correlation without cancelling durable voice-bound agent runs. */
function detachRelayAgentRuns(session: RelaySession): void {
  session.activeAgentRuns.clear();
  session.activeAgentToolCalls.clear();
}

export function pruneInactiveRelayAgentRuns(session: RelaySession): number {
  for (const runId of session.activeAgentRuns.keys()) {
    if (!session.context.chatAbortControllers.has(runId)) {
      session.activeAgentRuns.delete(runId);
    }
  }
  for (const [callId, runId] of session.activeAgentToolCalls) {
    if (!session.activeAgentRuns.has(runId)) {
      session.activeAgentToolCalls.delete(callId);
    }
  }
  return session.activeAgentRuns.size;
}

export function closeRelaySession(
  session: RelaySession,
  reason: "completed" | "error",
  options?: RealtimeVoiceCloseOptions,
): void {
  const disposition = options?.disposition ?? "abort";
  session.harness.close();
  session.outputOwnership.drain?.resolve();
  relaySessions.delete(session.id);
  session.unregisterConnectionCleanup?.();
  session.unregisterConnectionCleanup = undefined;
  forgetUnifiedTalkSession(session.id);
  clearTimeout(session.cleanupTimer);
  if (disposition === "detach") {
    detachRelayAgentRuns(session);
  } else {
    abortRelayAgentRuns(session, reason === "error" ? "relay-error" : "relay-closed");
  }
  try {
    session.bridge.close({ disposition });
  } finally {
    // Provider teardown may throw, but the relay must still reach its durable
    // voice and owner-visible terminal state before that error is surfaced.
    void closeRelayVoiceSession(session);
    publishTalkRealtimeRelayEvent(session, {
      relaySessionId: session.id,
      type: "close",
      reason,
      talkEvent: session.harness.talk.emit({
        type: "session.closed",
        payload: { reason },
        final: true,
      }),
    });
  }
}

/** Releases every realtime relay session owned by a disconnected gateway connection. */
export function closeTalkRealtimeRelaySessionsForConnection(connId: string): void {
  closeTalkRelaySessionsForConnection({
    sessions: relaySessions.values(),
    connId,
    closeSession: (session) => closeRelaySession(session, "completed", { disposition: "detach" }),
    onCloseError: (error, session) => {
      session.context.logGateway.warn(
        `failed to close realtime relay session after connection disconnect: ${formatError(error)}`,
      );
    },
  });
}

function pruneExpiredRelaySessions(nowMs = Date.now()): void {
  closeExpiredTalkRelaySessions({
    sessions: relaySessions.values(),
    closeSession: (session) => closeRelaySession(session, "completed"),
    nowMs,
  });
}

function countRelaySessionsForQuotaOwner(quotaOwnerId: string): number {
  let count = 0;
  for (const session of relaySessions.values()) {
    if (session.quotaOwnerId === quotaOwnerId) {
      count += 1;
    }
  }
  for (const session of drainingRelaySessions.values()) {
    if (session.quotaOwnerId === quotaOwnerId) {
      count += 1;
    }
  }
  return count;
}

export function enforceRelaySessionLimits(quotaOwnerId: string): void {
  pruneExpiredRelaySessions();
  if (relaySessions.size + drainingRelaySessions.size >= MAX_RELAY_SESSIONS_GLOBAL) {
    throw new Error("Too many active realtime relay sessions");
  }
  if (countRelaySessionsForQuotaOwner(quotaOwnerId) >= MAX_RELAY_SESSIONS_PER_CONN) {
    throw new Error("Too many active realtime relay sessions for this connection");
  }
}

function getRelaySession(relaySessionId: string, connId: string): RelaySession {
  return requireActiveTalkRelaySession({
    sessions: relaySessions,
    sessionId: relaySessionId,
    connId,
    closeSession: (session) => closeRelaySession(session, "completed"),
    unknownSessionMessage: "Unknown realtime relay session",
  });
}

/** Streams one base64-encoded browser audio frame into the owning relay. */
export function sendTalkRealtimeRelayAudio(params: {
  relaySessionId: string;
  connId: string;
  audioBase64: string;
  timestamp?: number;
}): void | Promise<void> {
  if (params.audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
    throw new Error("Realtime relay audio frame is too large");
  }
  const session = getRelaySession(params.relaySessionId, params.connId);
  if (session.outputOwnership.phase === "cancelling") {
    return session.outputOwnership.drain!.promise.then(() => sendTalkRealtimeRelayAudio(params));
  }
  const audio = decodeTalkRelayAudioBase64(params.audioBase64, "Realtime relay");
  const turnId = ensureRelayTurn(session);
  session.bridge.sendAudio(audio);
  publishTalkRealtimeRelayEvent(session, {
    relaySessionId: session.id,
    type: "inputAudio",
    byteLength: audio.byteLength,
    talkEvent: session.harness.talk.emit({
      type: "input.audio.delta",
      turnId,
      payload: { byteLength: audio.byteLength },
    }),
  });
  if (typeof params.timestamp === "number" && Number.isFinite(params.timestamp)) {
    session.bridge.setMediaTimestamp(params.timestamp);
  }
}

/** Confirms that an owning relay client finished playing through a provider mark. */
export function acknowledgeTalkRealtimeRelayMark(params: {
  relaySessionId: string;
  connId: string;
  markName: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  session.bridge.acknowledgeMark(params.markName);
}

/** Delivers a tool result from the browser/client side back to the provider. */
export function submitTalkRealtimeRelayToolResult(params: {
  relaySessionId: string;
  connId: string;
  callId: string;
  result: unknown;
  options?: RealtimeVoiceToolResultOptions;
}): void | Promise<void> {
  const session = getRelaySession(params.relaySessionId, params.connId);
  if (session.toolCalls.isAgentCompleted(params.callId)) {
    return;
  }
  if (
    session.outputOwnership.phase === "cancelling" &&
    !session.toolCalls.hasCancelled(params.callId)
  ) {
    return;
  }
  if (!session.toolCalls.tryAdmit([params.callId])) {
    return;
  }
  const pendingFinal = session.pendingFinalToolResults.get(params.callId);
  const cancelledAgentCall = session.toolCalls.hasCancelled(params.callId);
  if (pendingFinal && !cancelledAgentCall) {
    return pendingFinal;
  }
  const forcedConsult = session.harness.forcedConsults
    .handles()
    .find((handle) => handle.id === params.callId);

  if (forcedConsult) {
    return submitForcedTalkRealtimeRelayToolResult(session, forcedConsult, {
      callId: params.callId,
      result: params.result,
      options: params.options,
    });
  }

  if (cancelledAgentCall) {
    const providerResult = buildRealtimeVoiceAgentCancelProviderResult(
      "OpenClaw cancelled this consult before completion. Do not restart it.",
    );
    const submitCancellation = () =>
      submitFinalProviderToolResult({
        session,
        callId: params.callId,
        result: providerResult,
        options: suppressedToolResultOptions(session),
        onAccepted: () => {
          session.toolCalls.deleteCancelled(params.callId);
          session.toolCalls.markAgentCompleted([params.callId]);
        },
      });
    const pendingProvider = session.pendingProviderToolResults.get(params.callId);
    const completion = pendingProvider
      ? pendingProvider.then(submitCancellation, submitCancellation)
      : submitCancellation();
    return trackAgentFinalToolResult(session, params.callId, completion);
  }
  if (
    params.options?.suppressResponse === true &&
    session.bridge.bridge.supportsToolResultSuppression === false
  ) {
    throw new Error("Realtime provider does not support suppressed tool results");
  }
  // A final result owns provider completion for this call. Follow-up RPCs share it so
  // only one accepted submission can clear the linked run and emit the success event.
  const final = params.options?.willContinue !== true;
  const turnId = ensureRelayTurn(session);
  const epoch = session.toolResultEpoch;
  const onAccepted = () => {
    if (session.toolResultEpoch !== epoch) {
      return;
    }
    if (final) {
      clearRelayAgentToolCall(session, params.callId);
      if (!session.toolCalls.markAgentCompleted([params.callId])) {
        return;
      }
    }
    broadcastToolResultToOwner(session, {
      callId: params.callId,
      turnId,
      result: params.result,
      final,
    });
  };
  if (final) {
    const completion = submitFinalProviderToolResult({
      session,
      callId: params.callId,
      result: params.result,
      options: params.options,
      onAccepted,
    });
    return trackAgentFinalToolResult(session, params.callId, completion);
  }
  const submit = () =>
    session.bridge.submitToolResult(
      resolveRelayProviderToolCallId(session, params.callId),
      params.result,
      params.options,
    );
  const pendingWorking = session.pendingWorkingToolResults.get(params.callId);
  if (pendingWorking) {
    const submission = pendingWorking.then(async () => {
      if (relaySessions.get(session.id) !== session || session.toolResultEpoch !== epoch) {
        return false;
      }
      await submit();
      return true;
    });
    const completion = submission.then((submitted) => {
      if (submitted && relaySessions.get(session.id) === session) {
        onAccepted();
      }
    });
    return trackPendingWorkingToolResult(session, params.callId, completion);
  }
  const submission = submit();
  const completion = completeAfterToolResultSubmissions(session, [submission], onAccepted);
  return trackPendingWorkingToolResult(session, params.callId, completion);
}

/** Tracks the chat run started for a realtime agent-consult tool call. */
export function registerTalkRealtimeRelayAgentRun(params: {
  relaySessionId: string;
  connId: string;
  sessionKey: string;
  runId: string;
  callId?: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  const callId = params.callId?.trim();
  if (callId && session.toolCalls.isAgentCompleted(callId)) {
    // Provider cancellation can win while chat.send is still acknowledging. Abort
    // the late run before it can escape the relay's call-ownership tombstone.
    abortChatRunById(session.context, {
      runId: params.runId,
      sessionKey: params.sessionKey,
      stopReason: "realtime provider cancelled tool call",
    });
    throw new Error("Realtime provider cancelled the tool call before run registration");
  }
  if (callId && !session.toolCalls.tryAdmit([callId])) {
    throw new Error("Realtime relay tool-call session limit exceeded");
  }
  if (!session.sessionKey) {
    bindRelaySessionKey(session, params.sessionKey);
  }
  session.activeAgentRuns.set(params.runId, params.sessionKey);
  if (callId) {
    session.activeAgentToolCalls.set(callId, params.runId);
  }
  if (!ensureRelayVoiceSession(session)) {
    throw new Error("Realtime relay voice session could not be created for agent consult");
  }
  const voiceSessionKey = session.sessionKey;
  if (!voiceSessionKey) {
    throw new Error("Realtime relay voice session has no pinned session key");
  }
  registerClientVoiceConsultRun({
    agentId: resolveRelayAgentId(session, voiceSessionKey),
    sessionKey: voiceSessionKey,
    voiceSessionId: session.id,
    runId: params.runId,
  });
}

/** Retires one provider-owned tool call and aborts its exact relay consult, if started. */
export function cancelTalkRealtimeRelayProviderToolCall(
  session: RelaySession,
  providerCallId: string,
): string | undefined {
  const mappedRelayCallId = session.relayToolCallIdsByProviderId.get(providerCallId);
  if (!mappedRelayCallId) {
    return undefined;
  }
  const forcedConsult = session.harness.forcedConsults
    .handles()
    .find((handle) =>
      session.harness.forcedConsults.nativeCallIds(handle).includes(providerCallId),
    );
  // A native call can alias an already-started forced consult. Cancellation owns
  // the forced handle because that is where the browser run was registered.
  const relayCallId = forcedConsult?.id ?? mappedRelayCallId;
  if (
    session.toolCalls.isAgentCompleted(relayCallId) ||
    session.toolCalls.isAgentCompleted(mappedRelayCallId) ||
    session.toolCalls.isProviderCompleted(providerCallId)
  ) {
    return undefined;
  }
  if (forcedConsult) {
    session.harness.forcedConsults.markCancelled(forcedConsult);
    if (!session.toolCalls.markCancelled([relayCallId], ensureRelayTurn(session))) {
      return undefined;
    }
  } else {
    session.toolCalls.deleteCancelled(relayCallId);
  }
  if (
    !session.toolCalls.markAgentCompleted([relayCallId, mappedRelayCallId]) ||
    !session.toolCalls.markProviderCompleted([providerCallId])
  ) {
    return undefined;
  }

  const runId = session.activeAgentToolCalls.get(relayCallId);
  const sessionKey = runId ? session.activeAgentRuns.get(runId) : undefined;
  if (runId && sessionKey) {
    abortChatRunById(session.context, {
      runId,
      sessionKey,
      stopReason: "realtime provider cancelled tool call",
    });
  }
  clearRelayAgentToolCall(session, relayCallId);
  session.providerToolCallIds.delete(mappedRelayCallId);
  session.relayToolCallIdsByProviderId.delete(providerCallId);
  return relayCallId;
}

/** Wait for server-owned final transcript appends before a relay consult is authorized. */
export async function flushTalkRealtimeRelayVoiceWrites(params: {
  relaySessionId: string;
  connId: string;
}): Promise<void> {
  const session = getRelaySession(params.relaySessionId, params.connId);
  await session.voiceTranscriptQueue.flush();
}

/** Applies realtime voice-control text to the active agent-consult chat run. */
export async function steerTalkRealtimeRelayAgentRun(params: {
  relaySessionId: string;
  connId: string;
  sessionKey?: string;
  text: string;
  mode?: string;
}): Promise<RealtimeVoiceAgentControlResult> {
  const session = getRelaySession(params.relaySessionId, params.connId);
  const sessionKey = session.sessionKey;
  if (!sessionKey) {
    throw new Error("Realtime relay steering requires a session key");
  }
  const requestedSessionKey = params.sessionKey?.trim();
  if (requestedSessionKey && requestedSessionKey !== sessionKey) {
    throw new Error("Realtime relay steering session key does not match the relay session");
  }
  const result = await controlRealtimeVoiceAgentRun({
    sessionKey,
    text: params.text,
    mode: params.mode,
    recentEvents: session.harness.talk.recentEvents,
  });
  if (relaySessions.get(session.id) !== session) {
    throw new Error("Realtime relay session closed while steering the agent run");
  }
  const turnId = ensureRelayTurn(session);
  const providerSubmission = submitRelayAgentControlProviderResults(session, result, turnId);
  if (providerSubmission?.completion) {
    await providerSubmission.completion;
  }
  const finalResult = providerSubmission?.providerResponseStarted
    ? { ...result, suppress: true }
    : result;
  if (relaySessions.get(session.id) !== session) {
    return finalResult;
  }
  publishTalkRealtimeRelayEvent(session, {
    relaySessionId: session.id,
    type: "toolProgress",
    result: finalResult,
    talkEvent: session.harness.talk.emit({
      type: "tool.progress",
      turnId,
      payload: {
        name: "openclaw_agent_control",
        phase: finalResult.mode,
        result: finalResult,
      },
      final: finalResult.mode === "cancel" || finalResult.mode === "status",
    }),
  });
  return finalResult;
}

/** Cancels the active relay turn, aborts agent work, and clears provider audio. */
export async function cancelTalkRealtimeRelayTurn(params: {
  relaySessionId: string;
  connId: string;
  reason?: string;
  turnId?: string;
}) {
  const session = getRelaySession(params.relaySessionId, params.connId);
  const turnId = session.harness.talk.activeTurnId;
  if (!turnId) {
    return { status: "idle" as const };
  }
  const requestedTurnId = normalizeOptionalString(params.turnId);
  if (requestedTurnId && turnId !== requestedTurnId) {
    return { status: "stale" as const };
  }
  if (session.outputOwnership.phase === "owned" && session.outputOwnership.turnId !== turnId) {
    return { status: "stale" as const };
  }
  const forcedConsults = session.harness.forcedConsults.handles().map((handle) => ({
    handle,
    nativeCallIds: session.harness.forcedConsults.nativeCallIds(handle),
  }));
  const rootCallIds = new Set([
    ...session.activeAgentToolCalls.keys(),
    ...forcedConsults.map(({ handle }) => handle.id),
  ]);
  const terminalEpoch = ++session.toolResultEpoch;
  session.forcedTerminalProviderResults.clear();
  const reason = params.reason ?? "client-cancelled";
  if (
    !session.toolCalls.markCancelled(
      [...rootCallIds, ...forcedConsults.flatMap(({ nativeCallIds }) => nativeCallIds)],
      turnId,
    )
  ) {
    throw new Error("Realtime relay cancellation could not record tool state");
  }
  for (const { handle, nativeCallIds } of forcedConsults) {
    session.harness.forcedConsults.markCancelled(handle);
    session.forcedTerminalProviderResults.set(handle.id, {
      result: buildRealtimeVoiceAgentCancelProviderResult(
        "OpenClaw cancelled this consult before completion. Do not restart it.",
      ),
      options: suppressedToolResultOptions(session),
      turnId,
      epoch: terminalEpoch,
      nativeCallIds,
    });
  }
  session.outputOwnership.phase = "cancelling";
  session.outputOwnership.turnId = turnId;
  const cancellationDrained = (session.outputOwnership.drain = createDeferredCore());
  abortRelayAgentRuns(session, reason);
  const cancelled = session.harness.talk.cancelTurn({
    turnId,
    payload: { reason },
  });
  publishTalkRealtimeRelayEvent(session, {
    relaySessionId: session.id,
    type: "clear",
    talkEvent: cancelled.ok ? cancelled.event : undefined,
  });
  const closeAfterCancellation = () => {
    if (
      relaySessions.get(session.id) === session &&
      session.toolResultEpoch === terminalEpoch &&
      session.outputOwnership.phase === "cancelling"
    ) {
      session.outputOwnership.drain?.resolve();
      closeRelaySession(session, "completed");
    }
  };
  setTimeout(closeAfterCancellation, TURN_BOUND_CANCELLATION_DRAIN_MS).unref?.();
  void Promise.allSettled(
    [...rootCallIds].map(async (callId) => {
      await submitTalkRealtimeRelayToolResult({
        relaySessionId: session.id,
        connId: session.connId,
        callId,
        result: { status: "cancelled" },
      });
    }),
  );
  try {
    session.bridge.handleBargeIn({ audioPlaybackActive: true });
  } catch {
    session.failSession("Realtime provider cancellation failed. Reconnecting.");
  }
  return cancellationDrained.promise.then(() => ({ status: "applied" as const, turnId }));
}

/** Drops one provider generation without sending cancellation into its replacement. */
export function resetTalkRealtimeRelayContinuity(
  session: RelaySession,
  reason = "session.continuity.reset",
): TalkEvent | undefined {
  session.toolResultEpoch += 1;
  const retiredCallIds = new Set<string>([
    ...session.activeAgentToolCalls.keys(),
    ...session.toolCalls.cancelledCallIds(),
    ...session.providerToolCallIds.keys(),
    ...session.providerToolCallIds.values(),
    ...session.pendingFinalToolResults.keys(),
    ...session.pendingProviderToolResults.keys(),
    ...session.pendingWorkingToolResults.keys(),
    ...session.forcedTerminalProviderResults.keys(),
  ]);
  for (const handle of session.harness.forcedConsults.handles()) {
    retiredCallIds.add(handle.id);
    for (const nativeCallId of session.harness.forcedConsults.nativeCallIds(handle)) {
      retiredCallIds.add(nativeCallId);
    }
  }
  if (!session.toolCalls.markAgentCompleted(retiredCallIds)) {
    return undefined;
  }
  session.toolCalls.clearCancelled();
  session.providerToolCallIds.clear();
  session.relayToolCallIdsByProviderId.clear();
  session.pendingFinalToolResults.clear();
  session.toolCalls.clearProviderCompleted();
  session.pendingProviderToolResults.clear();
  session.pendingWorkingToolResults.clear();
  session.forcedTerminalProviderResults.clear();
  session.harness.forcedConsults.clear();
  abortRelayAgentRuns(session, reason);
  const turnId = session.harness.talk.activeTurnId;
  session.harness.flushOutput(noFallbackRelayOutputFlush);
  session.harness.finishOutputAudio(reason);
  if (!turnId) {
    return undefined;
  }
  const cancelled = session.harness.talk.cancelTurn({
    turnId,
    payload: { reason },
  });
  return cancelled.ok ? cancelled.event : undefined;
}

/** Closes a realtime relay session owned by the current connection. */
export function stopTalkRealtimeRelaySession(params: {
  relaySessionId: string;
  connId: string;
  disposition?: RealtimeVoiceCloseOptions["disposition"];
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  closeRelaySession(
    session,
    "completed",
    params.disposition ? { disposition: params.disposition } : undefined,
  );
}
