import { randomUUID } from "node:crypto";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import type { RealtimeTranscriptionProviderConfig } from "../realtime-transcription/provider-types.js";
import { recordTalkObservabilityEvent } from "../talk/observability.js";
import {
  type TalkEvent,
  type TalkEventInput,
  type TalkSessionController,
  createTalkSessionController,
} from "../talk/talk-session-controller.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

const TRANSCRIPTION_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_AUDIO_BASE64_BYTES = 512 * 1024;
const MAX_TRANSCRIPTION_SESSIONS_PER_CONN = 2;
const MAX_TRANSCRIPTION_SESSIONS_GLOBAL = 64;
const TRANSCRIPTION_EVENT = "talk.event";

type TalkTranscriptionRelayEventPayload =
  | { transcriptionSessionId: string; type: "ready" }
  | { transcriptionSessionId: string; type: "inputAudio"; byteLength: number }
  | { transcriptionSessionId: string; type: "partial"; text: string }
  | { transcriptionSessionId: string; type: "transcript"; text: string; final: true }
  | { transcriptionSessionId: string; type: "speechStart" }
  | { transcriptionSessionId: string; type: "error"; message: string }
  | { transcriptionSessionId: string; type: "close"; reason: "completed" | "error" };

type TalkTranscriptionRelayEvent = TalkTranscriptionRelayEventPayload & {
  talkEvent?: TalkEvent;
};

type TranscriptionRelaySession = {
  id: string;
  connId: string;
  context: GatewayRequestContext;
  provider: RealtimeTranscriptionProviderPlugin;
  sttSession: ReturnType<RealtimeTranscriptionProviderPlugin["createSession"]>;
  talk: TalkSessionController;
  expiresAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
  closed: boolean;
};

type CreateTalkTranscriptionRelaySessionParams = {
  context: GatewayRequestContext;
  connId: string;
  provider: RealtimeTranscriptionProviderPlugin;
  providerConfig: RealtimeTranscriptionProviderConfig;
};

type TalkTranscriptionRelaySessionResult = {
  provider: string;
  mode: "transcription";
  transport: "gateway-relay";
  transcriptionSessionId: string;
  audio: {
    inputEncoding: "pcm16";
    inputSampleRateHz: 24000;
  };
  expiresAt: number;
};

const transcriptionSessions = new Map<string, TranscriptionRelaySession>();

function broadcastToOwner(
  context: GatewayRequestContext,
  connId: string,
  event: TalkTranscriptionRelayEvent,
): void {
  context.broadcastToConnIds(TRANSCRIPTION_EVENT, event, new Set([connId]), { dropIfSlow: true });
}

function ensureTranscriptionTurn(session: TranscriptionRelaySession): string {
  const turn = session.talk.ensureTurn();
  if (turn.event) {
    broadcastToOwner(session.context, session.connId, {
      transcriptionSessionId: session.id,
      type: "speechStart",
      talkEvent: turn.event,
    });
  }
  return turn.turnId;
}

function closeTranscriptionSession(
  session: TranscriptionRelaySession,
  reason: "completed" | "error",
): void {
  if (session.closed) {
    return;
  }
  session.closed = true;
  transcriptionSessions.delete(session.id);
  clearTimeout(session.cleanupTimer);
  session.sttSession.close();
  broadcastToOwner(session.context, session.connId, {
    transcriptionSessionId: session.id,
    type: "close",
    reason,
    talkEvent: session.talk.emit({
      type: "session.closed",
      payload: { reason },
      final: true,
    }),
  });
}

function pruneExpiredTranscriptionSessions(nowMs = Date.now()): void {
  for (const session of transcriptionSessions.values()) {
    if (nowMs > session.expiresAtMs) {
      closeTranscriptionSession(session, "completed");
    }
  }
}

function countTranscriptionSessionsForConn(connId: string): number {
  let count = 0;
  for (const session of transcriptionSessions.values()) {
    if (session.connId === connId) {
      count += 1;
    }
  }
  return count;
}

function enforceTranscriptionSessionLimits(connId: string): void {
  pruneExpiredTranscriptionSessions();
  if (transcriptionSessions.size >= MAX_TRANSCRIPTION_SESSIONS_GLOBAL) {
    throw new Error("Too many active transcription Talk sessions");
  }
  if (countTranscriptionSessionsForConn(connId) >= MAX_TRANSCRIPTION_SESSIONS_PER_CONN) {
    throw new Error("Too many active transcription Talk sessions for this connection");
  }
}

