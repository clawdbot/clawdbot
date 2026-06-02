import { randomUUID } from "node:crypto";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import type { OpenClawConfig } from "../config/types.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  buildRealtimeVoiceAgentConsultWorkingResponse,
} from "../talk/agent-consult-tool.js";
import {
  buildRealtimeVoiceAgentControlSpeechMessage,
  controlRealtimeVoiceAgentRun,
  shouldAutoControlRealtimeVoiceAgentText,
  type RealtimeVoiceAgentControlResult,
} from "../talk/agent-run-control.js";
import { readSpeakableRealtimeVoiceToolResult } from "../talk/consult-question.js";
import {
  createRealtimeVoiceForcedConsultCoordinator,
  type RealtimeVoiceForcedConsultCoordinator,
} from "../talk/forced-consult-coordinator.js";
import { recordTalkObservabilityEvent } from "../talk/observability.js";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceBrowserAudioContract,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceTool,
  type RealtimeVoiceToolResultOptions,
} from "../talk/provider-types.js";
import {
  isLikelyRealtimeVoiceAssistantEchoTranscript,
  recordRealtimeVoiceTranscript,
  type RealtimeVoiceTranscriptEntry,
} from "../talk/session-log-runtime.js";
import {
  createRealtimeVoiceBridgeSession,
  type RealtimeVoiceBridgeSession,
} from "../talk/session-runtime.js";
import {
  type TalkEvent,
  type TalkEventInput,
  type TalkSessionController,
  createTalkSessionController,
} from "../talk/talk-session-controller.js";
import { abortChatRunById } from "./chat-abort.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { forgetUnifiedTalkSession } from "./talk-session-registry.js";

const RELAY_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_AUDIO_BASE64_BYTES = 512 * 1024;
const MAX_RELAY_SESSIONS_PER_CONN = 2;
const MAX_RELAY_SESSIONS_GLOBAL = 64;
const RELAY_EVENT = "talk.event";
const RELAY_TRANSCRIPT_ECHO_LOOKBACK_MS = 12_000;
const FORCED_CONSULT_FALLBACK_DELAY_MS = 200;
const FORCED_CONSULT_RESULT_MAX_CHARS = 1_800;

type TalkRealtimeRelayEventPayload =
  | { relaySessionId: string; type: "ready" }
  | { relaySessionId: string; type: "inputAudio"; byteLength: number }
  | {
      relaySessionId: string;
      type: "audio";
      audioBase64: string;
      itemId?: string;
      responseId?: string;
    }
  | { relaySessionId: string; type: "audioDone"; itemId?: string; responseId?: string }
  | { relaySessionId: string; type: "clear" }
  | { relaySessionId: string; type: "mark"; markName: string }
  | {
      relaySessionId: string;
      type: "transcript";
      role: "user" | "assistant";
      text: string;
      final: boolean;
    }
  | {
      relaySessionId: string;
      type: "toolCall";
      itemId: string;
      callId: string;
      name: string;
      args: unknown;
      forced?: boolean;
    }
  | { relaySessionId: string; type: "toolResult"; callId: string }
  | { relaySessionId: string; type: "toolProgress"; result: RealtimeVoiceAgentControlResult }
  | { relaySessionId: string; type: "error"; message: string }
  | { relaySessionId: string; type: "close"; reason: "completed" | "error" };

type TalkRealtimeRelayEvent = TalkRealtimeRelayEventPayload & { talkEvent?: TalkEvent };

type RelaySession = {
  id: string;
  connId: string;
  context: GatewayRequestContext;
  bridge: RealtimeVoiceBridgeSession;
  talk: TalkSessionController;
  sessionKey?: string;
  expiresAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
  activeAgentRuns: Map<string, string>;
  activeAgentToolCalls: Map<string, string>;
  completedAgentToolCalls: Set<string>;
  forcedConsults: RealtimeVoiceForcedConsultCoordinator;
  transcript: RealtimeVoiceTranscriptEntry[];
};

type CreateTalkRealtimeRelaySessionParams = {
  context: GatewayRequestContext;
  connId: string;
  cfg?: OpenClawConfig;
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  instructions: string;
  tools: RealtimeVoiceTool[];
  model?: string;
  sessionKey?: string;
  voice?: string;
  forceAgentConsultOnFinalTranscript?: boolean;
};

