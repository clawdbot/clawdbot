import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildGoogleLiveUrl,
  GoogleLiveRealtimeTalkTransport,
} from "./chat/realtime-talk-google-live.ts";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "./chat/realtime-talk-shared.ts";
import type {
  RealtimeTalkJsonPcmWebSocketSessionResult,
  RealtimeTalkTransportContext,
} from "./chat/realtime-talk-shared.ts";

type MockWebSocketEvent = {
  data?: unknown;
  code?: number;
  reason?: string;
};

type MockWebSocketHandler = (event?: MockWebSocketEvent) => void;
type MockWebSocketEventType = "close" | "error" | "message" | "open";

const wsInstances: MockGoogleLiveWebSocket[] = [];
const createdSources: MockAudioBufferSource[] = [];

class MockGoogleLiveWebSocket {
  static OPEN = 1;

  readonly handlers: Record<MockWebSocketEventType, MockWebSocketHandler[]> = {
    close: [],
    error: [],
    message: [],
    open: [],
  };
  readonly sent: string[] = [];
  binaryType: BinaryType = "blob";
  readyState = MockGoogleLiveWebSocket.OPEN;

  constructor(readonly url: string) {
    wsInstances.push(this);
  }

  addEventListener(type: MockWebSocketEventType, handler: MockWebSocketHandler) {
    this.handlers[type].push(handler);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  emitOpen() {
    for (const handler of this.handlers.open) {
      handler();
    }
  }

  emitMessage(data: unknown) {
    for (const handler of this.handlers.message) {
      handler({ data });
    }
  }
}

class MockAudioBufferSource {
  buffer: unknown = null;
  readonly addEventListener = vi.fn();
  readonly connect = vi.fn();
  readonly start = vi.fn();
  readonly stop = vi.fn();
}

class MockAudioContext {
  readonly currentTime = 0;
  readonly destination = {};
  readonly sampleRate: number;
  readonly close = vi.fn(async () => undefined);

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 24000;
  }

  createMediaStreamSource() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }

  createScriptProcessor() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null,
    };
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    const channel = new Float32Array(length);
    return {
      duration: length / sampleRate,
      getChannelData: () => channel,
    };
  }

  createBufferSource() {
    const source = new MockAudioBufferSource();
    createdSources.push(source);
    return source;
  }
}

function createSession(
  websocketUrl: string,
  clientSecret = "auth_tokens/browser-session",
): RealtimeTalkJsonPcmWebSocketSessionResult {
  return {
    provider: "google",
    transport: "provider-websocket",
    protocol: "google-live-bidi",
    clientSecret,
    websocketUrl,
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: 16000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24000,
    },
  };
}

function createClient(): RealtimeTalkTransportContext["client"] {
  const client = {
    addEventListener: vi.fn(() => () => undefined),
    request: vi.fn(),
  } as unknown as RealtimeTalkTransportContext["client"];
  return client;
}

function createTransport(
  callbacks: RealtimeTalkTransportContext["callbacks"] = {},
  client = createClient(),
) {
  return new GoogleLiveRealtimeTalkTransport(
    createSession(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
    ),
    {
      callbacks,
      client,
      sessionKey: "main",
    },
  );
}

function encodeJsonFrame(value: unknown): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(value)).buffer;
}

function latestWebSocket(): MockGoogleLiveWebSocket {
  const ws = wsInstances.at(-1);
  if (!ws) {
    throw new Error("missing WebSocket");
  }
  return ws;
}

