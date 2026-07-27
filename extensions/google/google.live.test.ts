// Google tests cover google plugin behavior.
import { completeSimple, type Model } from "openclaw/plugin-sdk/llm";
import { resolveFfmpegBin } from "openclaw/plugin-sdk/media-runtime";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { normalizeTranscriptForMatch } from "openclaw/plugin-sdk/provider-test-contracts";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { buildGoogleLiveCatalogProvider } from "./provider-catalog.js";
import { createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

const GOOGLE_API_KEY =
  process.env.GEMINI_API_KEY?.trim() ||
  process.env.GOOGLE_API_KEY?.trim() ||
  process.env.GEMINI_PROVIDER_API_KEY?.trim() ||
  "";
const LIVE = isLiveTestEnabled() && GOOGLE_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

async function withGoogleApiEnvUnset<T>(fn: () => Promise<T>): Promise<T> {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const googleApiKey = process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try {
    return await fn();
  } finally {
    if (geminiApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = geminiApiKey;
    }
    if (googleApiKey === undefined) {
      delete process.env.GOOGLE_API_KEY;
    } else {
      process.env.GOOGLE_API_KEY = googleApiKey;
    }
  }
}

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

function hasTrustedFfmpegForLiveVoiceNote(): boolean {
  try {
    resolveFfmpegBin();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ffmpeg not found in trusted system directories")) {
      console.warn("[google:live] skip voice-note transcode: ffmpeg unavailable");
      return false;
    }
    throw error;
  }
}

const registerGooglePlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "google",
    name: "Google Provider",
  });

describeLive("google plugin live", () => {
  it.each(["gemini-3.6-flash", "gemini-3.5-flash-lite"])(
    "discovers and completes through %s",
    async (modelId) => {
      const provider = await buildGoogleLiveCatalogProvider({
        apiKey: "GEMINI_API_KEY",
        discoveryApiKey: GOOGLE_API_KEY,
      });
      const definition = provider.models.find((model) => model.id === modelId);
      expect(definition, `${modelId} missing from Google models.list`).toBeDefined();

      const response = await completeSimple(
        {
          ...definition!,
          provider: "google",
          baseUrl: provider.baseUrl,
          api: "google-generative-ai",
        } as Model<"google-generative-ai">,
        {
          messages: [
            {
              role: "user",
              content: "Reply with exactly: OpenClaw live catalog OK",
              timestamp: Date.now(),
            },
          ],
        },
        { apiKey: GOOGLE_API_KEY, maxTokens: 64 },
      );

      expect(response.stopReason).not.toBe("error");
      expect(response.content.some((block) => block.type === "text" && block.text.trim())).toBe(
        true,
      );
    },
    90_000,
  );

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
    if (!hasTrustedFfmpegForLiveVoiceNote()) {
      return;
    }

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
      throw toLintErrorObject(lastError, "Non-Error thrown");
    }

    expect(result?.provider).toBe("gemini");
    expect(typeof result?.content).toBe("string");
    expect((result!.content as string).length).toBeGreaterThan(20);
    expect(Array.isArray(result?.citations)).toBe(true);
  }, 120_000);

  it("runs Gemini web search through the Google model provider config fallback", async () => {
    await withGoogleApiEnvUnset(async () => {
      const provider = createGeminiWebSearchProvider();
      const tool = provider.createTool?.({
        config: {
          models: {
            providers: {
              google: {
                apiKey: GOOGLE_API_KEY,
              },
            },
          },
        },
        searchConfig: { provider: "gemini", cacheTtlMinutes: 0, timeoutSeconds: 90 },
      } as never);

      const result = await tool?.execute({ query: "OpenClaw GitHub", count: 1 });

      expect(process.env.GEMINI_API_KEY).toBeUndefined();
      expect(process.env.GOOGLE_API_KEY).toBeUndefined();
      expect(result?.provider).toBe("gemini");
      expect(typeof result?.content).toBe("string");
      expect((result!.content as string).length).toBeGreaterThan(20);
      expect(Array.isArray(result?.citations)).toBe(true);
      expect((result!.citations as unknown[]).length).toBeGreaterThan(0);
    });
  }, 120_000);
});

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
