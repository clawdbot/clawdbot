import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../../src/agents/live-test-helpers.js";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "../../test/helpers/plugins/provider-registration.js";
import { normalizeTranscriptForMatch } from "../../test/helpers/stt-live-audio.js";
import plugin from "./index.js";
import { createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

const GOOGLE_API_KEY =
  process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || "";
const LIVE = isLiveTestEnabled() && GOOGLE_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

const registerGooglePlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "google",
    name: "Google Provider",
  });

describeLive("google plugin live", () => {
  it("synthesizes speech through the registered provider", async () => {
    const { speechProviders } = await registerGooglePlugin();
    const provider = requireRegisteredProvider(speechProviders, "google");

    const audioFile = await provider.synthesize({
      text: "OpenClaw Google text to speech integration test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: { apiKey: GOOGLE_API_KEY },
      target: "audio-file",
      timeoutMs: 90_000,
    });

    expect(audioFile.outputFormat).toBe("wav");
    expect(audioFile.fileExtension).toBe(".wav");
    expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);
  }, 120_000);

  it("transcodes speech to Opus for voice-note targets", async () => {
    const { speechProviders } = await registerGooglePlugin();
    const provider = requireRegisteredProvider(speechProviders, "google");

    const audioFile = await provider.synthesize({
      text: "OpenClaw Google voice note integration test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: { apiKey: GOOGLE_API_KEY },
      target: "voice-note",
      timeoutMs: 90_000,
    });

    expect(audioFile.outputFormat).toBe("opus");
    expect(audioFile.fileExtension).toBe(".opus");
    expect(audioFile.voiceCompatible).toBe(true);
    expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(128);
  }, 120_000);

  it("transcribes synthesized speech through the media provider", async () => {
    const { mediaProviders, speechProviders } = await registerGooglePlugin();
    const speechProvider = requireRegisteredProvider(speechProviders, "google");
    const mediaProvider = requireRegisteredProvider(mediaProviders, "google");

    const phrase = "Testing Google audio transcription with pineapple.";
    const audioFile = await speechProvider.synthesize({
      text: phrase,
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: { apiKey: GOOGLE_API_KEY },
      target: "audio-file",
      timeoutMs: 90_000,
    });

    const transcript = await mediaProvider.transcribeAudio?.({
      buffer: audioFile.audioBuffer,
      fileName: "google-live.wav",
      mime: "audio/wav",
      apiKey: GOOGLE_API_KEY,
      timeoutMs: 90_000,
    });

    const normalized = normalizeTranscriptForMatch(transcript?.text ?? "");
    expect(normalized).toContain("google");
    expect(normalized).toContain("pineapple");
  }, 180_000);

  it("runs Gemini web search through the registered provider tool", async () => {
    const provider = createGeminiWebSearchProvider();
    const tool = provider.createTool?.({
      config: {},
      searchConfig: { gemini: { apiKey: GOOGLE_API_KEY }, cacheTtlMinutes: 0 },
    } as never);

    const result = await tool?.execute({ query: "OpenClaw GitHub", count: 1 });

    expect(result?.provider).toBe("gemini");
    expect(typeof result?.content).toBe("string");
    expect((result?.content as string).length).toBeGreaterThan(20);
    expect(Array.isArray(result?.citations)).toBe(true);
  }, 120_000);
});
