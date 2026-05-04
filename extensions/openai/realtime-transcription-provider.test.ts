import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider.js";

const { FakeWebSocket } = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  class MockWebSocket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];

    readonly listeners = new Map<string, Listener[]>();
    readyState = 0;
    sent: string[] = [];
    closed = false;

    constructor() {
      MockWebSocket.instances.push(this);
    }

    on(event: string, listener: Listener): this {
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
      this.sent.push(payload);
    }

    close(code?: number, reason?: string): void {
      this.closed = true;
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
    }
  }

  return { FakeWebSocket: MockWebSocket };
});

vi.mock("ws", () => ({
  default: FakeWebSocket,
}));

type FakeWebSocketInstance = InstanceType<typeof FakeWebSocket>;
type SentRealtimeEvent = {
  type: string;
  audio?: string;
  session?: {
    input_audio_format?: string;
    input_audio_transcription?: {
      model?: string;
      language?: string;
      prompt?: string;
    };
    turn_detection?: {
      type?: string;
      threshold?: number;
      prefix_padding_ms?: number;
      silence_duration_ms?: number;
    };
  };
};

function parseSent(socket: FakeWebSocketInstance): SentRealtimeEvent[] {
  return socket.sent.map((payload) => JSON.parse(payload) as SentRealtimeEvent);
}

describe("buildOpenAIRealtimeTranscriptionProvider", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  it("normalizes OpenAI config defaults", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            apiKey: "sk-test", // pragma: allowlist secret
          },
        },
      },
    });

    expect(resolved).toEqual({
      apiKey: "sk-test",
    });
  });

  it("keeps provider-owned transcription settings configurable via raw provider config", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            language: "en",
            model: "gpt-4o-transcribe",
            prompt: "expect OpenClaw product names",
            silenceDurationMs: 900,
            vadThreshold: 0.45,
          },
        },
      },
    });

    expect(resolved).toEqual({
      language: "en",
      model: "gpt-4o-transcribe",
      prompt: "expect OpenClaw product names",
      silenceDurationMs: 900,
      vadThreshold: 0.45,
    });
  });

  it("preserves explicit zero-valued VAD settings", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const resolved = provider.resolveConfig?.({
      cfg: {} as never,
      rawConfig: {
        providers: {
          openai: {
            silenceDurationMs: 0,
            vadThreshold: 0,
          },
        },
      },
    });

    expect(resolved).toMatchObject({
      silenceDurationMs: 0,
      vadThreshold: 0,
    });
  });

  it("accepts the legacy openai-realtime alias", () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    expect(provider.aliases).toContain("openai-realtime");
  });

  it("waits for the OpenAI session update before draining audio", async () => {
    const provider = buildOpenAIRealtimeTranscriptionProvider();
    const session = provider.createSession({
      providerConfig: {
        apiKey: "sk-test", // pragma: allowlist secret
        language: "en",
        model: "gpt-4o-transcribe",
        prompt: "expect OpenClaw product names",
        silenceDurationMs: 900,
        vadThreshold: 0.45,
      },
    });

    const connecting = session.connect();
    const socket = FakeWebSocket.instances[0];
    if (!socket) {
      throw new Error("expected session to create a websocket");
    }

    socket.readyState = FakeWebSocket.OPEN;
    socket.emit("open");
    session.sendAudio(Buffer.from("before-ready"));

    expect(session.isConnected()).toBe(false);
    expect(parseSent(socket)).toEqual([
      {
        type: "transcription_session.update",
        session: {
          input_audio_format: "g711_ulaw",
          input_audio_transcription: {
            model: "gpt-4o-transcribe",
            language: "en",
            prompt: "expect OpenClaw product names",
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.45,
            prefix_padding_ms: 300,
            silence_duration_ms: 900,
          },
        },
      },
    ]);

    socket.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" })));
    await connecting;

    expect(session.isConnected()).toBe(true);
    expect(parseSent(socket)).toEqual([
      {
        type: "transcription_session.update",
        session: {
          input_audio_format: "g711_ulaw",
          input_audio_transcription: {
            model: "gpt-4o-transcribe",
            language: "en",
            prompt: "expect OpenClaw product names",
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.45,
            prefix_padding_ms: 300,
            silence_duration_ms: 900,
          },
        },
      },
      {
        type: "input_audio_buffer.append",
        audio: Buffer.from("before-ready").toString("base64"),
      },
    ]);
    session.close();
  });
});
