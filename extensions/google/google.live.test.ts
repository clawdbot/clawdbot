import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { normalizeTranscriptForMatch } from "openclaw/plugin-sdk/provider-test-contracts";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

const GOOGLE_API_KEY =
  process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim() || "";
const LIVE = isLiveTestEnabled() && GOOGLE_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

function isTransientGeminiSearchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AbortError") {
    return true;
  }
  const message = error.message.toLowerCase();
  return message.includes("timeout") || message.includes("aborted");
}

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
      searchConfig: { gemini: { apiKey: GOOGLE_API_KEY }, cacheTtlMinutes: 0, timeoutSeconds: 90 },
    } as never);

    let result: { provider?: string; content?: unknown; citations?: unknown } | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        result = await tool?.execute({ query: "OpenClaw GitHub", count: 1 });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (!isTransientGeminiSearchError(error) || attempt === 1) {
          throw error;
        }
      }
    }
    if (lastError) {
      throw lastError;
    }

    expect(result?.provider).toBe("gemini");
    expect(typeof result?.content).toBe("string");
    expect((result?.content as string).length).toBeGreaterThan(20);
    expect(Array.isArray(result?.citations)).toBe(true);
  }, 120_000);
});
