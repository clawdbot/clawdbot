// Google tests cover google plugin behavior.
import { toErrorObject as toLintErrorObject } from "openclaw/plugin-sdk/error-runtime";
import {
  completeSimple,
  type Model,
  type ProviderContext,
  type ProviderModel,
  type ProviderStreamFunction,
} from "openclaw/plugin-sdk/llm";
import { resolveFfmpegBin } from "openclaw/plugin-sdk/media-runtime";
import {
  createCapturedPluginRegistration,
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { normalizeTranscriptForMatch } from "openclaw/plugin-sdk/provider-test-contracts";
import type { RealtimeVoiceBridge } from "openclaw/plugin-sdk/realtime-voice";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { buildGoogleLiveCatalogProvider } from "./provider-catalog.js";
import { buildGoogleRealtimeVoiceProvider } from "./realtime-voice-provider.js";
import { createGeminiWebSearchProvider } from "./src/gemini-web-search-provider.js";

const GOOGLE_API_KEY =
  process.env.GEMINI_API_KEY?.trim() ||
  process.env.GOOGLE_API_KEY?.trim() ||
  process.env.GEMINI_PROVIDER_API_KEY?.trim() ||
  "";
const LIVE = isLiveTestEnabled() && GOOGLE_API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;

// Two 64x64 solid-red H.264 frames keep native-video proof bounded and reproducible.
const GOOGLE_LIVE_RED_VIDEO_BASE64 = [
  "AAAAJGZ0eXBpc29tAAACAGlzb21pc282aXNvMmF2YzFtcDQxAAAC5m1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAA",
  "AAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAIAAAHodHJhawAAAFx0a2hkAAAAAwAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAA",
  "AAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAABAAAAAQAAAAAABhG1kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAQAAAAAAA",
  "VcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAAS9taW5mAAAAFHZtaGQAAAABAAAA",
  "AAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAADvc3RibAAAAKNzdHNkAAAAAAAAAAEAAACTYXZj",
  "MQAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAABAAEAASAAAAEgAAAAAAAAAARVMYXZjNjIuMjguMTAyIGxpYngyNjQAAAAAAAAA",
  "AAAAABj//wAAAC1hdmNDAULACv/hABZnQsAK2hCbARAAAAMAEAAAAwAo8SJqAQAEaM4PyAAAABBwYXNwAAAAAQAAAAEAAAAQ",
  "c3R0cwAAAAAAAAAAAAAAEHN0c2MAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAChtdmV4",
  "AAAAIHRyZXgAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAAAAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGly",
  "YXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjYyLjEyLjEwMgAAAHhtb29mAAAAEG1m",
  "aGQAAAAAAAAAAQAAAGB0cmFmAAAAJHRmaGQAAAA5AAAAAQAAAAAAAAMKAABAAAAAACMBAQAAAAAAFHRmZHQBAAAAAAAAAAAA",
  "AAAAAAAgdHJ1bgAAAgUAAAACAAAAgAIAAAAAAAAjAAAACgAAADVtZGF0AAAAH2WIhDoRigACGPHAAED2OAAIeUnJyddddddd",
  "dddddeAAAAAGQZogF6CMAAAAQ21mcmEAAAArdGZyYQEAAAAAAAABAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAMKAQEBAAAAEG1m",
  "cm8AAAAAAAAAQw==",
].join("");

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

async function waitForGoogleLive(
  label: string,
  predicate: () => boolean,
  timeoutMs = 45_000,
  describeState?: () => unknown,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      const state = describeState?.();
      throw new Error(
        `Google live timeout waiting for ${label}${state === undefined ? "" : ` (${JSON.stringify(state)})`}`,
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

function shortGoogleLiveError(error: Error): string {
  return error.message
    .replace(/https?:\/\/\S+/giu, "<url>")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/gu, "<id>")
    .slice(0, 200);
}

const registerGooglePlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "google",
    name: "Google Provider",
  });

function registerGoogleRealtimeVoiceProvider() {
  const captured = createCapturedPluginRegistration({
    id: "google",
    name: "Google Provider",
    source: "test",
  });
  plugin.register(captured.api);
  return requireRegisteredProvider(captured.realtimeVoiceProviders, "google");
}

