import type { IncomingMessage } from "node:http";
import net from "node:net";
import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
  RealtimeTranscriptionSessionCreateRequest,
} from "openclaw/plugin-sdk/realtime-transcription";
import { createTalkSessionController, type TalkEvent } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { MediaStreamHandler, sanitizeLogText } from "./media-stream.js";
import {
  connectWs,
  startUpgradeWsServer,
  waitForClose,
  withTimeout,
} from "./websocket-test-support.js";

const createStubSession = (): RealtimeTranscriptionSession => ({
  connect: async () => {},
  sendAudio: () => {},
  close: () => {},
  isConnected: () => true,
});

const createStubSttProvider = (): RealtimeTranscriptionProviderPlugin =>
  ({
    createSession: () => createStubSession(),
    id: "openai",
    label: "OpenAI",
    isConfigured: () => true,
  }) as unknown as RealtimeTranscriptionProviderPlugin;

const createDeferred = (): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} => {
  let resolve: (() => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
};

const waitForAbort = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

const startWsServer = async (
  handler: MediaStreamHandler,
): Promise<{
  url: string;
  close: () => Promise<void>;
}> =>
  startUpgradeWsServer({
    urlPath: "/voice/stream",
    onUpgrade: (request, socket, head) => {
      handler.handleUpgrade(request, socket, head);
    },
  });

const requireRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
};

const requireFirstMockCall = <T extends unknown[]>(calls: readonly T[], label: string): T => {
  const call = calls.at(0);
  if (!call) {
    throw new Error(`Expected ${label}`);
  }
  return call;
};

const requireTalkEvent = (events: TalkEvent[], type: TalkEvent["type"]) => {
  const event = events.find((candidate) => candidate.type === type);
  if (!event) {
    throw new Error(`Expected ${type} Talk event`);
  }
  return requireRecord(event, `${type} Talk event`);
};

describe("MediaStreamHandler TTS queue", () => {
  it("serializes TTS playback and resolves in order", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
    });
    const started: number[] = [];
    const finished: number[] = [];

    let resolveFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    if (!resolveFirst) {
      throw new Error("Expected first TTS gate resolver to be initialized");
    }

    const first = handler.queueTts("stream-1", async () => {
      started.push(1);
      await firstGate;
      finished.push(1);
    });
    const second = handler.queueTts("stream-1", async () => {
      started.push(2);
      finished.push(2);
    });

    expect(started).toEqual([1]);

    resolveFirst();
    await first;
    await second;

    expect(started).toEqual([1, 2]);
    expect(finished).toEqual([1, 2]);
  });

  it("cancels active playback and clears queued items", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
    });

    let queuedRan = false;
    const started: string[] = [];

    const active = handler.queueTts("stream-1", async (signal) => {
      started.push("active");
      await waitForAbort(signal);
    });
    const queued = handler.queueTts("stream-1", async () => {
      queuedRan = true;
    });

    expect(started).toEqual(["active"]);

    handler.clearTtsQueue("stream-1");
    await active;
    await withTimeout(queued);

    expect(queuedRan).toBe(false);
  });

  it("resolves pending queued playback during stream teardown", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
    });

    let queuedRan = false;
    const active = handler.queueTts("stream-1", async (signal) => {
      await waitForAbort(signal);
    });
    const queued = handler.queueTts("stream-1", async () => {
      queuedRan = true;
    });

    (
      handler as unknown as {
        clearTtsState(streamSid: string): void;
      }
    ).clearTtsState("stream-1");

    await withTimeout(active);
    await withTimeout(queued);
    expect(queuedRan).toBe(false);
  });
});