type TalkRealtimeRelaySessionResult = {
  provider: string;
  transport: "gateway-relay";
  relaySessionId: string;
  audio: RealtimeVoiceBrowserAudioContract;
  model?: string;
  voice?: string;
  expiresAt: number;
};

const relaySessions = new Map<string, RelaySession>();

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWorkingToolResult(result: unknown): boolean {
  return (
    Boolean(result) &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    (result as Record<string, unknown>).status === "working"
  );
}

function isRelayAssistantEchoTranscript(session: RelaySession | undefined, text: string): boolean {
  if (!session) {
    return false;
  }
  return isLikelyRealtimeVoiceAssistantEchoTranscript({
    transcript: session.transcript,
    text,
    lookbackMs: RELAY_TRANSCRIPT_ECHO_LOOKBACK_MS,
  });
}
function buildForcedConsultCheckingPrompt(): string {
  return [
    "Briefly tell the person that you are checking with OpenClaw.",
    "Do not answer the request yet. Wait for the OpenClaw result before giving the actual answer.",
  ].join(" ");
}

function buildForcedConsultSpeechPrompt(text: string): string {
  return [
    "OpenClaw finished checking. Speak this result naturally and concisely.",
    "Do not mention tool calls, JSON, or internal routing.",
    "",
    text,
  ].join("\n");
}

function buildAlreadyDeliveredToolResult(): Record<string, string> {
  return {
    status: "already_delivered",
    message: "OpenClaw already delivered this consult result internally. Do not repeat it.",
  };
}

function cancelForcedConsults(session: RelaySession): void {
  for (const handle of session.forcedConsults.handles()) {
    session.forcedConsults.markCancelled(handle);
  }
}

function broadcastToOwner(
  context: GatewayRequestContext,
  connId: string,
  event: TalkRealtimeRelayEvent,
): void {
  context.broadcastToConnIds(RELAY_EVENT, event, new Set([connId]), { dropIfSlow: true });
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

function pruneInactiveRelayAgentRuns(session: RelaySession): number {
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

function broadcastToolResultToOwner(
  session: RelaySession,
  params: {
    callId: string;
    turnId: string;
    result: unknown;
    final: boolean;
    forced?: boolean;
  },
): void {
  const payload =
    params.forced === true
      ? { result: params.result, forced: true }
      : { result: params.result };
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "toolResult",
    callId: params.callId,
    talkEvent: session.talk.emit({
      type: "tool.result",
      callId: params.callId,
      turnId: params.turnId,
      payload,
      final: params.final,
    }),
  });
}

function submitRelayAgentControlProviderResults(
  session: RelaySession,
  result: RealtimeVoiceAgentControlResult,
  turnId: string,
): void {
  if (result.mode !== "cancel" || !result.ok || !result.providerResult) {
    return;
  }
  const activeCallIds = [...session.activeAgentToolCalls.keys()];
  for (const callId of activeCallIds) {
    const forcedConsult = session.forcedConsults.handles().find((handle) => handle.id === callId);
    if (forcedConsult) {
      session.forcedConsults.markCancelled(forcedConsult);
      for (const nativeCallId of session.forcedConsults.nativeCallIds(forcedConsult)) {
        session.bridge.submitToolResult(nativeCallId, result.providerResult, {
          suppressResponse: true,
        });
      }
    } else {
      session.bridge.submitToolResult(callId, result.providerResult, { suppressResponse: true });
    }
    broadcastToolResultToOwner(session, {
      callId,
      turnId,
      result: result.providerResult,
      final: true,
    });
    session.activeAgentToolCalls.delete(callId);
    session.completedAgentToolCalls.add(callId);
  }
  session.activeAgentRuns.clear();
}

function closeRelaySession(session: RelaySession, reason: "completed" | "error"): void {
  session.forcedConsults.clear();
  relaySessions.delete(session.id);
  forgetUnifiedTalkSession(session.id);
  clearTimeout(session.cleanupTimer);
  abortRelayAgentRuns(session, reason === "error" ? "relay-error" : "relay-closed");
  session.bridge.close();
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "close",
    reason,
    talkEvent: session.talk.emit({
      type: "session.closed",
      payload: { reason },
      final: true,
    }),
  });
}

