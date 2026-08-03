/**
 * Tests talk transcription relay behavior between realtime events and clients.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import type { RealtimeTranscriptionSessionCreateRequest } from "../realtime-transcription/provider-types.js";
import { getUnifiedTalkSession, rememberUnifiedTalkSession } from "./talk-session-registry.js";
import {
  cancelTalkTranscriptionRelayTurn,
  closeTalkTranscriptionRelaySessionsForConnection,
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
  const logGateway = { warn: vi.fn() };
  const context = {
    getRuntimeConfig: () => ({}),
    logGateway,
    broadcastToConnIds: (event: string, payload: unknown, connIds: ReadonlySet<string>) => {
      events.push({ event, payload, connIds: [...connIds] });
    },
  } as never;
  return { context, events, logGateway };
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

  it("closes only transcription relays owned by the disconnected connection", async () => {
    const firstOwned = createSttSessionMock();
    const secondOwned = createSttSessionMock(async () => {
      throw new Error("late connect failure");
    });
    const unrelated = createSttSessionMock();
    const requests: RealtimeTranscriptionSessionCreateRequest[] = [];
    const { context, events, logGateway } = createBroadcastContext();
    const createSession = (connId: string, sttSession: ReturnType<typeof createSttSessionMock>) =>
      createTalkTranscriptionRelaySession({
        context,
        connId,
        provider: createTranscriptionProvider(sttSession, (request) => requests.push(request)),
        providerConfig: {},
      });
    const firstSession = createSession("conn-owner", firstOwned);
    const secondSession = createSession("conn-owner", secondOwned);
    const unrelatedSession = createSession("conn-other", unrelated);
    for (const session of [firstSession, secondSession]) {
      rememberUnifiedTalkSession(session.transcriptionSessionId, {
        kind: "transcription-relay",
        connId: "conn-owner",
        transcriptionSessionId: session.transcriptionSessionId,
      });
    }
    firstOwned.close.mockImplementationOnce(() => {
      throw new Error("provider close failed");
    });

    expect(() => closeTalkTranscriptionRelaySessionsForConnection("conn-owner")).not.toThrow();
    closeTalkTranscriptionRelaySessionsForConnection("conn-owner");
    await Promise.resolve();
    await Promise.resolve();

    expect(firstOwned.close).toHaveBeenCalledOnce();
    expect(secondOwned.close).toHaveBeenCalledOnce();
    expect(unrelated.close).not.toHaveBeenCalled();
    expect(logGateway.warn).toHaveBeenCalledWith(
      "failed to close transcription relay session after connection disconnect: provider close failed",
    );
    for (const transcriptionSessionId of [
      firstSession.transcriptionSessionId,
      secondSession.transcriptionSessionId,
    ]) {
      expect(
        events.some(
          (event) =>
            isRecord(event.payload) &&
            event.payload.transcriptionSessionId === transcriptionSessionId &&
            event.payload.type === "close" &&
            isRecord(event.payload.talkEvent) &&
            event.payload.talkEvent.type === "session.closed" &&
            event.payload.talkEvent.final === true,
        ),
      ).toBe(true);
      expect(() =>
        sendTalkTranscriptionRelayAudio({
          transcriptionSessionId,
          connId: "conn-owner",
          audioBase64: "AQI=",
        }),
      ).toThrow("Unknown transcription Talk session");
      expect(() => getUnifiedTalkSession(transcriptionSessionId)).toThrow("Unknown Talk session");
    }
    expect(
      events.some(
        (event) =>
          isRecord(event.payload) &&
          (event.payload.transcriptionSessionId === firstSession.transcriptionSessionId ||
            event.payload.transcriptionSessionId === secondSession.transcriptionSessionId) &&
          (event.payload.type === "ready" || event.payload.type === "error"),
      ),
    ).toBe(false);
    const eventCountAfterClose = events.length;
    requests[0]?.onSpeechStart?.();
    requests[0]?.onPartial?.("late partial");
    requests[0]?.onTranscript?.("late transcript");
    requests[0]?.onError?.(new Error("late provider error"));
    await Promise.resolve();
    expect(events).toHaveLength(eventCountAfterClose);

    sendTalkTranscriptionRelayAudio({
      transcriptionSessionId: unrelatedSession.transcriptionSessionId,
      connId: "conn-other",
      audioBase64: "AQI=",
    });
    expect(unrelated.sendAudio).toHaveBeenCalledOnce();
    stopTalkTranscriptionRelaySession({
      transcriptionSessionId: unrelatedSession.transcriptionSessionId,
      connId: "conn-other",
    });
    closeTalkTranscriptionRelaySessionsForConnection("conn-other");
    expect(unrelated.close).toHaveBeenCalledOnce();
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
