// Tests for the universal OpenAI-compatible realtime transcription provider.
// These tests stub out the WebSocket transport so the protocol translation
// layer (binary audio out, JSON events in, partial/final transcript handling)
// can be exercised without a real STT service.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAiCompatibleRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static readonly instances: MockWebSocket[] = [];
  static onCreated: ((socket: MockWebSocket) => void) | undefined;
  static reset() {
    MockWebSocket.instances.length = 0;
    MockWebSocket.onCreated = undefined;
  }

  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly headers?: Record<string, string>;
  readonly url?: string;
  readyState = 0;
  sentText: string[] = [];
  sentBinary: Buffer[] = [];
  closed = false;

  constructor(url?: string, options?: { headers?: Record<string, string> }) {
    this.url = url;
    this.headers = options?.headers;
    MockWebSocket.instances.push(this);
    MockWebSocket.onCreated?.(this);
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  send(payload: string): void {
    this.sentText.push(payload);
  }

  close(code?: number, _reason?: string): void {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    this.emit("close", code ?? 1000, Buffer.from(""));
  }

  terminate(): void {
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
  }
}

vi.mock("ws", () => ({
  default: MockWebSocket,
}));

function lastSocket() {
  const socket = MockWebSocket.instances.at(-1);
  if (!socket) {
    throw new Error("expected at least one mock websocket");
  }
  return socket;
}

type SessionHarness = {
  sendAudio: (audio: Buffer) => void;
  close: () => void;
  isConnected: () => boolean;
  __test_emit: (rawJson: string) => void;
  __test_close: () => void;
};

function createRecordingSessionFactory() {
  return (options: unknown): SessionHarness => {
    const opts = options as {
      parseMessage?: (payload: Buffer) => unknown;
      onMessage?: (event: unknown, transport: unknown) => void;
      onClose?: () => void;
      sendAudio?: (audio: Buffer, transport: unknown) => void;
    };
    const transport = {
      sendBinary: vi.fn((payload: Buffer) => {
        const ws = MockWebSocket.instances.at(-1);
        if (ws) {
          ws.sentBinary.push(payload);
        }
      }),
      sendJson: vi.fn(),
      closeNow: vi.fn(),
      isOpen: () => true,
      isReady: () => true,
      markReady: () => undefined,
      failConnect: () => undefined,
      callbacks: undefined,
    };
    return {
      sendAudio: (audio: Buffer) => {
        opts.sendAudio?.(audio, transport);
      },
      close: () => transport.closeNow(),
      isConnected: () => true,
      __test_emit: (rawJson: string) => {
        const parsed = opts.parseMessage?.(Buffer.from(rawJson, "utf8"));
        if (parsed && opts.onMessage) {
          opts.onMessage(parsed, transport);
        }
      },
      __test_close: () => {
        opts.onClose?.();
      },
    };
  };
}