function pruneExpiredRelaySessions(nowMs = Date.now()): void {
  const validNowMs = asDateTimestampMs(nowMs);
  if (validNowMs === undefined) {
    return;
  }
  for (const session of relaySessions.values()) {
    const expiresAtMs = asDateTimestampMs(session.expiresAtMs);
    if (expiresAtMs === undefined || validNowMs > expiresAtMs) {
      closeRelaySession(session, "completed");
    }
  }
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

function enforceRelaySessionLimits(connId: string): void {
  pruneExpiredRelaySessions();
  if (relaySessions.size >= MAX_RELAY_SESSIONS_GLOBAL) {
    throw new Error("Too many active realtime relay sessions");
  }
  if (countRelaySessionsForConn(connId) >= MAX_RELAY_SESSIONS_PER_CONN) {
    throw new Error("Too many active realtime relay sessions for this connection");
  }
}

export function createTalkRealtimeRelaySession(
  params: CreateTalkRealtimeRelaySessionParams,
): TalkRealtimeRelaySessionResult {
  enforceRelaySessionLimits(params.connId);
  const forceAgentConsultOnFinalTranscript = params.forceAgentConsultOnFinalTranscript === true;
  const relaySessionId = randomUUID();
  const expiresAtMs = resolveExpiresAtMsFromDurationMs(RELAY_SESSION_TTL_MS);
  if (expiresAtMs === undefined) {
    throw new Error("Realtime relay session expiry is outside the supported Date range");
  }
  const talk = createTalkSessionController(
    {
      sessionId: relaySessionId,
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: params.provider.id,
    },
    { onEvent: recordTalkObservabilityEvent },
  );
  const emit = (event: TalkRealtimeRelayEventPayload, talkEvent?: TalkEventInput) =>
    broadcastToOwner(params.context, params.connId, {
      ...event,
      ...(talkEvent ? { talkEvent: talk.emit(talkEvent) } : {}),
    });
  let currentOutputItemId: string | undefined;
  let currentOutputResponseId: string | undefined;
  const relayRef: { current?: RelaySession } = {};
  const bridge = createRealtimeVoiceBridgeSession({
    provider: params.provider,
    cfg: params.cfg,
    providerConfig: params.providerConfig,
    audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    instructions: params.instructions,
    autoRespondToAudio: !forceAgentConsultOnFinalTranscript,
    interruptResponseOnInputAudio: !forceAgentConsultOnFinalTranscript,
    tools: params.tools,
    markStrategy: "ack-immediately",
    audioSink: {
      isOpen: () => Boolean(relayRef.current && relaySessions.has(relayRef.current.id)),
      sendAudio: (audio) => {
        const turnId = relayRef.current ? ensureRelayTurn(relayRef.current) : undefined;
        emit(
          {
            relaySessionId,
            type: "audio",
            audioBase64: audio.toString("base64"),
            ...(currentOutputItemId ? { itemId: currentOutputItemId } : {}),
            ...(currentOutputResponseId ? { responseId: currentOutputResponseId } : {}),
          },
          {
            type: "output.audio.delta",
            turnId,
            payload: { byteLength: audio.length },
          },
        );
      },
      clearAudio: () => {
        const turnId = relayRef.current ? ensureRelayTurn(relayRef.current) : undefined;
        emit(
          { relaySessionId, type: "clear" },
          {
            type: "output.audio.done",
            turnId,
            payload: { reason: "clear" },
            final: true,
          },
        );
      },
      sendMark: (markName) => {
        const turnId = relayRef.current ? ensureRelayTurn(relayRef.current) : undefined;
        emit(
          { relaySessionId, type: "mark", markName },
          {
            type: "output.audio.done",
            turnId,
            payload: { markName },
            final: true,
          },
        );
      },
    },
    onEvent: (event) => {
      if (event.direction !== "server") {
        return;
      }
      if (
        event.type === "conversation.output_audio.delta" ||
        event.type === "response.audio.delta" ||
        event.type === "response.output_audio.delta"
      ) {
        currentOutputItemId = event.itemId ?? currentOutputItemId;
        currentOutputResponseId = event.responseId ?? currentOutputResponseId;
        return;
      }
      if (
        event.type === "response.audio.done" ||
        event.type === "response.output_audio.done" ||
        event.type === "conversation.output_audio.done" ||
        event.type === "response.done" ||
        event.type === "response.cancelled"
      ) {
        emit({
          relaySessionId,
          type: "audioDone",
          ...((event.itemId ?? currentOutputItemId)
            ? { itemId: event.itemId ?? currentOutputItemId }
            : {}),
          ...((event.responseId ?? currentOutputResponseId)
            ? { responseId: event.responseId ?? currentOutputResponseId }
            : {}),
        });
        currentOutputItemId = undefined;
        currentOutputResponseId = undefined;
      }
    },
    onTranscript: (role, text, final) => {
      const relay = relayRef.current;
      const turnId = relay ? ensureRelayTurn(relay) : undefined;
      if (final && relay) {
        recordRealtimeVoiceTranscript(relay.transcript, role, text);
      }
      const eventType =
        role === "assistant"
          ? final
            ? "output.text.done"
            : "output.text.delta"
          : final
            ? "transcript.done"
            : "transcript.delta";
      const payload = role === "assistant" ? { text } : { role, text };
      emit(
        { relaySessionId, type: "transcript", role, text, final },
        {
          type: eventType,
          turnId,
          payload,
          final,
        },
      );
      if (role === "user" && final && text.trim()) {
        const question = text.trim();
        if (isRelayAssistantEchoTranscript(relay, question)) {
          return;
        }
        if (
          relay &&
          pruneInactiveRelayAgentRuns(relay) > 0 &&
          shouldAutoControlRealtimeVoiceAgentText(question)
        ) {
          void steerTalkRealtimeRelayAgentRun({
            relaySessionId,
            connId: params.connId,
            text: question,
          })
            .then((result) => {
              if (result.speak && !result.suppress && result.message.trim()) {
                bridge.sendUserMessage(buildRealtimeVoiceAgentControlSpeechMessage(result.message));
              }
            })
            .catch((error: unknown) => {
              emit(
                { relaySessionId, type: "error", message: formatError(error) },
                {
                  type: "session.error",
                  payload: { message: formatError(error) },
                  final: true,
                },
              );
            });
          return;
        }
        if (forceAgentConsultOnFinalTranscript) {
          scheduleForcedAgentConsult(relay, question);
        }
      }
    },
    onToolCall: (toolCall) => {
      const relay = relayRef.current;
      const turnId = relay ? ensureRelayTurn(relay) : undefined;
      if (relay && toolCall.name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
        const forcedConsult = relay.forcedConsults.recordNativeConsult(
          toolCall.args,
          toolCall.callId,
        );
        if (forcedConsult.kind === "in_flight" || forcedConsult.kind === "already_delivered") {
          if (forcedConsult.kind === "already_delivered") {
            submitAlreadyDeliveredToolResult(relay, toolCall.callId, turnId);
          } else {
            submitRealtimeAgentConsultWorkingResponse(relay, toolCall.callId, turnId);
          }
          return;
        }
        submitRealtimeAgentConsultWorkingResponse(relay, toolCall.callId, turnId);
      }
      emit(
        {
          relaySessionId,
          type: "toolCall",
          itemId: toolCall.itemId,
          callId: toolCall.callId,
          name: toolCall.name,
          args: toolCall.args,
        },
        {
          type: "tool.call",
          itemId: toolCall.itemId,
          callId: toolCall.callId,
          turnId,
          payload: { name: toolCall.name, args: toolCall.args },
        },
      );
    },
    onReady: () =>
      emit({ relaySessionId, type: "ready" }, { type: "session.ready", payload: null }),
    onError: (error) =>
      emit(
        { relaySessionId, type: "error", message: error.message },
        { type: "session.error", payload: { message: error.message }, final: true },
      ),
    onClose: (reason) => {
      const active = relaySessions.get(relaySessionId);
      if (!active) {
        return;
      }
      active.forcedConsults.clear();
      relaySessions.delete(relaySessionId);
      forgetUnifiedTalkSession(relaySessionId);
      clearTimeout(active.cleanupTimer);
      abortRelayAgentRuns(active, "relay-closed");
      emit(
        { relaySessionId, type: "close", reason },
        { type: "session.closed", payload: { reason }, final: true },
      );
    },
  });
  const relay: RelaySession = {
    id: relaySessionId,
    connId: params.connId,
    context: params.context,
    bridge,
    talk,
    sessionKey: params.sessionKey?.trim() || undefined,
    expiresAtMs,
    cleanupTimer: setTimeout(() => {
      const active = relaySessions.get(relaySessionId);
      if (active) {
        closeRelaySession(active, "completed");
      }
    }, RELAY_SESSION_TTL_MS),
    activeAgentRuns: new Map(),
    activeAgentToolCalls: new Map(),
    completedAgentToolCalls: new Set(),
    forcedConsults: createRealtimeVoiceForcedConsultCoordinator(),
    transcript: [],
  };
  relayRef.current = relay;
  relay.cleanupTimer.unref?.();
  relaySessions.set(relaySessionId, relay);
  bridge.connect().catch((error: unknown) => {
    emit({ relaySessionId, type: "error", message: formatError(error) });
    const active = relaySessions.get(relaySessionId);
    if (active) {
      closeRelaySession(active, "error");
    }
  });

  return {
    provider: params.provider.id,
    transport: "gateway-relay",
    relaySessionId,
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
      outputEncoding: "pcm16",
      outputSampleRateHz: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ.sampleRateHz,
    },
    ...(params.model ? { model: params.model } : {}),
    ...(params.voice ? { voice: params.voice } : {}),
    expiresAt: Math.floor(expiresAtMs / 1000),
  };
}