describe("MediaStreamHandler security hardening", () => {
  it("emits common Talk events for telephony STT/TTS sessions", async () => {
    let callbacks: RealtimeTranscriptionSessionCreateRequest | undefined;
    const sentAudio: Buffer[] = [];
    const session: RealtimeTranscriptionSession = {
      connect: async () => {},
      sendAudio: (audio) => {
        sentAudio.push(Buffer.from(audio));
      },
      close: () => {},
      isConnected: () => true,
    };
    const talkEvents: TalkEvent[] = [];
    const handler = new MediaStreamHandler({
      transcriptionProvider: {
        createSession: (request) => {
          callbacks = request;
          return session;
        },
        id: "openai",
        label: "OpenAI",
        isConfigured: () => true,
      },
      providerConfig: {},
      shouldAcceptStream: () => true,
      onTalkEvent: (_callId, _streamSid, event) => {
        talkEvents.push(event);
      },
    });
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-talk",
          start: { callSid: "CA-talk" },
        }),
      );
      await vi.waitFor(() => {
        expect(talkEvents.map((event) => event.type)).toContain("session.ready");
      });

      ws.send(
        JSON.stringify({
          event: "media",
          streamSid: "MZ-talk",
          media: { payload: Buffer.from("hello").toString("base64") },
        }),
      );
      await vi.waitFor(() => {
        expect(Buffer.concat(sentAudio).toString()).toBe("hello");
      });

      callbacks?.onSpeechStart?.();
      callbacks?.onPartial?.("hel");
      callbacks?.onTranscript?.("hello there");

      await handler.queueTts("MZ-talk", async () => {
        handler.sendAudio("MZ-talk", Buffer.alloc(160, 0xff));
      });

      const activePlayback = handler.queueTts("MZ-talk", async (signal) => {
        await waitForAbort(signal);
      });
      handler.clearTtsQueue("MZ-talk", "barge-in");
      await activePlayback;

      ws.close();
      await waitForClose(ws);
      await vi.waitFor(() => {
        expect(talkEvents.map((event) => event.type)).toContain("session.closed");
      });

      expect(talkEvents.map((event) => event.type)).toEqual([
        "session.started",
        "session.ready",
        "turn.started",
        "input.audio.delta",
        "transcript.delta",
        "input.audio.committed",
        "transcript.done",
        "output.audio.started",
        "output.audio.delta",
        "output.audio.done",
        "turn.ended",
        "turn.started",
        "output.audio.started",
        "turn.cancelled",
        "session.closed",
      ]);
      const startedEvent = requireRecord(talkEvents[0], "session started Talk event");
      expect(startedEvent.sessionId).toBe("voice-call:CA-talk:MZ-talk");
      expect(startedEvent.mode).toBe("stt-tts");
      expect(startedEvent.transport).toBe("gateway-relay");
      expect(startedEvent.brain).toBe("agent-consult");
      expect(startedEvent.provider).toBe("openai");
      expect(startedEvent.seq).toBe(1);

      const transcriptDone = requireTalkEvent(talkEvents, "transcript.done");
      expect(transcriptDone.final).toBe(true);
      expect(transcriptDone.turnId).toBe("MZ-talk:turn-1");
      const transcriptPayload = requireRecord(transcriptDone.payload, "transcript payload");
      expect(transcriptPayload.text).toBe("hello there");
      expect(transcriptPayload.role).toBe("user");

      const cancelled = requireTalkEvent(talkEvents, "turn.cancelled");
      expect(cancelled.final).toBe(true);
      expect(cancelled.turnId).toBe("MZ-talk:turn-2");
      const cancelledPayload = requireRecord(cancelled.payload, "cancelled payload");
      expect(cancelledPayload.reason).toBe("barge-in");
    } finally {
      await server.close();
    }
  });

  it("fails sends and closes stream when buffered bytes already exceed the cap", () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
    });
    const ws = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 2 * 1024 * 1024,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WebSocket;
    (
      handler as unknown as {
        sessions: Map<
          string,
          {
            callId: string;
            streamSid: string;
            ws: WebSocket;
            sttSession: RealtimeTranscriptionSession;
            talk: ReturnType<typeof createTalkSessionController>;
          }
        >;
      }
    ).sessions.set("MZ-backpressure", {
      callId: "CA-backpressure",
      streamSid: "MZ-backpressure",
      ws,
      sttSession: createStubSession(),
      talk: createTalkSessionController({
        sessionId: "voice-call:CA-backpressure:MZ-backpressure",
        mode: "stt-tts",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
      }),
    });

    const result = handler.sendAudio("MZ-backpressure", Buffer.alloc(160, 0xff));

    expect(result.sent).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(1013, "Backpressure: send buffer exceeded");
  });

  it("fails sends when buffered bytes exceed cap after enqueueing a frame", () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
    });
    const ws = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(() => {
        (
          ws as unknown as {
            bufferedAmount: number;
          }
        ).bufferedAmount = 2 * 1024 * 1024;
      }),
      close: vi.fn(),
    } as unknown as WebSocket;
    (
      handler as unknown as {
        sessions: Map<
          string,
          {
            callId: string;
            streamSid: string;
            ws: WebSocket;
            sttSession: RealtimeTranscriptionSession;
          }
        >;
      }
    ).sessions.set("MZ-overflow", {
      callId: "CA-overflow",
      streamSid: "MZ-overflow",
      ws,
      sttSession: createStubSession(),
    });

    const result = handler.sendMark("MZ-overflow", "mark-1");

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(false);
    expect(ws.close).toHaveBeenCalledWith(1013, "Backpressure: send buffer exceeded");
  });

  it("sanitizes websocket close reason before logging", () => {
    const reason = sanitizeLogText("forged\nline\r\tentry", 120);
    expect(reason).not.toContain("\n");
    expect(reason).not.toContain("\r");
    expect(reason).not.toContain("\t");
    expect(reason).toContain("forged line entry");
  });

  it("closes idle pre-start connections after timeout", async () => {
    const shouldAcceptStreamCalls: Array<{ callId: string; streamSid: string; token?: string }> =
      [];
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      preStartTimeoutMs: 40,
      shouldAcceptStream: (params) => {
        shouldAcceptStreamCalls.push(params);
        return true;
      },
    });
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      const closed = await waitForClose(ws);

      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe("Start timeout");
      expect(shouldAcceptStreamCalls).toStrictEqual([]);
    } finally {
      await server.close();
    }
  });

  it("enforces pending connection limits", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      preStartTimeoutMs: 5_000,
      maxPendingConnections: 1,
      maxPendingConnectionsPerIp: 1,
    });
    const server = await startWsServer(handler);

    try {
      const first = await connectWs(server.url);
      const second = await connectWs(server.url);
      const secondClosed = await waitForClose(second);

      expect(secondClosed.code).toBe(1013);
      expect(secondClosed.reason).toContain("Too many pending");
      expect(first.readyState).toBe(WebSocket.OPEN);

      first.close();
      await waitForClose(first);
    } finally {
      await server.close();
    }
  });

  it("uses resolved client IPs for per-IP pending limits", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      preStartTimeoutMs: 5_000,
      maxPendingConnections: 10,
      maxPendingConnectionsPerIp: 1,
      resolveClientIp: (request) => String(request.headers["x-forwarded-for"] ?? ""),
    });
    const server = await startWsServer(handler);

    try {
      const first = new WebSocket(server.url, {
        headers: { "x-forwarded-for": "198.51.100.10" },
      });
      await withTimeout(new Promise((resolve) => first.once("open", resolve)));

      const second = new WebSocket(server.url, {
        headers: { "x-forwarded-for": "203.0.113.20" },
      });
      await withTimeout(new Promise((resolve) => second.once("open", resolve)));

      expect(first.readyState).toBe(WebSocket.OPEN);
      expect(second.readyState).toBe(WebSocket.OPEN);

      const firstClosed = waitForClose(first);
      const secondClosed = waitForClose(second);
      first.close();
      second.close();
      await firstClosed;
      await secondClosed;
    } finally {
      await server.close();
    }
  });

  it("rejects upgrades when max connection cap is reached", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      preStartTimeoutMs: 5_000,
      maxConnections: 1,
      maxPendingConnections: 10,
      maxPendingConnectionsPerIp: 10,
    });
    const server = await startWsServer(handler);

    try {
      const first = await connectWs(server.url);
      const secondError = await withTimeout(
        new Promise<Error>((resolve) => {
          const ws = new WebSocket(server.url);
          ws.once("error", (err) => resolve(err));
        }),
      );

      expect(secondError.message).toContain("Unexpected server response: 503");

      first.close();
      await waitForClose(first);
    } finally {
      await server.close();
    }
  });

  it("counts in-flight upgrades against the max connection cap", () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      maxConnections: 2,
      maxPendingConnections: 10,
      maxPendingConnectionsPerIp: 10,
    });

    const fakeWss = {
      clients: new Set([{}]),
      handleUpgrade: vi.fn(),
      emit: vi.fn(),
      on: vi.fn(),
    };
    let upgradeCallback: ((ws: WebSocket) => void) | null = null;
    fakeWss.handleUpgrade.mockImplementation(
      (
        _request: IncomingMessage,
        _socket: unknown,
        _head: Buffer,
        callback: (ws: WebSocket) => void,
      ) => {
        upgradeCallback = callback;
      },
    );

    (
      handler as unknown as {
        wss: typeof fakeWss;
      }
    ).wss = fakeWss;

    const firstSocket = {
      once: vi.fn(),
      removeListener: vi.fn(),
      write: vi.fn(),
      destroy: vi.fn(),
    };
    handler.handleUpgrade(
      { socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage,
      firstSocket as never,
      Buffer.alloc(0),
    );

    const secondSocket = {
      once: vi.fn(),
      removeListener: vi.fn(),
      write: vi.fn(),
      destroy: vi.fn(),
    };
    handler.handleUpgrade(
      { socket: { remoteAddress: "127.0.0.1" } } as IncomingMessage,
      secondSocket as never,
      Buffer.alloc(0),
    );

    expect(fakeWss.handleUpgrade).toHaveBeenCalledTimes(1);
    expect(secondSocket.write).toHaveBeenCalledOnce();
    expect(secondSocket.destroy).toHaveBeenCalledOnce();

    const completeUpgrade = upgradeCallback as ((ws: WebSocket) => void) | null;
    if (!completeUpgrade) {
      throw new Error("Expected upgrade callback to be registered");
    }
    completeUpgrade({} as WebSocket);
    expect(fakeWss.emit).toHaveBeenCalledOnce();
    const emitCall = requireFirstMockCall(
      fakeWss.emit.mock.calls,
      "websocket connection emit call",
    );
    expect(emitCall[0]).toBe("connection");
    if (!emitCall[1]) {
      throw new Error("Expected websocket connection argument");
    }
    const request = requireRecord(emitCall[2], "connection request");
    const socket = requireRecord(request.socket, "connection request socket");
    expect(socket.remoteAddress).toBe("127.0.0.1");
  });

  it("releases in-flight reservations when ws rejects a malformed upgrade before the callback", async () => {
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      preStartTimeoutMs: 5_000,
      maxConnections: 1,
      maxPendingConnections: 10,
      maxPendingConnectionsPerIp: 10,
    });
    const server = await startWsServer(handler);
    const serverUrl = new URL(server.url);

    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          const socket = net.createConnection(
            { host: serverUrl.hostname, port: Number(serverUrl.port) },
            () => {
              socket.write(
                [
                  "GET /voice/stream HTTP/1.1",
                  `Host: ${serverUrl.host}`,
                  "Upgrade: websocket",
                  "Connection: Upgrade",
                  "Sec-WebSocket-Version: 13",
                  "",
                  "",
                ].join("\r\n"),
              );
            },
          );
          socket.once("error", reject);
          socket.once("data", () => {
            socket.end();
          });
          socket.once("close", () => resolve());
        }),
      );

      const ws = await connectWs(server.url);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await waitForClose(ws);
    } finally {
      await server.close();
    }
  });

  it("clears pending state after valid start", async () => {
    const shouldAcceptStream = vi.fn(
      (_params: { callId: string; streamSid: string; token?: string }) => true,
    );
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      maxPendingConnections: 1,
      maxPendingConnectionsPerIp: 10,
      preStartTimeoutMs: 5_000,
      shouldAcceptStream,
    });
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ123",
          start: { callSid: "CA123", customParameters: { token: "token-123" } },
        }),
      );

      await vi.waitFor(() => {
        expect(shouldAcceptStream).toHaveBeenCalledOnce();
      });
      const acceptedStreamCall = requireFirstMockCall(
        shouldAcceptStream.mock.calls,
        "accepted stream call",
      );
      const acceptedStream = requireRecord(acceptedStreamCall[0], "accepted stream params");
      expect(acceptedStream.callId).toBe("CA123");
      expect(acceptedStream.streamSid).toBe("MZ123");
      expect(acceptedStream.token).toBe("token-123");
      expect(ws.readyState).toBe(WebSocket.OPEN);

      const second = await connectWs(server.url);
      expect(second.readyState).toBe(WebSocket.OPEN);

      second.close();
      await waitForClose(second);
      ws.close();
      await waitForClose(ws);
    } finally {
      await server.close();
    }
  });

  it("defers transcription readiness until STT connect resolves", async () => {
    const sttReady = createDeferred();
    const sttConnectStarted = createDeferred();
    const transcriptionReady = createDeferred();
    const events: string[] = [];

    const session: RealtimeTranscriptionSession = {
      connect: async () => {
        events.push("stt-connect-start");
        sttConnectStarted.resolve();
        await sttReady.promise;
        events.push("stt-connect-ready");
      },
      sendAudio: () => {},
      close: () => {},
      isConnected: () => false,
    };

    const handler = new MediaStreamHandler({
      transcriptionProvider: {
        createSession: () => session,
        id: "openai",
        label: "OpenAI",
        isConfigured: () => true,
      },
      providerConfig: {},
      shouldAcceptStream: () => true,
      onConnect: () => {
        events.push("onConnect");
      },
      onTranscriptionReady: () => {
        events.push("onTranscriptionReady");
        transcriptionReady.resolve();
      },
    });
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-slow-stt",
          start: { callSid: "CA-slow-stt" },
        }),
      );

      await withTimeout(sttConnectStarted.promise);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(events).toEqual(["onConnect", "stt-connect-start"]);

      sttReady.resolve();
      await withTimeout(transcriptionReady.promise);
      expect(events).toEqual([
        "onConnect",
        "stt-connect-start",
        "stt-connect-ready",
        "onTranscriptionReady",
      ]);

      ws.close();
      await waitForClose(ws);
    } finally {
      await server.close();
    }
  });

  it("forwards early Twilio media into the STT session before readiness", async () => {
    const sttReady = createDeferred();
    const sttConnectStarted = createDeferred();
    const transcriptionReady = createDeferred();
    const audioReceived = createDeferred();
    const receivedAudio: Buffer[] = [];
    let onConnectCalls = 0;
    let onTranscriptionReadyCalls = 0;

    const session: RealtimeTranscriptionSession = {
      connect: async () => {
        sttConnectStarted.resolve();
        await sttReady.promise;
      },
      sendAudio: (audio) => {
        receivedAudio.push(Buffer.from(audio));
        audioReceived.resolve();
      },
      close: () => {},
      isConnected: () => false,
    };

    const handler = new MediaStreamHandler({
      transcriptionProvider: {
        createSession: () => session,
        id: "openai",
        label: "OpenAI",
        isConfigured: () => true,
      },
      providerConfig: {},
      shouldAcceptStream: () => true,
      onConnect: () => {
        onConnectCalls += 1;
      },
      onTranscriptionReady: () => {
        onTranscriptionReadyCalls += 1;
        transcriptionReady.resolve();
      },
    });
    const server = await startWsServer(handler);
    let ws: WebSocket | undefined;

    try {
      ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-early-media",
          start: { callSid: "CA-early-media" },
        }),
      );

      await withTimeout(sttConnectStarted.promise);
      ws.send(
        JSON.stringify({
          event: "media",
          streamSid: "MZ-early-media",
          media: { payload: Buffer.from("early").toString("base64") },
        }),
      );
      await withTimeout(audioReceived.promise);

      expect(Buffer.concat(receivedAudio).toString()).toBe("early");
      expect(onConnectCalls).toBe(1);
      expect(onTranscriptionReadyCalls).toBe(0);

      sttReady.resolve();
      await withTimeout(transcriptionReady.promise);
      expect(onConnectCalls).toBe(1);
      expect(onTranscriptionReadyCalls).toBe(1);
    } finally {
      sttReady.resolve();
      if (ws) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close();
        }
        if (ws.readyState !== WebSocket.CLOSED) {
          await waitForClose(ws).catch(() => {});
        }
      }
      await server.close();
    }
  });

  it("closes the media stream and disconnects once when STT readiness fails", async () => {
    const sttConnectStarted = createDeferred();
    const onDisconnectReady = createDeferred();
    const onConnect = vi.fn();
    const onTranscriptionReady = vi.fn();
    const onDisconnect = vi.fn(() => {
      onDisconnectReady.resolve();
    });

    const session: RealtimeTranscriptionSession = {
      connect: async () => {
        sttConnectStarted.resolve();
        throw new Error("provider unavailable");
      },
      sendAudio: () => {},
      close: vi.fn(),
      isConnected: () => false,
    };

    const handler = new MediaStreamHandler({
      transcriptionProvider: {
        createSession: () => session,
        id: "openai",
        label: "OpenAI",
        isConfigured: () => true,
      },
      providerConfig: {},
      shouldAcceptStream: () => true,
      onConnect,
      onTranscriptionReady,
      onDisconnect,
    });
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-stt-fail",
          start: { callSid: "CA-stt-fail" },
        }),
      );

      await withTimeout(sttConnectStarted.promise);
      const closed = await waitForClose(ws);
      await withTimeout(onDisconnectReady.promise);

      expect(closed.code).toBe(1011);
      expect(closed.reason).toBe("STT connection failed");
      expect(onConnect).toHaveBeenCalledTimes(1);
      expect(onConnect).toHaveBeenCalledWith("CA-stt-fail", "MZ-stt-fail");
      expect(onTranscriptionReady).not.toHaveBeenCalled();
      expect(onDisconnect).toHaveBeenCalledTimes(1);
      expect(onDisconnect).toHaveBeenCalledWith("CA-stt-fail", "MZ-stt-fail");
      expect(session.close).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("rejects oversized pre-start frames at the websocket maxPayload guard before validation runs", async () => {
    const shouldAcceptStreamCalls: Array<{ callId: string; streamSid: string; token?: string }> =
      [];
    const handler = new MediaStreamHandler({
      transcriptionProvider: createStubSttProvider(),
      providerConfig: {},
      preStartTimeoutMs: 1_000,
      shouldAcceptStream: (params) => {
        shouldAcceptStreamCalls.push(params);
        return true;
      },
    });
    const server = await startWsServer(handler);

    try {
      const ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          streamSid: "MZ-oversized",
          start: {
            callSid: "CA-oversized",
            customParameters: { token: "token-oversized", padding: "A".repeat(256 * 1024) },
          },
        }),
      );

      const closed = await waitForClose(ws);

      expect(closed.code).toBe(1009);
      expect(shouldAcceptStreamCalls).toStrictEqual([]);
    } finally {
      await server.close();
    }
  });
});
