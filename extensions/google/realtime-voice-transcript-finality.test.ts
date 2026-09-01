import {
  LiveServerMessage,
  type LiveConnectParameters,
  type LiveServerContent,
} from "@google/genai";
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
      return { close: closeMock };
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

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
    const onTranscript = vi.fn(() => bridge.close());
    const bridge = buildGoogleRealtimeVoiceProvider().createBridge({
      providerConfig: { apiKey: "test-key" },
      onAudio,
      onMark,
      onClearAudio: vi.fn(),
      onTranscript,
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
    expect(closeMock).toHaveBeenCalledOnce();
  });
});