function scheduleForcedAgentConsult(session: RelaySession | undefined, question: string): void {
  if (!session || !question.trim()) {
    return;
  }
  if (session.forcedConsults.hasRecentNativeConsult(question)) {
    return;
  }
  session.forcedConsults.clearPending();
  const handle = session.forcedConsults.prepare(question);
  if (!handle) {
    return;
  }
  session.forcedConsults.schedule(handle, FORCED_CONSULT_FALLBACK_DELAY_MS, () => {
    if (!relaySessions.has(session.id)) {
      return;
    }
    const turnId = ensureRelayTurn(session);
    const callId = handle.id;
    const itemId = `forced-consult-item-${randomUUID()}`;
    session.forcedConsults.markStarted(handle);
    session.bridge.handleBargeIn({ audioPlaybackActive: true, force: true });
    broadcastToOwner(session.context, session.connId, {
      relaySessionId: session.id,
      type: "toolCall",
      itemId,
      callId,
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      forced: true,
      args: {
        question: handle.question,
        context:
          "The realtime provider produced a final user transcript without invoking openclaw_agent_consult, so OpenClaw is forcing the consult for realtime Talk.",
        responseStyle: "Reply in a concise spoken tone.",
      },
      talkEvent: session.talk.emit({
        type: "tool.call",
        itemId,
        callId,
        turnId,
        payload: {
          name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
          args: { question: handle.question },
          forced: true,
        },
      }),
    });
  });
}

