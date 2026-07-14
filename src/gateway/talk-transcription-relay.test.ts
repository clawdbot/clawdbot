/**
 * Tests talk transcription relay behavior between realtime events and clients.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import type { RealtimeTranscriptionSessionCreateRequest } from "../realtime-transcription/provider-types.js";
import {
  cancelTalkTranscriptionRelayTurn,
  createTalkTranscriptionRelaySession,
  sendTalkTranscriptionRelayAudio,
  stopTalkTranscriptionRelaySession,
} from "./talk-transcription-relay.js";
import { expectRecordFields, isRecord, requireRecord } from "./test-helpers.assertions.js";

type BroadcastEvent = { event: string; payload: unknown; connIds: string[] };

function createSttSessionMock(connect: () => Promise<void> = async () => {}) {
  return {
    connect: vi.fn(connect),
    sendAudio: vi.fn(),
    close: vi.fn(),
    isConnected: vi.fn(() => true),
  };
}

function createTranscriptionProvider(
  sttSession: ReturnType<typeof createSttSessionMock>,
  onRequest?: (req: RealtimeTranscriptionSessionCreateRequest) => void,
): RealtimeTranscriptionProviderPlugin {
  return {
    id: "stt-test",
    label: "STT Test",
    isConfigured: () => true,
    createSession: vi.fn((req) => {
      onRequest?.(req);
      return sttSession;
    }),
  };
}

function createBroadcastContext() {
  const events: BroadcastEvent[] = [];
  const context = {
    getRuntimeConfig: () => ({}),
    broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
      events.push({ event, payload, connIds: [...connIds] });
    },
  } as never;
  return { context, events };
}

async function createStartedRelaySession(
  sttSession: ReturnType<typeof createSttSessionMock>,
  providerConfig: Record<string, unknown>,
  onRequest?: (req: RealtimeTranscriptionSessionCreateRequest) => void,
) {
  const provider = createTranscriptionProvider(sttSession, onRequest);
  const { context, events } = createBroadcastContext();
  const session = createTalkTranscriptionRelaySession({
    context,
    connId: "conn-1",
    provider,
    providerConfig,
  });
  await Promise.resolve();
  return { provider, events, session };
}

function findPayloadByType(events: BroadcastEvent[], type: string): Record<string, unknown> {
  const event = events.find((candidate) => {
    const payload = candidate.payload;
    return isRecord(payload) && payload.type === type;
  });
  if (!event) {
    throw new Error(`expected relay event type ${type}`);
  }
  expect(event.event).toBe("talk.event");
  return requireRecord(event.payload, `${type} payload`);
}

function findPayloadByTalkEventType(
  events: BroadcastEvent[],
  type: string,
): Record<string, unknown> {
  const event = events.find((candidate) => {
    const payload = candidate.payload;
    return isRecord(payload) && isRecord(payload.talkEvent) && payload.talkEvent.type === type;
  });
  if (!event) {
    throw new Error(`expected talk event type ${type}`);
  }
  return requireRecord(event.payload, `${type} payload`);
}

function expectTalkEventFields(
  payload: Record<string, unknown>,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  return expectRecordFields(payload.talkEvent, "talk event", expected);
}

describe("talk transcription gateway relay", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bridges browser audio into a transcription-only Talk event stream", async () => {
    let sttRequest: RealtimeTranscriptionSessionCreateRequest | undefined;
    const sttSession = createSttSessionMock(async () => {
      sttRequest?.onSpeechStart?.();
      sttRequest?.onPartial?.("hel");
      sttRequest?.onTranscript?.("hello world");
    });
    const { events, session } = await createStartedRelaySession(
      sttSession,
      { model: "stt-model" },
      (req) => {
        sttRequest = req;
      },
    );

    expectRecordFields(session, "session", {
      provider: "stt-test",
      mode: "transcription",
      transport: "gateway-relay",
    });
    expectRecordFields(session.audio, "session audio", {
      inputEncoding: "g711_ulaw",
      inputSampleRateHz: 8000,
    });
    expectRecordFields(sttRequest, "stt request", {
      providerConfig: { model: "stt-model" },
    });

    sendTalkTranscriptionRelayAudio({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
      audioBase64: Buffer.from("audio-in").toString("base64"),
    });
    stopTalkTranscriptionRelaySession({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
    });

    expect(sttSession.sendAudio).toHaveBeenCalledWith(Buffer.from("audio-in"));
    expect(sttSession.close).toHaveBeenCalledOnce();
    const readyPayload = findPayloadByType(events, "ready");
    expect(events.find((event) => event.payload === readyPayload)?.connIds).toEqual(["conn-1"]);
    expectRecordFields(readyPayload, "ready payload", {
      transcriptionSessionId: session.transcriptionSessionId,
      type: "ready",
    });
    expectTalkEventFields(readyPayload, {
      sessionId: session.transcriptionSessionId,
      type: "session.ready",
      mode: "transcription",
      transport: "gateway-relay",
      brain: "none",
      provider: "stt-test",
    });

    const speechStartPayload = findPayloadByType(events, "speechStart");
    expectRecordFields(speechStartPayload, "speechStart payload", {
      transcriptionSessionId: session.transcriptionSessionId,
      type: "speechStart",
    });
    expectTalkEventFields(speechStartPayload, { type: "turn.started", turnId: "turn-1" });

    const partialPayload = findPayloadByType(events, "partial");
    expectRecordFields(partialPayload, "partial payload", {
      transcriptionSessionId: session.transcriptionSessionId,
      type: "partial",
      text: "hel",
    });
    expectTalkEventFields(partialPayload, {
      type: "transcript.delta",
      turnId: "turn-1",
      payload: { text: "hel" },
    });

    const transcriptPayload = findPayloadByType(events, "transcript");
    expectRecordFields(transcriptPayload, "transcript payload", {
      transcriptionSessionId: session.transcriptionSessionId,
      type: "transcript",
      text: "hello world",
      final: true,
    });
    expectTalkEventFields(transcriptPayload, {
      type: "transcript.done",
      turnId: "turn-1",
      final: true,
      payload: { text: "hello world" },
    });

    const audioPayload = findPayloadByType(events, "inputAudio");
    expectRecordFields(audioPayload, "input audio payload", {
      transcriptionSessionId: session.transcriptionSessionId,
      type: "inputAudio",
      byteLength: 8,
    });
    expectTalkEventFields(audioPayload, { type: "input.audio.delta" });

    const closePayload = findPayloadByType(events, "close");
    expectRecordFields(closePayload, "close payload", {
      transcriptionSessionId: session.transcriptionSessionId,
      type: "close",
      reason: "completed",
    });
    expectTalkEventFields(closePayload, {
      type: "session.closed",
      final: true,
    });
  });

  it("rejects provider configs that do not match relay audio input", () => {
    const provider = createTranscriptionProvider(createSttSessionMock());
    const { context } = createBroadcastContext();

    expect(() =>
      createTalkTranscriptionRelaySession({
        context,
        connId: "conn-1",
        provider,
        providerConfig: { encoding: "linear16", sampleRate: 16000 },
      }),
    ).toThrow("Gateway transcription relay requires g711_ulaw/8000 audio");
    expect(provider.createSession).not.toHaveBeenCalled();
  });

  it("rejects session creation when transcription expiry would exceed Date range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(8_640_000_000_000_000));
    const provider = createTranscriptionProvider(createSttSessionMock());
    const { context } = createBroadcastContext();

    expect(() =>
      createTalkTranscriptionRelaySession({
        context,
        connId: "conn-1",
        provider,
        providerConfig: {},
      }),
    ).toThrow("Transcription relay session expiry is outside the supported Date range");
    expect(provider.createSession).not.toHaveBeenCalled();
  });

  it("cancels an active transcription turn and closes the provider session", async () => {
    let sttRequest: RealtimeTranscriptionSessionCreateRequest | undefined;
    const sttSession = createSttSessionMock(async () => {
      sttRequest?.onSpeechStart?.();
    });
    const { events, session } = await createStartedRelaySession(sttSession, {}, (req) => {
      sttRequest = req;
    });

    cancelTalkTranscriptionRelayTurn({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
      reason: "barge-in",
    });

    expect(sttSession.close).toHaveBeenCalledOnce();
    const cancelledPayload = findPayloadByTalkEventType(events, "turn.cancelled");
    expectRecordFields(cancelledPayload, "cancelled payload", {
      transcriptionSessionId: session.transcriptionSessionId,
    });
    expectTalkEventFields(cancelledPayload, {
      type: "turn.cancelled",
      turnId: "turn-1",
      payload: { reason: "barge-in" },
      final: true,
    });

    const closePayload = findPayloadByType(events, "close");
    expectRecordFields(closePayload, "close payload", {
      transcriptionSessionId: session.transcriptionSessionId,
      type: "close",
      reason: "completed",
    });
  });
});