export function createTalkTranscriptionRelaySession(
  params: CreateTalkTranscriptionRelaySessionParams,
): TalkTranscriptionRelaySessionResult {
  enforceTranscriptionSessionLimits(params.connId);
  const transcriptionSessionId = randomUUID();
  const expiresAtMs = Date.now() + TRANSCRIPTION_SESSION_TTL_MS;
  const talk = createTalkSessionController(
    {
      sessionId: transcriptionSessionId,
      mode: "transcription",
      transport: "gateway-relay",
      brain: "none",
      provider: params.provider.id,
    },
    { onEvent: recordTalkObservabilityEvent },
  );
  let relay: TranscriptionRelaySession | undefined;
  const emit = (event: TalkTranscriptionRelayEventPayload, talkEvent?: TalkEventInput): void => {
    broadcastToOwner(params.context, params.connId, {
      ...event,
      ...(talkEvent ? { talkEvent: talk.emit(talkEvent) } : {}),
    });
  };
  const ensureTurnId = (): string => {
    return relay ? ensureTranscriptionTurn(relay) : "turn-1";
  };
  const sttSession = params.provider.createSession({
    cfg: params.context.getRuntimeConfig(),
    providerConfig: params.providerConfig,
    onSpeechStart: () => {
      ensureTurnId();
    },
    onPartial: (text) => {
      const turnId = ensureTurnId();
      emit(
        { transcriptionSessionId, type: "partial", text },
        {
          type: "transcript.delta",
          turnId,
          payload: { text },
        },
      );
    },
    onTranscript: (text) => {
      const turnId = ensureTurnId();
      emit(
        { transcriptionSessionId, type: "transcript", text, final: true },
        {
          type: "transcript.done",
          turnId,
          payload: { text },
          final: true,
        },
      );
      if (relay) {
        const ended = relay.talk.endTurn({ turnId, payload: {} });
        if (ended.ok) {
          broadcastToOwner(relay.context, relay.connId, {
            transcriptionSessionId,
            type: "transcript",
            text: "",
            final: true,
            talkEvent: ended.event,
          });
        }
      }
    },
    onError: (error) => {
      emit(
        { transcriptionSessionId, type: "error", message: error.message },
        {
          type: "session.error",
          payload: { message: error.message },
          final: true,
        },
      );
      if (relay) {
        closeTranscriptionSession(relay, "error");
      }
    },
  });
  relay = {
    id: transcriptionSessionId,
    connId: params.connId,
    context: params.context,
    provider: params.provider,
    sttSession,
    talk,
    expiresAtMs,
    cleanupTimer: setTimeout(() => {
      const active = transcriptionSessions.get(transcriptionSessionId);
      if (active) {
        closeTranscriptionSession(active, "completed");
      }
    }, TRANSCRIPTION_SESSION_TTL_MS),
    closed: false,
  };
  relay.cleanupTimer.unref?.();
  transcriptionSessions.set(transcriptionSessionId, relay);
  sttSession
    .connect()
    .then(() => {
      emit({ transcriptionSessionId, type: "ready" }, { type: "session.ready", payload: null });
    })
    .catch((error: unknown) => {
      emit(
        {
          transcriptionSessionId,
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        },
        {
          type: "session.error",
          payload: { message: error instanceof Error ? error.message : String(error) },
          final: true,
        },
      );
      const active = transcriptionSessions.get(transcriptionSessionId);
      if (active) {
        closeTranscriptionSession(active, "error");
      }
    });

  return {
    provider: params.provider.id,
    mode: "transcription",
    transport: "gateway-relay",
    transcriptionSessionId,
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: 24000,
    },
    expiresAt: Math.floor(expiresAtMs / 1000),
  };
}

function getTranscriptionSession(
  transcriptionSessionId: string,
  connId: string,
): TranscriptionRelaySession {
  const session = transcriptionSessions.get(transcriptionSessionId);
  if (!session || session.connId !== connId || Date.now() > session.expiresAtMs) {
    if (session) {
      closeTranscriptionSession(session, "completed");
    }
    throw new Error("Unknown transcription Talk session");
  }
  return session;
}

export function sendTalkTranscriptionRelayAudio(params: {
  transcriptionSessionId: string;
  connId: string;
  audioBase64: string;
}): void {
  if (params.audioBase64.length > MAX_AUDIO_BASE64_BYTES) {
    throw new Error("Transcription Talk audio frame is too large");
  }
  const session = getTranscriptionSession(params.transcriptionSessionId, params.connId);
  const audio = Buffer.from(params.audioBase64, "base64");
  const turnId = ensureTranscriptionTurn(session);
  session.sttSession.sendAudio(audio);
  broadcastToOwner(session.context, session.connId, {
    transcriptionSessionId: session.id,
    type: "inputAudio",
    byteLength: audio.byteLength,
    talkEvent: session.talk.emit({
      type: "input.audio.delta",
      turnId,
      payload: { byteLength: audio.byteLength },
    }),
  });
}

export function stopTalkTranscriptionRelaySession(params: {
  transcriptionSessionId: string;
  connId: string;
}): void {
  const session = getTranscriptionSession(params.transcriptionSessionId, params.connId);
  if (session.talk.activeTurnId) {
    broadcastToOwner(session.context, session.connId, {
      transcriptionSessionId: session.id,
      type: "transcript",
      text: "",
      final: true,
      talkEvent: session.talk.emit({
        type: "input.audio.committed",
        turnId: session.talk.activeTurnId,
        payload: {},
        final: true,
      }),
    });
  }
  closeTranscriptionSession(session, "completed");
}

export function cancelTalkTranscriptionRelayTurn(params: {
  transcriptionSessionId: string;
  connId: string;
  reason?: string;
}): void {
  const session = getTranscriptionSession(params.transcriptionSessionId, params.connId);
  const turnId = ensureTranscriptionTurn(session);
  const cancelled = session.talk.cancelTurn({
    turnId,
    payload: { reason: params.reason ?? "client-cancelled" },
  });
  broadcastToOwner(session.context, session.connId, {
    transcriptionSessionId: session.id,
    type: "transcript",
    text: "",
    final: true,
    talkEvent: cancelled.ok ? cancelled.event : undefined,
  });
  closeTranscriptionSession(session, "completed");
}

export function clearTalkTranscriptionRelaySessionsForTest(): void {
  for (const session of transcriptionSessions.values()) {
    clearTimeout(session.cleanupTimer);
    session.sttSession.close();
  }
  transcriptionSessions.clear();
}
