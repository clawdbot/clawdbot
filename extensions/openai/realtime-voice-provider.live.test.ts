// OpenAI tests cover the native realtime voice bridge against the live API.
import { describe, expect, it } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const LIVE_ENABLED = OPENAI_API_KEY.length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = LIVE_ENABLED ? describe : describe.skip;

describeLive("OpenAI realtime voice lifecycle live", () => {
  it("reuses a bridge after a terminal close", async () => {
    let closeCount = 0;
    let readyCount = 0;
    const errors: Error[] = [];
    const bridge = buildOpenAIRealtimeVoiceProvider().createBridge({
      providerConfig: {
        apiKey: OPENAI_API_KEY,
        model: "gpt-realtime-2.1",
        voice: "marin",
      },
      instructions: "Keep this lifecycle verification session silent.",
      autoRespondToAudio: false,
      onAudio: () => {},
      onClearAudio: () => {},
      onClose: () => {
        closeCount += 1;
      },
      onError: (error) => {
        errors.push(error);
      },
      onReady: () => {
        readyCount += 1;
      },
    });

    try {
      await bridge.connect();
      expect(bridge.isConnected()).toBe(true);
      bridge.close();

      await bridge.connect();
      expect(bridge.isConnected()).toBe(true);
    } finally {
      bridge.close();
    }

    expect(errors).toEqual([]);
    expect(readyCount).toBe(2);
    expect(closeCount).toBe(2);
  }, 60_000);
});