describeLive("google plugin live", () => {
  it.each(["gemini-3.7-flash", "gemini-3.5-flash-lite"])(
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

  it("understands native video through the registered Google chat transport", async () => {
    const catalog = await buildGoogleLiveCatalogProvider({
      apiKey: "GEMINI_API_KEY",
      discoveryApiKey: GOOGLE_API_KEY,
    });
    const definition = catalog.models.find((candidate) => candidate.id === "gemini-3.5-flash-lite");
    expect(definition, "gemini-3.5-flash-lite missing from Google models.list").toBeDefined();
    expect(definition?.input).toContain("video");

    const catalogModel = {
      ...definition!,
      provider: "google",
      baseUrl: catalog.baseUrl,
      api: "google-generative-ai",
    } as ProviderModel<"google-generative-ai">;
    const { providers } = await registerGooglePlugin();
    const provider = requireRegisteredProvider(providers, "google");
    const model = provider.normalizeResolvedModel?.({
      provider: "google",
      modelId: catalogModel.id,
      model: catalogModel,
    } as never) as ProviderModel<"google-generative-ai"> | undefined;
    expect(model?.input).toContain("video");
    if (!model) {
      throw new Error("registered Google provider did not prepare its native video model");
    }

    const registeredStream = provider.createStreamFn?.({
      provider: "google",
      modelId: model.id,
      model: model as never,
    });
    const streamFn = registeredStream as ProviderStreamFunction<"google-generative-ai"> | undefined;
    if (!streamFn) {
      throw new Error("registered Google provider did not create its native chat transport");
    }
    const context: ProviderContext = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "What single color fills this video? Reply with exactly RED, BLUE, or GREEN.",
            },
            {
              type: "video",
              mimeType: "video/mp4",
              data: GOOGLE_LIVE_RED_VIDEO_BASE64,
            },
          ],
          timestamp: Date.now(),
        },
      ],
    };

    const stream = await Promise.resolve(
      streamFn(model, context, { apiKey: GOOGLE_API_KEY, maxTokens: 16 }),
    );
    const response = await stream.result();
    expect(response.stopReason, response.errorMessage).not.toBe("error");
    const answer = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(" ");
    expect(answer).toMatch(/\bRED\b/iu);
  }, 90_000);

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

  it("talks back when ready owns the realtime session", async () => {
    const provider = buildGoogleRealtimeVoiceProvider();
    const finalAssistantTranscripts: string[] = [];
    const errors: Error[] = [];
    const closeReasons: string[] = [];
    const eventTypeCounts = new Map<string, number>();
    let outputAudioBytes = 0;
    let assistantPartialCount = 0;
    let lastAssistantOutputAt = 0;
    let readyCount = 0;
    const bridge: RealtimeVoiceBridge = provider.createBridge({
      providerConfig: { apiKey: GOOGLE_API_KEY },
      instructions: "Reply briefly and plainly.",
      onAudio: (audio) => {
        outputAudioBytes += audio.byteLength;
        lastAssistantOutputAt = Date.now();
      },
      onClearAudio: () => {},
      onTranscript: (role, text, isFinal) => {
        if (role !== "assistant") {
          return;
        }
        if (isFinal) {
          finalAssistantTranscripts.push(text);
        } else {
          assistantPartialCount += 1;
        }
        lastAssistantOutputAt = Date.now();
      },
      onEvent: (event) => {
        eventTypeCounts.set(event.type, (eventTypeCounts.get(event.type) ?? 0) + 1);
      },
      onReady: () => {
        readyCount += 1;
        bridge.triggerGreeting?.("Reply with exactly: OpenClaw Google realtime ready.");
      },
      onError: (error) => errors.push(error),
      onClose: (reason) => closeReasons.push(reason),
    });
    const describeState = () => ({
      readyCount,
      connected: bridge.isConnected(),
      outputAudioBytes,
      assistantPartialCount,
      assistantIdleMs: lastAssistantOutputAt === 0 ? 0 : Date.now() - lastAssistantOutputAt,
      assistantFinalCount: finalAssistantTranscripts.length,
      errors: errors.map(shortGoogleLiveError),
      closeReasons,
      eventTypeCounts: Object.fromEntries(
        [...eventTypeCounts.entries()].toSorted(([left], [right]) => left.localeCompare(right)),
      ),
    });

    try {
      await bridge.connect();
      // Gemini 3.1 can omit transcription.finished. Wait for output to go idle
      // before close terminalizes the buffered transcript.
      await waitForGoogleLive(
        "assistant response drain",
        () =>
          outputAudioBytes > 0 &&
          assistantPartialCount > 0 &&
          Date.now() - lastAssistantOutputAt >= 1_000,
        45_000,
        describeState,
      );
      expect(readyCount).toBe(1);
      expect(bridge.isConnected()).toBe(true);
      expect(outputAudioBytes).toBeGreaterThan(0);
      expect(assistantPartialCount).toBeGreaterThan(0);
      expect(errors).toStrictEqual([]);
    } finally {
      bridge.close();
    }

    await waitForGoogleLive(
      "final transcript and clean close",
      () => finalAssistantTranscripts.length > 0 && closeReasons.length === 1,
      5_000,
      describeState,
    );
    expect(finalAssistantTranscripts.some((text) => text.trim().length > 0)).toBe(true);
    expect(closeReasons).toEqual(["completed"]);
  }, 120_000);

  it("delivers a queued prompt through the registered lazy realtime bridge", async () => {
    const provider = registerGoogleRealtimeVoiceProvider();
    const finalAssistantTranscripts: string[] = [];
    const errors: Error[] = [];
    const closeReasons: string[] = [];
    let outputAudioBytes = 0;
    let assistantPartialCount = 0;
    let lastAssistantOutputAt = 0;
    let readyCount = 0;
    const bridge: RealtimeVoiceBridge = provider.createBridge({
      providerConfig: { apiKey: GOOGLE_API_KEY },
      instructions: "Reply briefly and plainly.",
      onAudio: (audio) => {
        outputAudioBytes += audio.byteLength;
        lastAssistantOutputAt = Date.now();
      },
      onClearAudio: () => {},
      onTranscript: (role, text, isFinal) => {
        if (role !== "assistant") {
          return;
        }
        if (isFinal) {
          finalAssistantTranscripts.push(text);
        } else {
          assistantPartialCount += 1;
        }
        lastAssistantOutputAt = Date.now();
      },
      onReady: () => {
        readyCount += 1;
      },
      onError: (error) => errors.push(error),
      onClose: (reason) => closeReasons.push(reason),
    });
    const describeState = () => ({
      readyCount,
      connected: bridge.isConnected(),
      outputAudioBytes,
      assistantPartialCount,
      assistantIdleMs: lastAssistantOutputAt === 0 ? 0 : Date.now() - lastAssistantOutputAt,
      assistantFinalCount: finalAssistantTranscripts.length,
      errors: errors.map(shortGoogleLiveError),
      closeReasons,
    });

    bridge.sendUserMessage?.("Reply with exactly: OpenClaw lazy bridge ready.");
    try {
      await bridge.connect();
      // Gemini 3.1 can omit transcription.finished. Wait for output to go idle
      // before close terminalizes the buffered transcript.
      await waitForGoogleLive(
        "queued assistant response drain",
        () =>
          outputAudioBytes > 0 &&
          assistantPartialCount > 0 &&
          Date.now() - lastAssistantOutputAt >= 1_000,
        45_000,
        describeState,
      );
      expect(readyCount).toBe(1);
      expect(bridge.isConnected()).toBe(true);
      expect(outputAudioBytes).toBeGreaterThan(0);
      expect(assistantPartialCount).toBeGreaterThan(0);
      expect(errors).toStrictEqual([]);
    } finally {
      bridge.close();
      bridge.close();
    }

    await waitForGoogleLive(
      "queued final transcript and clean close",
      () => finalAssistantTranscripts.length > 0 && closeReasons.length === 1,
      5_000,
      describeState,
    );
    expect(
      finalAssistantTranscripts.some((text) => {
        const normalized = normalizeTranscriptForMatch(text);
        return (
          normalized.includes("openclaw") &&
          normalized.includes("lazy") &&
          normalized.includes("bridge")
        );
      }),
    ).toBe(true);
    expect(closeReasons).toEqual(["completed"]);
  }, 120_000);

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
