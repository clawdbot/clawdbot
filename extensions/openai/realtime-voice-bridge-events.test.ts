// Openai tests cover realtime voice provider plugin behavior.
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: mocks.execFileSyncMock,
  };
});

vi.mock("ws", () => ({
  default: mocks.FakeWebSocket,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuardMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
}));
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const {
  parseSent,
  createNativeBridge,
  connectReadyBridge,
  emitServerEvent,
  emitAssistantPlayback,
  expectedResponseCancelEvent,
  hasSentEventType,
  resetTestState,
  restoreTestEnvironment,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

describe("OpenAI realtime voice bridge events", () => {
  beforeEach(() => {
    resetTestState();
  });

  afterEach(() => {
    restoreTestEnvironment();
  });

  it.each([
    {
      $name: "input interruption disabled",
      bridgeOptions: { autoRespondToAudio: true, interruptResponseOnInputAudio: false },
    },
    {
      $name: "automatic audio responses disabled",
      bridgeOptions: { autoRespondToAudio: false },
    },
  ])("$name", async ({ bridgeOptions }) => {
    const onAudio = vi.fn();
    const onClearAudio = vi.fn();
    const bridge = createNativeBridge({ ...bridgeOptions, onAudio, onClearAudio });
    const socket = await connectReadyBridge(bridge);

    emitAssistantPlayback(socket);
    emitServerEvent(socket, { type: "input_audio_buffer.speech_started" });

    expect(onAudio).toHaveBeenCalledTimes(1);
    expect(onClearAudio).not.toHaveBeenCalled();
    expect(hasSentEventType(socket, "response.cancel")).toBe(false);
    expect(hasSentEventType(socket, "conversation.item.truncate")).toBe(false);
  });

  it.each([
    {
      name: "externally interrupted playback at the produced duration",
      producedAudioMs: 300,
      mediaElapsedMs: 300,
      bytesPerMs: 8,
      audioFormat: undefined,
      providerVad: false,
    },
    {
      name: "provider VAD after the media clock advances past produced audio",
      producedAudioMs: 3_700,
      mediaElapsedMs: 3_760,
      bytesPerMs: 8,
      audioFormat: undefined,
      providerVad: true,
    },
    {
      name: "provider VAD after a PCM16 playback clock overrun",
      producedAudioMs: 3_700,
      mediaElapsedMs: 3_760,
      bytesPerMs: 48,
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      providerVad: true,
    },
  ])(
    "truncates $name",
    async ({ producedAudioMs, mediaElapsedMs, bytesPerMs, audioFormat, providerVad }) => {
      const onAudio = vi.fn();
      const onClearAudio = vi.fn();
      const bridge = createNativeBridge({
        onAudio,
        onClearAudio,
        ...(audioFormat ? { audioFormat } : {}),
        ...(providerVad ? {} : { onMark: () => bridge.acknowledgeMark() }),
      });
      const socket = await connectReadyBridge(bridge);

      bridge.setMediaTimestamp(1000);
      emitAssistantPlayback(socket, { audio: Buffer.alloc(producedAudioMs * bytesPerMs) });
      bridge.setMediaTimestamp(1000 + mediaElapsedMs);

      if (providerVad) {
        emitServerEvent(socket, { type: "input_audio_buffer.speech_started" });
      } else {
        bridge.handleBargeIn?.({ audioPlaybackActive: true });
      }

      expect(onAudio).toHaveBeenCalledTimes(1);
      expect(onClearAudio).toHaveBeenCalledWith("barge-in");
      const truncation = parseSent(socket).findLast(
        (event) => event.type === "conversation.item.truncate",
      );
      expect(truncation).toEqual({
        type: "conversation.item.truncate",
        item_id: "item_1",
        content_index: 0,
        audio_end_ms: producedAudioMs,
      });
      expect(parseSent(socket).some((event) => event.type === "response.cancel")).toBe(
        !providerVad,
      );
    },
  );

  it("preserves FIFO playback acknowledgements after sustained output", async () => {
    const onClearAudio = vi.fn();
    const onMark = vi.fn();
    const bridge = createNativeBridge({
      onClearAudio,
      onMark,
    });
    const socket = await connectReadyBridge(bridge);

    bridge.setMediaTimestamp(1000);
    for (let index = 0; index < 300; index += 1) {
      emitServerEvent(socket, {
        type: "response.audio.delta",
        item_id: "item_1",
        delta: Buffer.from("assistant audio").toString("base64"),
      });
    }

    const marks = onMark.mock.calls.map(([markName]) => String(markName));
    expect(marks).toHaveLength(300);
    for (let index = 0; index < 299; index += 1) {
      bridge.acknowledgeMark();
    }
    bridge.setMediaTimestamp(1300);
    bridge.handleBargeIn?.();

    expect(parseSent(socket).slice(-1)).toEqual([
      {
        type: "conversation.item.truncate",
        item_id: "item_1",
        content_index: 0,
        audio_end_ms: 300,
      },
    ]);
    expect(onClearAudio).toHaveBeenCalledWith("barge-in");

    for (let index = 0; index < 300; index += 1) {
      emitServerEvent(socket, {
        type: "response.audio.delta",
        item_id: "item_1",
        delta: Buffer.from("assistant audio").toString("base64"),
      });
    }
    const latestMark = onMark.mock.calls.at(-1)?.[0];
    if (typeof latestMark !== "string") {
      throw new Error("expected a playback mark");
    }
    bridge.acknowledgeMark(latestMark);
    bridge.setMediaTimestamp(1600);
    bridge.handleBargeIn?.();

    expect(
      parseSent(socket).filter((event) => event.type === "conversation.item.truncate"),
    ).toHaveLength(1);
    bridge.close();
  });

  it("treats a later named mark as cumulative playback progress", async () => {
    const onMark = vi.fn();
    const bridge = createNativeBridge({ onMark });
    const socket = await connectReadyBridge(bridge);

    bridge.setMediaTimestamp(1000);
    for (let index = 0; index < 3; index += 1) {
      emitServerEvent(socket, {
        type: "response.audio.delta",
        item_id: "item_1",
        delta: Buffer.from("assistant audio").toString("base64"),
      });
    }
    const marks = onMark.mock.calls.map(([markName]) => String(markName));
    expect(marks).toHaveLength(3);

    bridge.acknowledgeMark(marks[2]);
    bridge.acknowledgeMark(marks[0]);
    bridge.acknowledgeMark(marks[1]);
    bridge.setMediaTimestamp(1300);
    bridge.handleBargeIn?.();

    expect(
      parseSent(socket).filter((event) => event.type === "conversation.item.truncate"),
    ).toHaveLength(0);
    bridge.close();
  });

  it("forwards current realtime output audio events", async () => {
    const onAudio = vi.fn();
    const onTranscript = vi.fn();
    const bridge = createNativeBridge({
      onAudio,
      onTranscript,
    });
    const socket = await connectReadyBridge(bridge);

    const audio = Buffer.from("assistant audio");
    emitServerEvent(socket, {
      type: "response.output_audio.delta",
      item_id: "item_1",
      delta: audio.toString("base64"),
    });
    emitServerEvent(socket, {
      type: "response.output_audio_transcript.done",
      transcript: "hello from current realtime events",
    });

    expect(onAudio).toHaveBeenCalledWith(audio);
    expect(onTranscript).toHaveBeenCalledWith(
      "assistant",
      "hello from current realtime events",
      true,
    );
  });

  it("surfaces input transcription failures with their provider error details", async () => {
    const onError = vi.fn();
    const onEvent = vi.fn();
    const bridge = createNativeBridge({ onError, onEvent });
    const socket = await connectReadyBridge(bridge);

    emitServerEvent(socket, {
      type: "conversation.item.input_audio_transcription.failed",
      item_id: "item_speech",
      error: { code: "decoder_failure", message: "speech decoder exploded" },
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "speech decoder exploded" }),
    );
    expect(onEvent).toHaveBeenCalledWith({
      direction: "server",
      type: "conversation.item.input_audio_transcription.failed",
      itemId: "item_speech",
      detail: "speech decoder exploded",
    });
  });

  it("preserves corrected final text from legacy realtime text events", async () => {
    const onTranscript = vi.fn();
    const bridge = createNativeBridge({ onTranscript });
    const socket = await connectReadyBridge(bridge);

    emitServerEvent(socket, { type: "response.text.delta", delta: "draft assistant" });
    emitServerEvent(socket, { type: "response.text.done", text: "corrected assistant" });

    expect(onTranscript.mock.calls).toEqual([
      ["assistant", "draft assistant", false],
      ["assistant", "corrected assistant", true],
    ]);
  });

  it.each([
    ["invalid alphabet", "not-base64!"],
    ["non-canonical pad bits", "ZE=="],
  ])("terminates the session for %s in output audio", async (_scenario, delta) => {
    const onAudio = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
    const bridge = createNativeBridge({
      onAudio,
      onError,
      onClose,
    });
    const socket = await connectReadyBridge(bridge);

    emitServerEvent(socket, { type: "response.output_audio.delta", item_id: "item_1", delta });

    expect(onAudio).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "OpenAI realtime stream returned malformed base64 audio data",
      }),
    );
    expect(onClose).toHaveBeenCalledWith("error");
    expect(socket.closed).toBe(true);
    await expect(bridge.connect()).rejects.toThrow(
      "OpenAI realtime stream returned malformed base64 audio data",
    );
  });

  it("forwards Codex-compatible legacy realtime audio and transcript events", async () => {
    const onAudio = vi.fn();
    const onTranscript = vi.fn();
    const bridge = createNativeBridge({
      onAudio,
      onTranscript,
    });
    const socket = await connectReadyBridge(bridge);

    const audio = Buffer.from("legacy assistant audio");
    emitServerEvent(socket, {
      type: "conversation.output_audio.delta",
      data: audio.toString("base64"),
      sample_rate: 24000,
      channels: 1,
    });
    emitServerEvent(socket, {
      type: "conversation.input_transcript.delta",
      delta: "partial user",
    });
    emitServerEvent(socket, {
      type: "conversation.output_transcript.delta",
      delta: "partial assistant",
    });
    emitServerEvent(socket, {
      type: "response.output_text.done",
      text: "final assistant text",
    });

    expect(onAudio).toHaveBeenCalledWith(audio);
    expect(onTranscript).toHaveBeenCalledWith("user", "partial user", false);
    expect(onTranscript).toHaveBeenCalledWith("assistant", "partial assistant", false);
    expect(onTranscript).toHaveBeenCalledWith("assistant", "final assistant text", true);
  });

  it("does not send duplicate response.cancel while cancellation is pending", async () => {
    const onEvent = vi.fn();
    const bridge = createNativeBridge({ onEvent });
    const socket = await connectReadyBridge(bridge);
    emitServerEvent(socket, { type: "response.created", response: { id: "resp_1" } });
    bridge.setMediaTimestamp(1000);
    emitServerEvent(socket, {
      type: "response.audio.delta",
      item_id: "item_1",
      delta: Buffer.alloc(2_400).toString("base64"),
    });
    bridge.setMediaTimestamp(1300);

    bridge.handleBargeIn?.({ audioPlaybackActive: true });
    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    expect(parseSent(socket).filter((event) => event.type === "response.cancel")).toHaveLength(1);
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "response.cancel",
      detail: "reason=barge-in",
    });
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "conversation.item.truncate",
      detail: "reason=barge-in audioEndMs=300",
    });
  });

  it("ignores zero-length playback barge-in without clearing audio", async () => {
    const onClearAudio = vi.fn();
    const onEvent = vi.fn();
    const bridge = createNativeBridge({
      onClearAudio,
      onEvent,
    });
    const socket = await connectReadyBridge(bridge);
    bridge.setMediaTimestamp(1000);
    emitAssistantPlayback(socket);

    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    expect(onClearAudio).not.toHaveBeenCalled();
    expect(hasSentEventType(socket, "response.cancel")).toBe(false);
    expect(parseSent(socket).some((event) => event.type === "conversation.item.truncate")).toBe(
      false,
    );
    expect(onEvent).toHaveBeenCalledWith({
      direction: "client",
      type: "conversation.item.truncate.skipped",
      detail: "reason=barge-in audioEndMs=0 minAudioEndMs=250",
    });
  });

  it("force-cancels zero-length playback barge-in for agent handoff fallback", async () => {
    const onClearAudio = vi.fn();
    const onEvent = vi.fn();
    const bridge = createNativeBridge({
      onClearAudio,
      onEvent,
    });
    const socket = await connectReadyBridge(bridge);
    bridge.setMediaTimestamp(1000);
    emitAssistantPlayback(socket);

    bridge.handleBargeIn?.({ audioPlaybackActive: true, force: true });

    expect(parseSent(socket).slice(-2)).toEqual([
      expectedResponseCancelEvent(),
      {
        type: "conversation.item.truncate",
        item_id: "item_1",
        content_index: 0,
        audio_end_ms: 0,
      },
    ]);
    expect(onClearAudio).toHaveBeenCalled();
    expect(
      onEvent.mock.calls.some(
        ([event]) => isRecord(event) && event.type === "conversation.item.truncate.skipped",
      ),
    ).toBe(false);
  });

  it("allows immediate playback barge-in when the minimum audio window is zero", async () => {
    const onClearAudio = vi.fn();
    const bridge = createNativeBridge({
      providerConfig: {
        apiKey: "test-api-key-test",
        minBargeInAudioEndMs: 0,
      },
      onClearAudio,
    });
    const socket = await connectReadyBridge(bridge);
    bridge.setMediaTimestamp(1000);
    emitAssistantPlayback(socket);

    bridge.handleBargeIn?.({ audioPlaybackActive: true });

    expect(onClearAudio).toHaveBeenCalledWith("barge-in");
    expect(parseSent(socket).slice(-2)).toEqual([
      expectedResponseCancelEvent(),
      {
        type: "conversation.item.truncate",
        item_id: "item_1",
        content_index: 0,
        audio_end_ms: 0,
      },
    ]);
  });
});
