import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple, type Model } from "openclaw/plugin-sdk/llm";
import { resolveFfmpegBin } from "openclaw/plugin-sdk/media-runtime";
// Minimax tests cover minimax plugin behavior.
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { extractNonEmptyAssistantText, isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { resolveMinimaxApiCost } from "./model-definitions.js";
import { buildMinimaxProvider } from "./provider-catalog.js";
import { buildMinimaxSpeechProvider } from "./speech-provider.js";
import { createMiniMaxWebSearchProvider } from "./src/minimax-web-search-provider.js";

const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY?.trim() ?? "";
const MINIMAX_SEARCH_KEY =
  process.env.MINIMAX_CODE_PLAN_KEY?.trim() ||
  process.env.MINIMAX_CODING_API_KEY?.trim() ||
  process.env.MINIMAX_OAUTH_TOKEN?.trim() ||
  MINIMAX_API_KEY ||
  "";
const MINIMAX_TTS_TOKEN_PLAN_KEY =
  process.env.MINIMAX_OAUTH_TOKEN?.trim() ||
  process.env.MINIMAX_CODE_PLAN_KEY?.trim() ||
  process.env.MINIMAX_CODING_API_KEY?.trim() ||
  "";
const describeLive =
  isLiveTestEnabled() && MINIMAX_SEARCH_KEY.length > 0 ? describe : describe.skip;
const describeTtsLive =
  isLiveTestEnabled() && MINIMAX_API_KEY.length > 0 ? describe : describe.skip;
const describeTokenPlanTtsLive =
  isLiveTestEnabled() && MINIMAX_TTS_TOKEN_PLAN_KEY.length > 0 ? describe : describe.skip;
const describeFastLaneLive =
  isLiveTestEnabled() && MINIMAX_API_KEY.length > 0 ? describe : describe.skip;

const registerMinimaxPlugin = () =>
  registerProviderPlugin({
    plugin,
    id: "minimax",
    name: "MiniMax Provider",
  });

function hasTrustedFfmpegForLiveVoiceNote(): boolean {
  try {
    resolveFfmpegBin();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ffmpeg not found in trusted system directories")) {
      console.warn("[minimax:live] skip voice-note transcode: ffmpeg unavailable");
      return false;
    }
    throw error;
  }
}

function resolveLiveTextModel(modelId: string): Model<"anthropic-messages"> {
  const provider = buildMinimaxProvider();
  const catalogModel = provider.models?.find((entry) => entry.id === modelId);
  if (!catalogModel) {
    throw new Error(`MiniMax catalog does not include ${modelId}`);
  }
  return {
    provider: "minimax",
    baseUrl: provider.baseUrl,
    ...catalogModel,
    api: "anthropic-messages",
  } as Model<"anthropic-messages">;
}

/**
 * Drives one real MiniMax turn through the registered provider's own
 * `wrapStreamFn`, capturing both halves of the fast-lane contract: the model
 * OpenClaw bills (`billedModel`) and the request body MiniMax receives
 * (`sentPayload`).
 */
async function runLiveMinimaxTurn(params: { modelId: string; fastMode: boolean }): Promise<{
  billedModel: Model<"anthropic-messages">;
  sentPayload: Record<string, unknown>;
  text: string;
}> {
  const { providers } = await registerMinimaxPlugin();
  const provider = requireRegisteredProvider(providers, "minimax");
  const model = resolveLiveTextModel(params.modelId);

  let billedModel: Model<"anthropic-messages"> | undefined;
  const captureThenStream: StreamFn = (routedModel, context, options) => {
    billedModel = routedModel as Model<"anthropic-messages">;
    return streamSimple(routedModel, context, options);
  };
  const wrapped =
    provider.wrapStreamFn?.({
      provider: "minimax",
      modelId: model.id,
      model,
      streamFn: captureThenStream,
      extraParams: { fastMode: params.fastMode },
    } as ProviderWrapStreamFnContext) ?? captureThenStream;

  let sentPayload: Record<string, unknown> | undefined;
  const stream = await wrapped(
    model,
    { messages: [{ role: "user", content: "Reply with exactly: LANE_OK", timestamp: Date.now() }] },
    {
      apiKey: MINIMAX_API_KEY,
      maxTokens: 256,
      onPayload: (payload) => {
        sentPayload = { ...(payload as Record<string, unknown>) };
      },
    },
  );
  const result = await stream.result();
  if (result.stopReason === "error") {
    throw new Error(result.errorMessage || "MiniMax returned an error");
  }
  if (!billedModel || !sentPayload) {
    throw new Error("MiniMax live turn did not reach the provider stream");
  }
  return { billedModel, sentPayload, text: extractNonEmptyAssistantText(result.content) ?? "" };
}

