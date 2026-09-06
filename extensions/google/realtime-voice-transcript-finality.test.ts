import {
  LiveServerMessage,
  type LiveConnectParameters,
  type LiveServerContent,
} from "@google/genai";
import {
  createRealtimeVoiceSessionHarness,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGoogleRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const { connect, close: closeMock } = vi.hoisted(() => {
  const closeSession = vi.fn();
  return {
    close: closeSession,
    connect: vi.fn(async (_params: LiveConnectParameters) => ({ close: closeSession })),
  };
});
vi.mock("./google-genai-runtime.js", () => ({
  createGoogleGenAI: () => ({ live: { connect } }),
}));

function emitContent(serverContent: LiveServerContent): void {
  const params = connect.mock.calls.at(-1)?.[0];
  if (!params) {
    throw new Error("Expected Google Live connection");
  }
  params.callbacks.onmessage(Object.assign(new LiveServerMessage(), { serverContent }));
}

describe("Google Live transcript finality", () => {
  beforeEach(() => {
    connect.mockImplementation(async ({ callbacks }: LiveConnectParameters) => {
      callbacks.onopen?.();
      callbacks.onmessage(Object.assign(new LiveServerMessage(), { setupComplete: {} }));
      return { close: closeMock, sendRealtimeInput: vi.fn() };
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(["completed", "cancelled"] as const)(
    "reports %s only after the native model turn completes",
    async (status) => {
      const delivered: string[] = [];
      const onResponseDone = vi.fn((outcome: { status: string }) => {
        delivered.push(`done:${outcome.status}`);
      });
      const bridge = buildGoogleRealtimeVoiceProvider().createBridge({
        providerConfig: { apiKey: "test-key" },
        audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
        onAudio: () => delivered.push("audio"),
        onClearAudio: () => delivered.push("clear"),
        onTranscript: (_role, _text, isFinal) => {
          if (isFinal) {
            delivered.push("transcript");
          }
        },
        onResponseDone,
      });
      await bridge.connect();
      try {
        emitContent({
          outputTranscription: { text: "Hello." },
          modelTurn: {
            parts: [{ inlineData: { data: "AAAAAA==", mimeType: "audio/pcm;rate=24000" } }],
          },
        });
        emitContent(status === "cancelled" ? { interrupted: true } : { generationComplete: true });
        expect(onResponseDone).not.toHaveBeenCalled();
        emitContent({ turnComplete: true });
        expect(onResponseDone.mock.calls).toEqual([[{ status }]]);
        expect(delivered).toEqual(
          status === "cancelled"
            ? ["audio", "clear", "transcript", "done:cancelled"]
            : ["audio", "transcript", "done:completed"],
        );

        bridge.sendUserMessage?.("Continue when ready.");
        emitContent({ waitingForInput: true, turnComplete: true });
        expect(onResponseDone.mock.calls).toEqual([[{ status }], [{ status: "completed" }]]);
      } finally {
        bridge.close();
      }
    },
  );
  it("finalizes each live 3.1 spoken turn when finished is absent", async () => {
    const onTranscript = vi.fn();
    const bridge = buildGoogleRealtimeVoiceProvider().createBridge({
      providerConfig: { apiKey: "test-key" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onTranscript,
    });
    await bridge.connect();
    for (const [input, output] of [
      ["Please reply with the single word glacier.", "Glacier."],
      ["Now reply with the single word crystal.", "Crystal."],
    ]) {
      emitContent({ inputTranscription: { text: input } });
      emitContent({ outputTranscription: { text: output } });
      emitContent({ generationComplete: true });
      emitContent({ turnComplete: true });
    }
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([
      ["user", "Please reply with the single word glacier.", true],
      ["assistant", "Glacier.", true],
      ["user", "Now reply with the single word crystal.", true],
      ["assistant", "Crystal.", true],
    ]);
    bridge.close();
    expect(onTranscript.mock.calls.filter((call) => call[2])).toHaveLength(4);
  });

  it("stops delivering the frame when a final transcript callback closes the bridge", async () => {
    const onAudio = vi.fn();
    const onMark = vi.fn();
    const onResponseDone = vi.fn();
    const onTranscript = vi.fn(() => bridge.close());
    const bridge = buildGoogleRealtimeVoiceProvider().createBridge({
      providerConfig: { apiKey: "test-key" },
      onAudio,
      onMark,
      onClearAudio: vi.fn(),
      onTranscript,
      onResponseDone,
    });
    await bridge.connect();
    emitContent({
      inputTranscription: { text: "Stop" },
      outputTranscription: { text: "No further transcript" },
      modelTurn: {
        parts: [{ inlineData: { data: "AAAAAA==", mimeType: "audio/pcm;rate=24000" } }],
      },
      turnComplete: true,
    });
    expect(onTranscript.mock.calls).toEqual([["user", "Stop", true]]);
    expect(onAudio).not.toHaveBeenCalled();
    expect(onMark).not.toHaveBeenCalled();
    expect(onResponseDone).not.toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("releases successive empty text responses through the shared voice harness", async () => {
    const onResponseDone = vi.fn();
    const harness = createRealtimeVoiceSessionHarness({
      talk: {
        sessionId: "google-empty-response",
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
      },
      talkPayloads: {
        turnStarted: () => ({}),
        turnEnded: () => ({}),
        inputAudioDelta: () => ({}),
        outputAudioStarted: () => ({}),
        outputAudioDelta: () => ({}),
        outputAudioDone: () => ({}),
      },
    });
    const session = harness.createBridge({
      provider: buildGoogleRealtimeVoiceProvider(),
      providerConfig: { apiKey: "test-key" },
      audioSink: { sendAudio: vi.fn() },
      onResponseDone,
    });
    try {
      await session.connect();
      for (const text of ["Wait for more input.", "Keep waiting."]) {
        session.sendUserMessage(text);
        emitContent({ waitingForInput: true, turnComplete: true });
      }
      expect(onResponseDone.mock.calls).toEqual([
        [{ status: "completed" }],
        [{ status: "completed" }],
      ]);
    } finally {
      session.close();
      harness.close();
    }
  });
});
