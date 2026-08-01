import { buildRealtimeVoiceAgentCancelProviderResult } from "../talk/agent-run-control-shared.js";
import {
  controlRealtimeVoiceAgentRun,
  type RealtimeVoiceAgentControlResult,
} from "../talk/agent-run-control.js";
import { registerClientVoiceConsultRun } from "../talk/client-voice-session.js";
import type { RealtimeVoiceToolResultOptions } from "../talk/provider-types.js";
import { abortChatRunById } from "./chat-abort.js";
import { formatError } from "./server-utils.js";
import {
  cancelForcedConsults,
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
  broadcastToOwner,
  ensureRelayTurn,
  noFallbackRelayOutputFlush,
  relaySessions,
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

export function abortRelayAgentRuns(session: RelaySession, reason: string): void {
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

export function closeRelaySession(session: RelaySession, reason: "completed" | "error"): void {
  session.harness.close();
  relaySessions.delete(session.id);
  forgetUnifiedTalkSession(session.id);
  clearTimeout(session.cleanupTimer);
  abortRelayAgentRuns(session, reason === "error" ? "relay-error" : "relay-closed");
  try {
    session.bridge.close();
  } finally {
    // Provider teardown may throw, but the relay must still reach its durable
    // voice and owner-visible terminal state before that error is surfaced.
    closeRelayVoiceSession(session);
    broadcastToOwner(session.context, session.connId, {
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
    closeSession: (session) => closeRelaySession(session, "completed"),
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

function countRelaySessionsForConn(connId: string): number {
  let count = 0;
  for (const session of relaySessions.values()) {
    if (session.connId === connId) {
      count += 1;
    }
  }
  return count;
}

export function enforceRelaySessionLimits(connId: string): void {
  pruneExpiredRelaySessions();
  if (relaySessions.size >= MAX_RELAY_SESSIONS_GLOBAL) {
    throw new Error("Too many active realtime relay sessions");
  }
  if (countRelaySessionsForConn(connId) >= MAX_RELAY_SESSIONS_PER_CONN) {
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
}): void {
  if (params.audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
    throw new Error("Realtime relay audio frame is too large");
  }
  const session = getRelaySession(params.relaySessionId, params.connId);
  const audio = decodeTalkRelayAudioBase64(params.audioBase64, "Realtime relay");
  const turnId = ensureRelayTurn(session);
  session.bridge.sendAudio(audio);
  broadcastToOwner(session.context, session.connId, {
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
  if (session.completedAgentToolCalls.has(params.callId)) {
    return;
  }
  const pendingFinal = session.pendingFinalToolResults.get(params.callId);
  const cancelledAgentCall = session.cancelledAgentToolCalls.has(params.callId);
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
          session.cancelledAgentToolCalls.delete(params.callId);
          session.completedAgentToolCalls.add(params.callId);
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
      session.completedAgentToolCalls.add(params.callId);
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
    session.bridge.submitToolResult(params.callId, params.result, params.options);
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
  if (!session.sessionKey) {
    bindRelaySessionKey(session, params.sessionKey);
  }
  session.activeAgentRuns.set(params.runId, params.sessionKey);
  if (params.callId?.trim()) {
    session.activeAgentToolCalls.set(params.callId.trim(), params.runId);
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

/** Wait for server-owned final transcript appends before a relay consult is authorized. */
export async function flushTalkRealtimeRelayVoiceWrites(params: {
  relaySessionId: string;
  connId: string;
}): Promise<void> {
  const session = getRelaySession(params.relaySessionId, params.connId);
  await session.voiceTranscriptWrites;
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
  broadcastToOwner(session.context, session.connId, {
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
export function cancelTalkRealtimeRelayTurn(params: {
  relaySessionId: string;
  connId: string;
  reason?: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  session.toolResultEpoch += 1;
  session.forcedTerminalProviderResults.clear();
  const turnId = ensureRelayTurn(session);
  const reason = params.reason ?? "client-cancelled";
  cancelForcedConsults(session);
  for (const callId of session.activeAgentToolCalls.keys()) {
    session.cancelledAgentToolCalls.set(callId, turnId);
  }
  for (const forcedConsult of session.harness.forcedConsults.handles()) {
    if (session.harness.forcedConsults.isCancelled(forcedConsult)) {
      session.cancelledAgentToolCalls.set(forcedConsult.id, turnId);
      for (const nativeCallId of session.harness.forcedConsults.nativeCallIds(forcedConsult)) {
        session.cancelledAgentToolCalls.set(nativeCallId, turnId);
      }
    }
  }
  session.harness.handleBargeIn({ audioPlaybackActive: true }, noFallbackRelayOutputFlush);
  abortRelayAgentRuns(session, reason);
  const cancelled = session.harness.talk.cancelTurn({
    turnId,
    payload: { reason },
  });
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "clear",
    talkEvent: cancelled.ok ? cancelled.event : undefined,
  });
}

/** Closes a realtime relay session owned by the current connection. */
export function stopTalkRealtimeRelaySession(params: {
  relaySessionId: string;
  connId: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  closeRelaySession(session, "completed");
}