describe("openai-compatible-stt provider", () => {
  const originalEndpoint = process.env.OPENAI_COMPATIBLE_STT_ENDPOINT;
  const originalApiKey = process.env.OPENAI_COMPATIBLE_STT_API_KEY;

  beforeEach(() => {
    MockWebSocket.reset();
  });

  afterEach(() => {
    if (originalEndpoint === undefined) {
      delete process.env.OPENAI_COMPATIBLE_STT_ENDPOINT;
    } else {
      process.env.OPENAI_COMPATIBLE_STT_ENDPOINT = originalEndpoint;
    }
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_COMPATIBLE_STT_API_KEY;
    } else {
      process.env.OPENAI_COMPATIBLE_STT_API_KEY = originalApiKey;
    }
  });

  it("registers with the expected id and aliases", () => {
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    expect(provider.id).toBe("openai-compatible-stt");
    expect(provider.aliases).toEqual(
      expect.arrayContaining(["local-stt", "whisper-local", "openai-compat-stt"]),
    );
    expect(provider.label).toContain("universal");
    expect(provider.autoSelectOrder).toBe(80);
    expect(provider.defaultModel).toBe("whisper-1");
  });

  it("isConfigured requires a resolved endpoint", () => {
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    expect(provider.isConfigured({ providerConfig: {} })).toBe(false);
    expect(
      provider.isConfigured({
        providerConfig: { endpoint: "http://127.0.0.1:8765/ws/transcribe" },
      }),
    ).toBe(true);
  });

  it("throws when createSession is called without an endpoint", () => {
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    expect(() => provider.createSession({ providerConfig: {} })).toThrow(/endpoint URL/i);
  });

  it("translates http endpoint to ws and forwards audio as binary frames", () => {
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    const session = provider.createSession({
      providerConfig: { endpoint: "http://127.0.0.1:8765/ws/transcribe" },
      onPartial: vi.fn(),
      onTranscript: vi.fn(),
      onSpeechStart: vi.fn(),
      onError: vi.fn(),
    });
    const socket = lastSocket();
    expect(socket.url).toBe(
      "ws://127.0.0.1:8765/ws/transcribe?encoding=pcm_s16le&model=whisper-1&sample_rate=16000&interim_results=true",
    );
    const audio = Buffer.from([1, 2, 3, 4]);
    session.sendAudio(audio);
    expect(socket.sentBinary).toHaveLength(1);
    expect(socket.sentBinary[0]).toEqual(audio);
    expect(socket.sentText).toHaveLength(0);
  });

  it("forwards an Authorization bearer header when an apiKey is configured", () => {
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    provider.createSession({
      providerConfig: {
        endpoint: "https://stt.example.test/ws/transcribe",
        apiKey: "test-key",
      },
      onPartial: vi.fn(),
      onTranscript: vi.fn(),
      onError: vi.fn(),
    });
    const socket = lastSocket();
    expect(socket.url?.startsWith("wss://stt.example.test/")).toBe(true);
    expect(socket.headers).toEqual({ Authorization: "Bearer test-key" });
  });

  it("emits partial transcripts and finalizes them", () => {
    const onPartial = vi.fn();
    const onTranscript = vi.fn();
    const onSpeechStart = vi.fn();
    const onError = vi.fn();
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    const session = provider.createSession({
      providerConfig: { endpoint: "ws://127.0.0.1:8765/ws/transcribe" },
      onPartial,
      onTranscript,
      onSpeechStart,
      onError,
    });

    session.__test_emit(JSON.stringify({ type: "speech_start" }));
    expect(onSpeechStart).toHaveBeenCalledOnce();

    session.__test_emit(JSON.stringify({ type: "partial", text: "hello" }));
    expect(onPartial).toHaveBeenLastCalledWith("hello");

    session.__test_emit(JSON.stringify({ type: "partial", text: "hello world" }));
    expect(onPartial).toHaveBeenLastCalledWith("hello world");

    session.__test_emit(JSON.stringify({ type: "final", text: "hello world" }));
    expect(onTranscript).toHaveBeenLastCalledWith("hello world");
    expect(onPartial).toHaveBeenCalledTimes(2);

    // After a final, a new partial should not include the previous text.
    session.__test_emit(JSON.stringify({ type: "partial", text: "goodbye" }));
    expect(onPartial).toHaveBeenLastCalledWith("goodbye");
  });

  it("emits an error when the server sends an error event", () => {
    const onError = vi.fn();
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    const session = provider.createSession({
      providerConfig: { endpoint: "ws://127.0.0.1:8765/ws/transcribe" },
      onPartial: vi.fn(),
      onTranscript: vi.fn(),
      onError,
    });
    session.__test_emit(JSON.stringify({ type: "error", message: "model crashed" }));
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe("model crashed");
  });

  it("flushes the pending turn on socket close", () => {
    const onTranscript = vi.fn();
    const provider = buildOpenAiCompatibleRealtimeTranscriptionProvider({
      createRealtimeTranscriptionWebSocketSession: createRecordingSessionFactory(),
    });
    const session = provider.createSession({
      providerConfig: { endpoint: "ws://127.0.0.1:8765/ws/transcribe" },
      onPartial: vi.fn(),
      onTranscript,
      onError: vi.fn(),
    });
    session.__test_emit(JSON.stringify({ type: "partial", text: "in flight" }));
    session.__test_close();
    expect(onTranscript).toHaveBeenCalledWith("in flight");
  });
});
