import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const LIVE = isLiveTestEnabled() && OPENAI_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

describeLive("openai tts live", () => {
  it("synthesizes audio through the speech provider", async () => {
    const speechProvider = buildOpenAISpeechProvider();

    const voices = await speechProvider.listVoices?.({});
    expect(voices?.some((voice) => voice.id === "alloy")).toBe(true);

    const providerConfig = {
      apiKey: OPENAI_API_KEY,
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
    };

    const audioFile = await speechProvider.synthesize({
      text: "OpenClaw OpenAI text to speech integration test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig,
      target: "audio-file",
      timeoutMs: 45_000,
    });
    expect(audioFile.outputFormat).toBe("mp3");
    expect(audioFile.fileExtension).toBe(".mp3");
    expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);

    const telephony = await speechProvider.synthesizeTelephony?.({
      text: "OpenClaw OpenAI telephony integration test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig,
      timeoutMs: 45_000,
    });
    expect(telephony?.outputFormat).toBe("pcm");
    expect(telephony?.sampleRate).toBe(24_000);
    expect(telephony?.audioBuffer.byteLength).toBeGreaterThan(512);
  }, 60_000);
});
