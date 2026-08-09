/**
 * Tests talk transcription relay behavior between realtime events and clients.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTranscriptionProviderPlugin } from "../plugins/types.js";
import type { RealtimeTranscriptionSessionCreateRequest } from "../realtime-transcription/provider-types.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import {
  cleanupTalkConnection,
  getUnifiedTalkSession,
  rememberUnifiedTalkSession,
} from "./talk-session-registry.js";
import {
  cancelTalkTranscriptionRelayTurn,
  createTalkTranscriptionRelaySession,
  sendTalkTranscriptionRelayAudio,
  stopTalkTranscriptionRelaySession,
} from "./talk-transcription-relay.js";
import { expectRecordFields, isRecord, requireRecord } from "./test-helpers.assertions.js";

type BroadcastEvent = {
  event: string;
  payload: unknown;
  connIds: string[];
  opts?: { dropIfSlow?: boolean };
};

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
    broadcastToConnIds: (
      event: string,
      payload: unknown,
      connIds: ReadonlySet<string>,
      opts?: { dropIfSlow?: boolean },
    ) => {
      events.push({ event, payload, connIds: [...connIds], opts });
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
  const { context, events, logGateway } = createBroadcastContext();
  const session = createTalkTranscriptionRelaySession({
    context,
    connId: "conn-1",
    provider,
    providerConfig,
  });
  await Promise.resolve();
  return { provider, events, logGateway, session };
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
    vi.useFakeTimers();
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
    sttSession.close.mockImplementationOnce(() => {
      sttRequest?.onTranscript?.("final audio");
    });
    stopTalkTranscriptionRelaySession({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
    });
    await vi.advanceTimersByTimeAsync(5_000);

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
    for (const { payload, opts } of events) {
      const { type } = requireRecord(payload, "transcription relay event");
      expect(opts, `${String(type)} delivery`).toEqual({
        dropIfSlow: type === "partial" || type === "inputAudio",
      });
    }
  });

  it.each(["synchronous", "asynchronous"] as const)(
    "delivers a %s provider final before gracefully closing an active transcription turn",
    async (delivery) => {
      vi.useFakeTimers();
      let request: RealtimeTranscriptionSessionCreateRequest | undefined;
      const sttSession = createSttSessionMock();
      sttSession.close.mockImplementation(() => {
        const deliverFirst = () => request?.onTranscript?.("first provider transcript");
        const deliverSecond = () => request?.onTranscript?.("second provider transcript");
        if (delivery === "synchronous") {
          deliverFirst();
          deliverSecond();
        } else {
          queueMicrotask(deliverFirst);
          setTimeout(deliverSecond, 1_000);
        }
      });
      const { events, session } = await createStartedRelaySession(sttSession, {}, (value) => {
        request = value;
      });

      sendTalkTranscriptionRelayAudio({
        transcriptionSessionId: session.transcriptionSessionId,
        connId: "conn-1",
        audioBase64: "AQI=",
      });
      stopTalkTranscriptionRelaySession({
        transcriptionSessionId: session.transcriptionSessionId,
        connId: "conn-1",
      });
      expect(
        events.some((event) => isRecord(event.payload) && event.payload.type === "close"),
      ).toBe(false);
      expect(() =>
        sendTalkTranscriptionRelayAudio({
          transcriptionSessionId: session.transcriptionSessionId,
          connId: "conn-1",
          audioBase64: "AQI=",
        }),
      ).toThrow("Unknown transcription Talk session");
      await vi.advanceTimersByTimeAsync(1_000);

      const transcripts = events
        .map((event) => requireRecord(event.payload, "transcription relay event"))
        .filter(
          (payload) => isRecord(payload.talkEvent) && payload.talkEvent.type === "transcript.done",
        );
      expect(transcripts.map((payload) => payload.text)).toEqual([
        "first provider transcript",
        "second provider transcript",
      ]);
      expect(
        events.some((event) => isRecord(event.payload) && event.payload.type === "close"),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(4_000);
      const terminalEvents = events
        .map((event) => {
          const payload = requireRecord(event.payload, "transcription relay event");
          return isRecord(payload.talkEvent) ? payload.talkEvent.type : undefined;
        })
        .filter((type) =>
          ["input.audio.committed", "transcript.done", "turn.ended", "session.closed"].includes(
            String(type),
          ),
        );
      expect(terminalEvents).toEqual([
        "input.audio.committed",
        "transcript.done",
        "turn.ended",
        "transcript.done",
        "turn.ended",
        "session.closed",
      ]);
      expect(sttSession.close).toHaveBeenCalledOnce();

      const eventCount = events.length;
      request?.onTranscript?.("late provider transcript");
      expect(events).toHaveLength(eventCount);
    },
  );

  it("drains later provider finals after an earlier transcript already ended its turn", async () => {
    vi.useFakeTimers();
    let request: RealtimeTranscriptionSessionCreateRequest | undefined;
    const sttSession = createSttSessionMock();
    sttSession.close.mockImplementationOnce(() => {
      request?.onTranscript?.("second provider transcript");
    });
    const { events, session } = await createStartedRelaySession(sttSession, {}, (value) => {
      request = value;
    });

    sendTalkTranscriptionRelayAudio({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
      audioBase64: "AQI=",
    });
    request?.onTranscript?.("first provider transcript");
    stopTalkTranscriptionRelaySession({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
    });

    const transcripts = events
      .map((event) => requireRecord(event.payload, "transcription relay event"))
      .filter(
        (payload) => isRecord(payload.talkEvent) && payload.talkEvent.type === "transcript.done",
      );
    expect(transcripts.map((payload) => payload.text)).toEqual([
      "first provider transcript",
      "second provider transcript",
    ]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(findPayloadByType(events, "close").reason).toBe("completed");
  });

  it("closes a provider immediately when its transcription session never received audio", async () => {
    const sttSession = createSttSessionMock();
    const { events, session } = await createStartedRelaySession(sttSession, {});

    stopTalkTranscriptionRelaySession({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
    });

    expect(findPayloadByType(events, "close").reason).toBe("completed");
    expect(sttSession.close).toHaveBeenCalledOnce();
  });

  it("bounds graceful provider draining when no final transcript arrives", async () => {
    vi.useFakeTimers();
    const sttSession = createSttSessionMock();
    const { events, session } = await createStartedRelaySession(sttSession, {});

    sendTalkTranscriptionRelayAudio({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
      audioBase64: "AQI=",
    });
    stopTalkTranscriptionRelaySession({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(events.some((event) => isRecord(event.payload) && event.payload.type === "close")).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(1);

    const close = findPayloadByType(events, "close");
    expect(close.reason).toBe("completed");
    expect(sttSession.close).toHaveBeenCalledOnce();
  });

  it("preserves partial activity between provider finals while graceful draining continues", async () => {
    vi.useFakeTimers();
    let request: RealtimeTranscriptionSessionCreateRequest | undefined;
    const sttSession = createSttSessionMock();
    const { events, session } = await createStartedRelaySession(sttSession, {}, (value) => {
      request = value;
    });

    sendTalkTranscriptionRelayAudio({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
      audioBase64: "AQI=",
    });
    stopTalkTranscriptionRelaySession({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
    });
    request?.onTranscript?.("first final");
    await vi.advanceTimersByTimeAsync(1_400);
    request?.onPartial?.("second draft");
    await vi.advanceTimersByTimeAsync(200);
    request?.onTranscript?.("second final");

    const updates = events
      .map((event) => requireRecord(event.payload, "transcription relay event"))
      .filter((payload) => typeof payload.text === "string" && payload.text)
      .map((payload) => ({ type: payload.type, text: payload.text }));
    expect(updates).toEqual([
      { type: "transcript", text: "first final" },
      { type: "partial", text: "second draft" },
      { type: "transcript", text: "second final" },
    ]);
    expect(events.some((event) => isRecord(event.payload) && event.payload.type === "close")).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(3_400);
    expect(findPayloadByType(events, "close").reason).toBe("completed");
  });

  it("does not report a provider ready after graceful draining has started", async () => {
    vi.useFakeTimers();
    let request: RealtimeTranscriptionSessionCreateRequest | undefined;
    let resolveConnection: (() => void) | undefined;
    const sttSession = createSttSessionMock(
      () =>
        new Promise<void>((resolve) => {
          resolveConnection = resolve;
        }),
    );
    const { events, session } = await createStartedRelaySession(sttSession, {}, (value) => {
      request = value;
    });

    sendTalkTranscriptionRelayAudio({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
      audioBase64: "AQI=",
    });
    stopTalkTranscriptionRelaySession({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
    });
    resolveConnection?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(events.some((event) => isRecord(event.payload) && event.payload.type === "ready")).toBe(
      false,
    );
    request?.onTranscript?.("final provider transcript");
    expect(findPayloadByTalkEventType(events, "transcript.done").text).toBe(
      "final provider transcript",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(findPayloadByType(events, "close").reason).toBe("completed");
  });

  it("closes a draining provider immediately when its browser owner disconnects", async () => {
    let request: RealtimeTranscriptionSessionCreateRequest | undefined;
    const sttSession = createSttSessionMock();
    sttSession.close.mockImplementationOnce(() => {
      queueMicrotask(() => request?.onTranscript?.("disconnected provider transcript"));
    });
    const { events, logGateway, session } = await createStartedRelaySession(
      sttSession,
      {},
      (value) => {
        request = value;
      },
    );

    sendTalkTranscriptionRelayAudio({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
      audioBase64: "AQI=",
    });
    stopTalkTranscriptionRelaySession({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
    });
    cleanupTalkConnection("conn-1", logGateway);
    await Promise.resolve();

    expect(
      events.filter((event) => isRecord(event.payload) && event.payload.type === "close"),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          isRecord(event.payload) && event.payload.text === "disconnected provider transcript",
      ),
    ).toBe(false);
    expect(sttSession.close).toHaveBeenCalledOnce();
  });

  it("terminates graceful draining immediately when the provider reports an error", async () => {
    let request: RealtimeTranscriptionSessionCreateRequest | undefined;
    const sttSession = createSttSessionMock();
    const { events, session } = await createStartedRelaySession(sttSession, {}, (value) => {
      request = value;
    });

    sendTalkTranscriptionRelayAudio({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
      audioBase64: "AQI=",
    });
    stopTalkTranscriptionRelaySession({
      transcriptionSessionId: session.transcriptionSessionId,
      connId: "conn-1",
    });
    request?.onError?.(new Error("provider finalization failed"));
    request?.onTranscript?.("transcript after provider error");

    expect(findPayloadByType(events, "error").message).toBe("provider finalization failed");
    expect(findPayloadByType(events, "close").reason).toBe("error");
    expect(
      events.some(
        (event) =>
          isRecord(event.payload) && event.payload.text === "transcript after provider error",
      ),
    ).toBe(false);
    expect(sttSession.close).toHaveBeenCalledOnce();
  });

  it("keeps provider errors and terminal close events durable", async () => {
    let sttRequest: RealtimeTranscriptionSessionCreateRequest | undefined;
    const { events } = await createStartedRelaySession(createSttSessionMock(), {}, (request) => {
      sttRequest = request;
    });

    sttRequest?.onError?.(new Error("transcription provider disconnected"));

    for (const type of ["error", "close"]) {
      const payload = findPayloadByType(events, type);
      expect(events.find((event) => event.payload === payload)?.opts).toEqual({
        dropIfSlow: false,
      });
    }
  });

  it("closes a backpressured owner for final transcripts while healthy owners still receive them", async () => {
    const createSocket = () => ({
      bufferedAmount: 0,
      send: vi.fn<(payload: string) => void>(),
      close: vi.fn<(code: number, reason: string) => void>(),
    });
    const slowSocket = createSocket();
    const healthySocket = createSocket();
    const createClient = (
      connId: string,
      socket: ReturnType<typeof createSocket>,
    ): GatewayWsClient =>
      ({
        connId,
        socket: socket as unknown as GatewayWsClient["socket"],
        connect: { role: "operator", scopes: ["operator.read"] } as GatewayWsClient["connect"],
        usesSharedGatewayAuth: false,
      }) satisfies GatewayWsClient;
    const clients = new Set([
      createClient("conn-slow", slowSocket),
      createClient("conn-healthy", healthySocket),
    ]);
    const { broadcastToConnIds } = createGatewayBroadcaster({ clients });
    const context = { broadcastToConnIds, getRuntimeConfig: () => ({}) } as never;
    const requests = new Map<string, RealtimeTranscriptionSessionCreateRequest>();
    const createSession = (connId: string) =>
      createTalkTranscriptionRelaySession({
        context,
        connId,
        provider: createTranscriptionProvider(createSttSessionMock(), (request) => {
          requests.set(connId, request);
        }),
        providerConfig: {},
      });
    const slowSession = createSession("conn-slow");
    const healthySession = createSession("conn-healthy");
    await Promise.resolve();
    const slowRequest = requests.get("conn-slow");
    const healthyRequest = requests.get("conn-healthy");
    if (!slowRequest || !healthyRequest) {
      throw new Error("expected transcription providers for both browser connections");
    }

    try {
      slowRequest.onSpeechStart?.();
      healthyRequest.onSpeechStart?.();
      slowSocket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
      const slowFramesBeforePartial = slowSocket.send.mock.calls.length;

      slowRequest.onPartial?.("slow draft");
      healthyRequest.onPartial?.("healthy draft");

      expect(slowSocket.send).toHaveBeenCalledTimes(slowFramesBeforePartial);
      expect(slowSocket.close).not.toHaveBeenCalled();

      slowRequest.onTranscript?.("slow final");
      healthyRequest.onTranscript?.("healthy final");

      expect(slowSocket.close).toHaveBeenCalledWith(1008, "slow consumer");
      const healthyFrames = healthySocket.send.mock.calls.map(
        ([frame]) => JSON.parse(frame) as { event: string; payload: unknown },
      );
      expect(healthyFrames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "talk.event",
            payload: expect.objectContaining({ type: "partial", text: "healthy draft" }),
          }),
          expect.objectContaining({
            event: "talk.event",
            payload: expect.objectContaining({
              type: "transcript",
              text: "healthy final",
              final: true,
            }),
          }),
        ]),
      );
    } finally {
      slowSocket.bufferedAmount = 0;
      stopTalkTranscriptionRelaySession({
        transcriptionSessionId: slowSession.transcriptionSessionId,
        connId: "conn-slow",
      });
      stopTalkTranscriptionRelaySession({
        transcriptionSessionId: healthySession.transcriptionSessionId,
        connId: "conn-healthy",
      });
    }
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

    expect(() => cleanupTalkConnection("conn-owner", logGateway)).not.toThrow();
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
    cleanupTalkConnection("conn-other", logGateway);
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
    sttSession.close.mockImplementationOnce(() => {
      sttRequest?.onTranscript?.("cancelled provider transcript");
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
    expect(
      events.some(
        (event) =>
          isRecord(event.payload) && event.payload.text === "cancelled provider transcript",
      ),
    ).toBe(false);
  });
});