describeFastLaneLive("minimax fast lane live", () => {
  it("bills MiniMax-M2.7 /fast at the highspeed model's own rate", async () => {
    const { billedModel, sentPayload } = await runLiveMinimaxTurn({
      modelId: "MiniMax-M2.7",
      fastMode: true,
    });

    expect(billedModel.id).toBe("MiniMax-M2.7-highspeed");
    expect(sentPayload.model).toBe("MiniMax-M2.7-highspeed");
    // The pre-fix defect: the id was swapped while the standard M2.7 rate stayed.
    expect(billedModel.cost).toEqual(resolveMinimaxApiCost("MiniMax-M2.7-highspeed"));
    expect(billedModel.cost).not.toEqual(resolveMinimaxApiCost("MiniMax-M2.7"));
  }, 180_000);

  it("opts MiniMax-M3 /fast into the priority tier and bills it at 1.5x", async () => {
    const base = resolveMinimaxApiCost("MiniMax-M3");
    const { billedModel, sentPayload, text } = await runLiveMinimaxTurn({
      modelId: "MiniMax-M3",
      fastMode: true,
    });

    expect(text).toMatch(/LANE_OK/i);
    expect(billedModel.id).toBe("MiniMax-M3");
    expect(sentPayload.service_tier).toBe("priority");
    expect(billedModel.cost.input).toBeCloseTo(base.input * 1.5, 10);
    expect(billedModel.cost.output).toBeCloseTo(base.output * 1.5, 10);
    expect(billedModel.cost.cacheRead).toBeCloseTo(base.cacheRead * 1.5, 10);
  }, 180_000);

  it("leaves MiniMax-M3 on the standard tier and rate when fast mode is off", async () => {
    const { billedModel, sentPayload } = await runLiveMinimaxTurn({
      modelId: "MiniMax-M3",
      fastMode: false,
    });

    expect(billedModel.id).toBe("MiniMax-M3");
    expect(sentPayload.service_tier).toBeUndefined();
    expect(billedModel.cost).toEqual(resolveMinimaxApiCost("MiniMax-M3"));
  }, 180_000);
});

describeLive("minimax plugin live", () => {
  it("runs MiniMax web search through the provider tool", async () => {
    const provider = createMiniMaxWebSearchProvider();
    const tool = provider.createTool?.({
      config: {},
      searchConfig: { apiKey: MINIMAX_SEARCH_KEY, cacheTtlMinutes: 0 },
    } as never);

    const result = await tool?.execute({ query: "OpenClaw GitHub", count: 1 });

    expect(result?.provider).toBe("minimax");
    expect(result?.count).toBeGreaterThan(0);
    expect(Array.isArray(result?.results)).toBe(true);
  }, 120_000);
});

describeTtsLive("minimax tts live", () => {
  it("synthesizes TTS through the registered speech provider", async () => {
    const { speechProviders } = await registerMinimaxPlugin();
    const provider = requireRegisteredProvider(speechProviders, "minimax");

    const audioFile = await provider.synthesize({
      text: "OpenClaw MiniMax text to speech integration test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: { apiKey: MINIMAX_API_KEY },
      target: "audio-file",
      timeoutMs: 90_000,
    });

    expect(audioFile.outputFormat).toBe("mp3");
    expect(audioFile.fileExtension).toBe(".mp3");
    expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);
  }, 120_000);

  it("synthesizes MiniMax TTS as an Opus voice note", async () => {
    if (!hasTrustedFfmpegForLiveVoiceNote()) {
      return;
    }

    const provider = buildMinimaxSpeechProvider();

    const voiceNote = await provider.synthesize({
      text: "OpenClaw MiniMax voice note test OK.",
      cfg: { plugins: { enabled: true } } as never,
      providerConfig: { apiKey: MINIMAX_API_KEY },
      target: "voice-note",
      timeoutMs: 90_000,
    });

    expect(voiceNote.outputFormat).toBe("opus");
    expect(voiceNote.fileExtension).toBe(".opus");
    expect(voiceNote.voiceCompatible).toBe(true);
    expect(voiceNote.audioBuffer.byteLength).toBeGreaterThan(512);
  }, 120_000);
});

describeTokenPlanTtsLive("minimax token plan tts live", () => {
  it("synthesizes TTS with Token Plan auth without MINIMAX_API_KEY", async () => {
    const savedApiKey = process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    try {
      const provider = buildMinimaxSpeechProvider();

      const audioFile = await provider.synthesize({
        text: "OpenClaw MiniMax Token Plan text to speech integration test OK.",
        cfg: { plugins: { enabled: true } } as never,
        providerConfig: {},
        target: "audio-file",
        timeoutMs: 90_000,
      });

      expect(audioFile.outputFormat).toBe("mp3");
      expect(audioFile.fileExtension).toBe(".mp3");
      expect(audioFile.audioBuffer.byteLength).toBeGreaterThan(512);
    } finally {
      if (savedApiKey === undefined) {
        delete process.env.MINIMAX_API_KEY;
      } else {
        process.env.MINIMAX_API_KEY = savedApiKey;
      }
    }
  }, 120_000);
});