function submitAlreadyDeliveredToolResult(
  session: RelaySession,
  callId: string,
  turnId = ensureRelayTurn(session),
): void {
  const result = buildAlreadyDeliveredToolResult();
  session.bridge.submitToolResult(callId, result, { suppressResponse: true });
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "toolResult",
    callId,
    talkEvent: session.talk.emit({
      type: "tool.result",
      callId,
      turnId,
      payload: { name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, result },
      final: true,
    }),
  });
}

function submitRealtimeAgentConsultWorkingResponse(
  session: RelaySession,
  callId: string,
  turnId = ensureRelayTurn(session),
): void {
  if (!session.bridge.bridge.supportsToolResultContinuation) {
    return;
  }
  session.bridge.submitToolResult(callId, buildRealtimeVoiceAgentConsultWorkingResponse("person"), {
    willContinue: true,
  });
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "toolResult",
    callId,
    talkEvent: session.talk.emit({
      type: "tool.progress",
      callId,
      turnId,
      payload: { name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, status: "working" },
    }),
  });
}

function ensureRelayTurn(session: RelaySession): string {
  const turn = session.talk.ensureTurn();
  if (turn.event) {
    broadcastToOwner(session.context, session.connId, {
      relaySessionId: session.id,
      type: "inputAudio",
      byteLength: 0,
      talkEvent: turn.event,
    });
  }
  return turn.turnId;
}

function getRelaySession(relaySessionId: string, connId: string): RelaySession {
  const session = relaySessions.get(relaySessionId);
  const nowMs = asDateTimestampMs(Date.now());
  const expiresAtMs = session ? asDateTimestampMs(session.expiresAtMs) : undefined;
  if (
    !session ||
    session.connId !== connId ||
    nowMs === undefined ||
    expiresAtMs === undefined ||
    nowMs > expiresAtMs
  ) {
    if (session) {
      closeRelaySession(session, "completed");
    }
    throw new Error("Unknown realtime relay session");
  }
  return session;
}

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
  const turnId = ensureRelayTurn(session);
  const audio = Buffer.from(params.audioBase64, "base64");
  session.bridge.sendAudio(audio);
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "inputAudio",
    byteLength: audio.byteLength,
    talkEvent: session.talk.emit({
      type: "input.audio.delta",
      turnId,
      payload: { byteLength: audio.byteLength },
    }),
  });
  if (typeof params.timestamp === "number" && Number.isFinite(params.timestamp)) {
    session.bridge.setMediaTimestamp(params.timestamp);
  }
}