describe("GoogleLiveRealtimeTalkTransport", () => {
  beforeEach(() => {
    wsInstances.length = 0;
    createdSources.length = 0;
    vi.stubGlobal("WebSocket", MockGoogleLiveWebSocket);
    vi.stubGlobal("AudioContext", MockAudioContext);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [{ stop: vi.fn() }],
        })),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests ArrayBuffer frames and decodes binary setup messages", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = createTransport({ onStatus, onTalkEvent });

    await transport.start();
    const ws = latestWebSocket();
    ws.emitMessage(encodeJsonFrame({ setupComplete: {} }));

    expect(ws.binaryType).toBe("arraybuffer");
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("listening"));
    const readyEvent = onTalkEvent.mock.calls[0]?.[0];
    expect(readyEvent?.type).toBe("session.ready");
    expect(readyEvent?.sessionId).toBe("main:google:provider-websocket");
    expect(readyEvent?.transport).toBe("provider-websocket");
  });

  it("decodes Blob setup messages", async () => {
    const onStatus = vi.fn();
    const transport = createTransport({ onStatus });

    await transport.start();
    latestWebSocket().emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));

    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("listening"));
  });

  it("stops queued output when Google Live sends interruption", async () => {
    const onTalkEvent = vi.fn();
    const transport = createTransport({ onTalkEvent });
    await transport.start();
    const ws = latestWebSocket();

    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { data: "AAAAAA==", mimeType: "audio/pcm;rate=24000" } }],
          },
        },
      }),
    );
    await vi.waitFor(() => expect(createdSources).toHaveLength(1));

    const source = createdSources[0];
    ws.emitMessage(encodeJsonFrame({ serverContent: { interrupted: true } }));

    await vi.waitFor(() => expect(source?.stop).toHaveBeenCalledTimes(1));
    const cancelledEvent = onTalkEvent.mock.calls.find(
      ([event]) => event.type === "turn.cancelled",
    )?.[0];
    expect(cancelledEvent?.final).toBe(true);
    expect(cancelledEvent?.payload).toStrictEqual({ reason: "provider-interrupted" });
  });

  it("emits common Talk events for Google Live transcript and audio frames", async () => {
    const onTranscript = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = createTransport({ onTalkEvent, onTranscript });

    await transport.start();
    latestWebSocket().emitMessage(
      encodeJsonFrame({
        serverContent: {
          inputTranscription: { text: "hello", finished: true },
          outputTranscription: { text: "hi", finished: false },
          modelTurn: {
            parts: [
              { inlineData: { data: "AAAAAA==", mimeType: "audio/pcm;rate=24000" } },
              { text: "there" },
            ],
          },
          turnComplete: true,
        },
      }),
    );

    await vi.waitFor(() =>
      expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual([
        "transcript.done",
        "output.text.delta",
        "output.audio.delta",
        "output.text.done",
        "turn.ended",
      ]),
    );
    expect(onTalkEvent.mock.calls.map(([event]) => event.turnId)).toEqual([
      "turn-1",
      "turn-1",
      "turn-1",
      "turn-1",
      "turn-1",
    ]);
    expect(onTranscript).toHaveBeenCalledWith({ role: "user", text: "hello", final: true });
    expect(onTranscript).toHaveBeenCalledWith({ role: "assistant", text: "hi", final: false });
    const audioEvent = onTalkEvent.mock.calls[2]?.[0];
    expect(audioEvent?.payload).toStrictEqual({ byteLength: 4, mimeType: "audio/pcm;rate=24000" });
    expect(audioEvent?.sessionId).toBe("main:google:provider-websocket");
    expect(audioEvent?.transport).toBe("provider-websocket");
  });

  it("ignores late WebSocket events after stop", async () => {
    const onStatus = vi.fn();
    const transport = createTransport({ onStatus });
    await transport.start();
    const ws = latestWebSocket();

    transport.stop();
    ws.emitOpen();
    ws.emitMessage(new Blob([JSON.stringify({ setupComplete: {} })]));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ws.sent).toStrictEqual([]);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("does not revive Talk status after stop while a tool consult settles", async () => {
    const onStatus = vi.fn();
    let runId = "run-1";
    const listeners = new Set<(event: { event: string; payload?: unknown }) => void>();
    const client = {
      addEventListener: vi.fn((listener: (event: { event: string; payload?: unknown }) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      request: vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method === "chat.abort") {
          expect(params).toEqual({ sessionKey: "main", runId });
          return { ok: true, aborted: true };
        }
        expect(method).toBe("talk.client.toolCall");
        expect(params.callId).toBe("call-1");
        expect(params.name).toBe(REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME);
        return { runId };
      }),
    } as unknown as RealtimeTalkTransportContext["client"];
    const transport = createTransport({ onStatus }, client);
    await transport.start();

    latestWebSocket().emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [
            {
              id: "call-1",
              name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
              args: { question: "check the session" },
            },
          ],
        },
      }),
    );
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("thinking", undefined));
    await vi.waitFor(() => expect(listeners.size).toBe(1));

    transport.stop();
    for (const listener of listeners) {
      listener({ event: "chat", payload: { runId, state: "final", message: { text: "done" } } });
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.request).toHaveBeenCalledWith("chat.abort", { sessionKey: "main", runId });
    expect(onStatus).not.toHaveBeenCalledWith("listening");
  });
});

describe("Google Live realtime Talk URL", () => {
  it("only preserves the allowlisted Google Live endpoint and appends the ephemeral token", () => {
    const url = buildGoogleLiveUrl(
      createSession(
        "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?ignored=1",
      ),
    );

    expect(url).toBe(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Fbrowser-session",
    );
  });

  it("rejects attacker-controlled Google Live WebSocket URLs", () => {
    expect(() =>
      buildGoogleLiveUrl(createSession("ws://generativelanguage.googleapis.com/ws/google.ai")),
    ).toThrow("wss://");
    expect(() =>
      buildGoogleLiveUrl(
        createSession(
          "wss://attacker.test/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
        ),
      ),
    ).toThrow("Untrusted Google Live WebSocket host");
    expect(() =>
      buildGoogleLiveUrl(createSession("wss://generativelanguage.googleapis.com/evil")),
    ).toThrow("Untrusted Google Live WebSocket path");
  });
});
