import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../config/types.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import { recordTalkObservabilityEvent } from "../talk/observability.js";
import {
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  type RealtimeVoiceBrowserAudioContract,
  type RealtimeVoiceProviderConfig,
  type RealtimeVoiceTool,
  type RealtimeVoiceToolResultOptions,
} from "../talk/provider-types.js";
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

type TalkRealtimeRelayEventPayload =
  | { relaySessionId: string; type: "ready" }
  | { relaySessionId: string; type: "inputAudio"; byteLength: number }
  | { relaySessionId: string; type: "audio"; audioBase64: string }
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
    }
  | { relaySessionId: string; type: "toolResult"; callId: string }
  | { relaySessionId: string; type: "error"; message: string }
  | { relaySessionId: string; type: "close"; reason: "completed" | "error" };

type TalkRealtimeRelayEvent = TalkRealtimeRelayEventPayload & { talkEvent?: TalkEvent };

type RelaySession = {
  id: string;
  connId: string;
  context: GatewayRequestContext;
  bridge: RealtimeVoiceBridgeSession;
  talk: TalkSessionController;
  expiresAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
  activeAgentRuns: Map<string, string>;
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
  voice?: string;
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
}

function closeRelaySession(session: RelaySession, reason: "completed" | "error"): void {
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
  for (const session of relaySessions.values()) {
    if (nowMs > session.expiresAtMs) {
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
  const relaySessionId = randomUUID();
  const expiresAtMs = Date.now() + RELAY_SESSION_TTL_MS;
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
  let relay: RelaySession | undefined;
  const emit = (event: TalkRealtimeRelayEventPayload, talkEvent?: TalkEventInput) =>
    broadcastToOwner(params.context, params.connId, {
      ...event,
      ...(talkEvent ? { talkEvent: talk.emit(talkEvent) } : {}),
    });
  const bridge = createRealtimeVoiceBridgeSession({
    provider: params.provider,
    cfg: params.cfg,
    providerConfig: params.providerConfig,
    audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    instructions: params.instructions,
    tools: params.tools,
    markStrategy: "ack-immediately",
    audioSink: {
      isOpen: () => Boolean(relay && relaySessions.has(relay.id)),
      sendAudio: (audio) => {
        const turnId = relay ? ensureRelayTurn(relay) : undefined;
        emit(
          {
            relaySessionId,
            type: "audio",
            audioBase64: audio.toString("base64"),
          },
          {
            type: "output.audio.delta",
            turnId,
            payload: { byteLength: audio.length },
          },
        );
      },
      clearAudio: () => {
        const turnId = relay ? ensureRelayTurn(relay) : undefined;
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
        const turnId = relay ? ensureRelayTurn(relay) : undefined;
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
    onTranscript: (role, text, final) => {
      const turnId = relay ? ensureRelayTurn(relay) : undefined;
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
    },
    onToolCall: (toolCall) => {
      const turnId = relay ? ensureRelayTurn(relay) : undefined;
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
  relay = {
    id: relaySessionId,
    connId: params.connId,
    context: params.context,
    bridge,
    talk,
    expiresAtMs,
    cleanupTimer: setTimeout(() => {
      const active = relaySessions.get(relaySessionId);
      if (active) {
        closeRelaySession(active, "completed");
      }
    }, RELAY_SESSION_TTL_MS),
    activeAgentRuns: new Map(),
  };
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
  if (!session || session.connId !== connId || Date.now() > session.expiresAtMs) {
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
  session.bridge.submitToolResult(params.callId, params.result, params.options);
  const turnId = ensureRelayTurn(session);
  const final = params.options?.willContinue !== true;
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "toolResult",
    callId: params.callId,
    talkEvent: session.talk.emit({
      type: "tool.result",
      callId: params.callId,
      turnId,
      payload: { result: params.result },
      final,
    }),
  });
}

export function registerTalkRealtimeRelayAgentRun(params: {
  relaySessionId: string;
  connId: string;
  sessionKey: string;
  runId: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  session.activeAgentRuns.set(params.runId, params.sessionKey);
}

export function cancelTalkRealtimeRelayTurn(params: {
  relaySessionId: string;
  connId: string;
  reason?: string;
}): void {
  const session = getRelaySession(params.relaySessionId, params.connId);
  const turnId = ensureRelayTurn(session);
  const reason = params.reason ?? "client-cancelled";
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
    clearTimeout(session.cleanupTimer);
    forgetUnifiedTalkSession(session.id);
    session.bridge.close();
  }
  relaySessions.clear();
}