export function submitTalkRealtimeRelayToolResult(params: {
  relaySessionId: string;
  connId: string;
  callId: string;
  result: unknown;
  options?: RealtimeVoiceToolResultOptions;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  if (session.completedAgentToolCalls.has(params.callId)) {
    return;
  }
  const forcedConsult = session.forcedConsults
    .handles()
    .find((handle) => handle.id === params.callId);
  if (forcedConsult) {
    const turnId = ensureRelayTurn(session);
    const cancelled = session.forcedConsults.isCancelled(forcedConsult);
    if (cancelled) {
      if (params.options?.willContinue !== true) {
        session.forcedConsults.markCancelled(forcedConsult);
      }
    } else if (isWorkingToolResult(params.result)) {
      session.bridge.sendUserMessage(buildForcedConsultCheckingPrompt());
    } else {
      session.forcedConsults.markDelivered(forcedConsult);
      const text = readSpeakableRealtimeVoiceToolResult(params.result, {
        maxChars: FORCED_CONSULT_RESULT_MAX_CHARS,
      });
      for (const nativeCallId of session.forcedConsults.nativeCallIds(forcedConsult)) {
        submitAlreadyDeliveredToolResult(session, nativeCallId, turnId);
      }
      if (text) {
        session.bridge.sendUserMessage(buildForcedConsultSpeechPrompt(text));
      }
    }
    const final = params.options?.willContinue !== true;
    if (final && !cancelled && !isWorkingToolResult(params.result)) {
      session.forcedConsults.markDelivered(forcedConsult);
    }
    broadcastToolResultToOwner(session, {
      callId: params.callId,
      turnId,
      result: params.result,
      forced: true,
      final,
    });
    return;
  }
  session.bridge.submitToolResult(params.callId, params.result, params.options);
  const turnId = ensureRelayTurn(session);
  const final = params.options?.willContinue !== true;
  if (final) {
    const runId = session.activeAgentToolCalls.get(params.callId);
    if (runId) {
      session.activeAgentRuns.delete(runId);
      session.activeAgentToolCalls.delete(params.callId);
    }
  }
  broadcastToolResultToOwner(session, {
    callId: params.callId,
    turnId,
    result: params.result,
    final,
  });
}

export function registerTalkRealtimeRelayAgentRun(params: {
  relaySessionId: string;
  connId: string;
  sessionKey: string;
  runId: string;
  callId?: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  session.activeAgentRuns.set(params.runId, params.sessionKey);
  if (params.callId?.trim()) {
    session.activeAgentToolCalls.set(params.callId.trim(), params.runId);
  }
  if (!session.sessionKey) {
    session.sessionKey = params.sessionKey;
  }
}

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
    recentEvents: session.talk.recentEvents,
  });
  const turnId = ensureRelayTurn(session);
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "toolProgress",
    result,
    talkEvent: session.talk.emit({
      type: "tool.progress",
      turnId,
      payload: {
        name: "openclaw_agent_control",
        phase: result.mode,
        result,
      },
      final: result.mode === "cancel" || result.mode === "status",
    }),
  });
  submitRelayAgentControlProviderResults(session, result, turnId);
  return result;
}

export function cancelTalkRealtimeRelayTurn(params: {
  relaySessionId: string;
  connId: string;
  reason?: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  const turnId = ensureRelayTurn(session);
  const reason = params.reason ?? "client-cancelled";
  cancelForcedConsults(session);
  session.bridge.handleBargeIn({ audioPlaybackActive: true });
  abortRelayAgentRuns(session, reason);
  const cancelled = session.talk.cancelTurn({
    turnId,
    payload: { reason },
  });
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "clear",
    talkEvent: cancelled.ok ? cancelled.event : undefined,
  });
}

export function stopTalkRealtimeRelaySession(params: {
  relaySessionId: string;
  connId: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  closeRelaySession(session, "completed");
}

export function clearTalkRealtimeRelaySessionsForTest(): void {
  for (const session of relaySessions.values()) {
    session.forcedConsults.clear();
    clearTimeout(session.cleanupTimer);
    forgetUnifiedTalkSession(session.id);
    session.bridge.close();
  }
  relaySessions.clear();
}
