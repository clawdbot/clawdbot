import type { RealtimeVoiceBridgeCreateRequest } from "openclaw/plugin-sdk/realtime-voice";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoubaoRealtimeVoiceProvider } from "./realtime-voice-provider.js";
import {
  extractDoubaoSpeakableMessage,
  resamplePcm16Mono24kTo16k,
} from "./realtime-voice-utils.js";
import {
  DOUBAO_CLIENT_EVENT,
  DOUBAO_SERVER_EVENT,
  decodeDoubaoFrame,
  encodeDoubaoFrame,
} from "./realtime-wire.js";

type SocketListener = (...args: unknown[]) => void;

class FakeSocket {
  readyState = 0;
  readonly sent: Buffer[] = [];
  readonly listeners = new Map<string, SocketListener[]>();

  on(event: string, listener: SocketListener): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  send(data: Buffer): void {
    this.sent.push(Buffer.from(data));
  }

  close(): void {
    this.readyState = 3;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  serverFrame(event: number, payload: unknown, options?: { binary?: boolean }): void {
    this.emit(
      "message",
      encodeDoubaoFrame({
        messageType: options?.binary ? 0b1011 : 0b1001,
        event,
        sessionId: "session-test",
        serialization: options?.binary ? "raw" : "json",
        payload: options?.binary ? Buffer.from(payload as Uint8Array) : payload,
      }),
      true,
    );
  }
}

function createRequest(
  overrides: Partial<RealtimeVoiceBridgeCreateRequest> = {},
): RealtimeVoiceBridgeCreateRequest {
  return {
    providerConfig: {
      apiKey: "test-key", // pragma: allowlist secret
      model: "1.2.1.1",
      speakerVoice: "zh_male_yunzhou_jupiter_bigtts",
    },
    audioFormat: { encoding: "pcm16", sampleRateHz: 24000, channels: 1 },
    autoRespondToAudio: false,
    onAudio: vi.fn(),
    onClearAudio: vi.fn(),
    onTranscript: vi.fn(),
    onEvent: vi.fn(),
    onReady: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function decodeClientFrame(frame: Buffer) {
  const decoded = decodeDoubaoFrame(frame);
  if (!decoded) {
    throw new Error("expected a decodable Doubao frame");
  }
  return decoded;
}

async function connectBridge(request = createRequest()) {
  const socket = new FakeSocket();
  const provider = buildDoubaoRealtimeVoiceProvider({
    createSocket: () => socket,
    connectTimeoutMs: 1_000,
  });
  const bridge = provider.createBridge(request);
  const connecting = bridge.connect();
  socket.open();

  expect(decodeClientFrame(socket.sent[0]!).event).toBe(DOUBAO_CLIENT_EVENT.StartConnection);
  socket.serverFrame(DOUBAO_SERVER_EVENT.ConnectionStarted, {});

  const startSession = decodeClientFrame(socket.sent[1]!);
  expect(startSession.event).toBe(DOUBAO_CLIENT_EVENT.StartSession);
  expect(startSession.sessionId).toBe("session-test");
  expect(startSession.jsonPayload).toMatchObject({
    asr: { audio_info: { format: "pcm", sample_rate: 16000, channel: 1 } },
    tts: {
      speaker: "zh_male_yunzhou_jupiter_bigtts",
      audio_config: { format: "pcm_s16le", sample_rate: 24000, channel: 1 },
    },
    dialog: { extra: { model: "1.2.1.1" } },
  });

  socket.serverFrame(DOUBAO_SERVER_EVENT.SessionStarted, {});
  await connecting;
  return { bridge, provider, request, socket };
}

describe("Doubao realtime binary framing", () => {
  it("round-trips gzipped JSON frames with a session id", () => {
    const encoded = encodeDoubaoFrame({
      messageType: 0b0001,
      event: DOUBAO_CLIENT_EVENT.StartSession,
      sessionId: "session-1",
      serialization: "json",
      payload: { dialog: { extra: { model: "1.2.1.1" } } },
    });

    expect(encoded[2]! & 0x0f).toBe(1);
    expect(decodeDoubaoFrame(encoded)).toMatchObject({
      event: DOUBAO_CLIENT_EVENT.StartSession,
      sessionId: "session-1",
      jsonPayload: { dialog: { extra: { model: "1.2.1.1" } } },
    });
  });

  it("decodes raw server audio payloads", () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    const decoded = decodeDoubaoFrame(
      encodeDoubaoFrame({
        messageType: 0b1011,
        event: DOUBAO_SERVER_EVENT.TTSResponse,
        sessionId: "session-1",
        serialization: "raw",
        payload: pcm,
      }),
    );

    expect(decoded?.binaryPayload).toEqual(pcm);
  });
});

describe("Doubao realtime voice provider", () => {
  beforeEach(() => vi.useRealTimers());

  it("requires a resolved API key and advertises the gateway relay contract", () => {
    const provider = buildDoubaoRealtimeVoiceProvider();

    expect(provider.isConfigured({ providerConfig: {} })).toBe(false);
    expect(provider.isConfigured({ providerConfig: { apiKey: "resolved-key" } })).toBe(true);
    expect(provider.capabilities).toMatchObject({
      transports: ["gateway-relay"],
      supportsBrowserSession: false,
      supportsBargeIn: true,
      supportsToolCalls: false,
    });
    expect(provider.capabilities).not.toHaveProperty("handlesAgentConsult");
    const internalApi = Reflect.get(
      provider,
      Symbol.for("openclaw.internal.realtime-voice-provider.v1"),
    ) as { resolveGatewayRelayCapabilities: () => Record<string, unknown> };
    expect(internalApi.resolveGatewayRelayCapabilities()).toMatchObject({
      supportsToolCalls: false,
      handlesAgentConsult: true,
    });
  });

  it("connects through StartConnection then StartSession without exposing the API key", async () => {
    const { request, socket } = await connectBridge();

    expect(request.onReady).toHaveBeenCalledTimes(1);
    expect(Buffer.concat(socket.sent).toString("utf8")).not.toContain("test-key");
  });

  it("resamples relay PCM16 24 kHz audio to the required 16 kHz input", async () => {
    const { bridge, socket } = await connectBridge();
    const input = Buffer.alloc(480 * 2);
    for (let index = 0; index < 480; index += 1) {
      input.writeInt16LE((index % 100) * 100, index * 2);
    }

    bridge.sendAudio(input);

    const audioFrame = decodeClientFrame(socket.sent.at(-1)!);
    expect(audioFrame.event).toBe(DOUBAO_CLIENT_EVENT.TaskRequest);
    expect(audioFrame.binaryPayload).toHaveLength(320 * 2);
  });

  it("publishes final ASR while dropping native model audio in agent-consult mode", async () => {
    const request = createRequest();
    const { socket } = await connectBridge(request);

    socket.serverFrame(DOUBAO_SERVER_EVENT.ASRInfo, { question_id: "q-1" });
    socket.serverFrame(DOUBAO_SERVER_EVENT.ASRResponse, {
      results: [{ text: "看看我的任务", is_interim: true }],
    });
    socket.serverFrame(DOUBAO_SERVER_EVENT.ASREnded, {});
    socket.serverFrame(DOUBAO_SERVER_EVENT.TTSSentenceStart, {
      tts_type: "default",
      text: "豆包原生回答",
    });
    socket.serverFrame(DOUBAO_SERVER_EVENT.TTSResponse, Buffer.from([1, 2]), { binary: true });

    expect(request.onClearAudio).toHaveBeenCalledWith("barge-in");
    expect(request.onTranscript).toHaveBeenCalledWith("user", "看看我的任务", false);
    expect(request.onTranscript).toHaveBeenCalledWith("user", "看看我的任务", true);
    expect(request.onAudio).not.toHaveBeenCalled();
  });

  it("injects the OpenClaw result with ChatTTSText and forwards only tagged audio", async () => {
    const request = createRequest();
    const { bridge, socket } = await connectBridge(request);

    bridge.sendUserMessage?.(
      [
        "OpenClaw finished checking. Speak this result naturally and concisely.",
        "Do not mention tool calls, JSON, or internal routing.",
        "",
        "你还有三项任务。",
      ].join("\n"),
    );

    const ttsFrames = socket.sent
      .map(decodeClientFrame)
      .filter((frame) => frame.event === DOUBAO_CLIENT_EVENT.ChatTTSText);
    expect(ttsFrames).toHaveLength(2);
    expect(ttsFrames[0]?.jsonPayload).toEqual({
      start: true,
      content: "你还有三项任务。",
      end: false,
    });
    expect(ttsFrames[1]?.jsonPayload).toEqual({ start: false, content: "", end: true });

    socket.serverFrame(DOUBAO_SERVER_EVENT.TTSSentenceStart, {
      tts_type: "chat_tts_text",
      text: "你还有三项任务。",
    });
    socket.serverFrame(DOUBAO_SERVER_EVENT.TTSResponse, Buffer.from([1, 2, 3, 4]), {
      binary: true,
    });
    socket.serverFrame(DOUBAO_SERVER_EVENT.TTSEnded, {});

    expect(request.onTranscript).toHaveBeenCalledWith("assistant", "你还有三项任务。", true);
    expect(request.onAudio).toHaveBeenCalledWith(Buffer.from([1, 2, 3, 4]));
    expect(request.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ direction: "server", type: "response.audio.done" }),
    );
  });

  it("uses SayHello for a greeting before any user query", async () => {
    const request = createRequest();
    const { bridge, socket } = await connectBridge(request);

    bridge.triggerGreeting?.("你好，我是 OpenClaw。");

    const greeting = decodeClientFrame(socket.sent.at(-1)!);
    expect(greeting).toMatchObject({
      event: DOUBAO_CLIENT_EVENT.SayHello,
      jsonPayload: { content: "你好，我是 OpenClaw。" },
    });
    expect(request.onTranscript).toHaveBeenCalledWith("assistant", "你好，我是 OpenClaw。", true);
  });

  it("extracts exact OpenClaw status messages before TTS", () => {
    expect(
      extractDoubaoSpeakableMessage(
        [
          "Internal OpenClaw voice control result.",
          "Speak this exact OpenClaw status.",
          'Status: "已经停止当前任务。"',
        ].join("\n"),
      ),
    ).toBe("已经停止当前任务。");
  });
});

describe("24 kHz to 16 kHz PCM resampling", () => {
  it("preserves streaming continuity across odd chunk boundaries", () => {
    const samples = Buffer.alloc(9 * 2);
    for (let index = 0; index < 9; index += 1) {
      samples.writeInt16LE(index * 1_000, index * 2);
    }
    const state = { pending: Buffer.alloc(0), sourcePosition: 0 };

    const first = resamplePcm16Mono24kTo16k(samples.subarray(0, 5), state);
    const second = resamplePcm16Mono24kTo16k(samples.subarray(5), state);

    expect(Buffer.concat([first, second])).toHaveLength(6 * 2);
  });
});
