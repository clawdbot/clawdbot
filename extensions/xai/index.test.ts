import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  registerProviderPlugin,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import setupPlugin from "./setup-api.js";
import {
  createXaiPayloadCaptureStream,
  expectXaiFastToolStreamShaping,
  runXaiGrok4ResponseStream,
} from "./test-helpers.js";

function createProviderModel(overrides: {
  id: string;
  api?: string;
  baseUrl?: string;
  provider?: string;
}) {
  return {
    id: overrides.id,
    name: overrides.id,
    api: overrides.api ?? "openai-completions",
    provider: overrides.provider ?? "xai",
    baseUrl: overrides.baseUrl ?? "https://api.x.ai/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

type XaiAutoEnableProbe = Parameters<OpenClawPluginApi["registerAutoEnableProbe"]>[0];

function registerXaiAutoEnableProbe(): XaiAutoEnableProbe {
  const probes: XaiAutoEnableProbe[] = [];
  setupPlugin.register(
    createTestPluginApi({
      registerAutoEnableProbe(probe) {
        probes.push(probe);
      },
    }),
  );
  const probe = probes[0];
  if (!probe) {
    throw new Error("expected xAI setup plugin to register an auto-enable probe");
  }
  return probe;
}

function requireEntry<T extends { id?: string }>(entries: T[], id: string): T {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`Expected entry ${id}`);
  }
  return entry;
}

describe("xai provider plugin", () => {
  it("registers xAI speech providers for batch and streaming STT", async () => {
    const { mediaProviders, realtimeTranscriptionProviders } = await registerProviderPlugin({
      plugin,
      id: "xai",
      name: "xAI Provider",
    });

    const mediaProvider = requireEntry(mediaProviders, "xai");
    expect(mediaProvider.capabilities).toEqual(["audio"]);
    expect(mediaProvider.defaultModels).toEqual({ audio: "grok-stt" });
    const realtimeProvider = requireEntry(realtimeTranscriptionProviders, "xai");
    expect(realtimeProvider.label).toBe("xAI Realtime Transcription");
    expect(realtimeProvider.aliases).toContain("xai-realtime");
  });

  it("declares setup auto-enable reasons for plugin-owned tool config", () => {
    const probe = registerXaiAutoEnableProbe();

    expect(
      probe({
        config: { plugins: { entries: { xai: { config: { xSearch: { enabled: true } } } } } },
        env: {},
      }),
    ).toBe("xai tool configured");
    expect(
      probe({
        config: {
          plugins: { entries: { xai: { config: { codeExecution: { enabled: true } } } } },
        },
        env: {},
      }),
    ).toBe("xai tool configured");
    expect(probe({ config: {}, env: {} })).toBeNull();
  });

  it("owns replay policy for xAI OpenAI-compatible transports", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const completionsPolicy = provider.buildReplayPolicy?.({
      provider: "xai",
      modelApi: "openai-completions",
      modelId: "grok-3",
    } as never);
    expect(completionsPolicy?.sanitizeToolCallIds).toBe(true);
    expect(completionsPolicy?.toolCallIdMode).toBe("strict");
    expect(completionsPolicy?.applyAssistantFirstOrderingFix).toBe(true);
    expect(completionsPolicy?.validateGeminiTurns).toBe(true);
    expect(completionsPolicy?.validateAnthropicTurns).toBe(true);

    const responsesPolicy = provider.buildReplayPolicy?.({
      provider: "xai",
      modelApi: "openai-responses",
      modelId: "grok-4-fast",
    } as never);
    expect(responsesPolicy?.sanitizeToolCallIds).toBe(true);
    expect(responsesPolicy?.toolCallIdMode).toBe("strict");
    expect(responsesPolicy?.applyAssistantFirstOrderingFix).toBe(false);
    expect(responsesPolicy?.validateGeminiTurns).toBe(false);
    expect(responsesPolicy?.validateAnthropicTurns).toBe(false);
  });

  it("wires provider stream shaping for fast mode and tool-stream defaults", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const capture = createXaiPayloadCaptureStream();

    const wrapped = provider.wrapStreamFn?.({
      provider: "xai",
      modelId: "grok-4",
      extraParams: { fastMode: true },
      streamFn: capture.streamFn,
    } as never);

    runXaiGrok4ResponseStream(wrapped);
    expectXaiFastToolStreamShaping(capture);
  });

  it("defaults tool_stream extra params but preserves explicit values", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.prepareExtraParams?.({
        provider: "xai",
        modelId: "grok-4",
        extraParams: { fastMode: true },
      } as never),
    ).toEqual({
      fastMode: true,
      tool_stream: true,
    });

    const explicit = { fastMode: true, tool_stream: false };
    expect(
      provider.prepareExtraParams?.({
        provider: "xai",
        modelId: "grok-4",
        extraParams: explicit,
      } as never),
    ).toBe(explicit);
  });

  it("owns forward-compatible Grok model resolution", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const resolved = provider.resolveDynamicModel?.({
      provider: "xai",
      modelId: "grok-4.3",
      modelRegistry: { find: () => null } as never,
      providerConfig: {
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
      },
    } as never);
    expect(resolved?.id).toBe("grok-4.3");
    expect(resolved?.provider).toBe("xai");
    expect(resolved?.api).toBe("openai-completions");
    expect(resolved?.baseUrl).toBe("https://api.x.ai/v1");
    expect(resolved?.reasoning).toBe(true);
    expect(resolved?.input).toEqual(["text", "image"]);
    expect(resolved?.contextWindow).toBe(1_000_000);
  });

  it("marks modern Grok refs without accepting multi-agent ids", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.isModernModelRef?.({
        provider: "xai",
        modelId: "grok-4.3",
      } as never),
    ).toBe(true);
    expect(
      provider.isModernModelRef?.({
        provider: "xai",
        modelId: "grok-4.20-multi-agent-experimental-beta-0304",
      } as never),
    ).toBe(false);
  });

  it("owns xai compat flags for direct and downstream routed models", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    const normalized = provider.normalizeResolvedModel?.({
      provider: "xai",
      modelId: "grok-4-1-fast",
      model: createProviderModel({ id: "grok-4-1-fast" }),
    } as never);
    expect(normalized?.thinkingLevelMap).toEqual({
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
    });
    const normalizedCompat = normalized?.compat as
      | {
          toolSchemaProfile?: string;
          nativeWebSearchTool?: boolean;
          toolCallArgumentsEncoding?: string;
        }
      | undefined;
    expect(normalizedCompat?.toolSchemaProfile).toBe("xai");
    expect(normalizedCompat?.nativeWebSearchTool).toBe(true);
    expect(normalizedCompat?.toolCallArgumentsEncoding).toBe("html-entities");

    const compat = provider.contributeResolvedModelCompat?.({
      provider: "openrouter",
      modelId: "x-ai/grok-4-1-fast",
      model: createProviderModel({
        id: "x-ai/grok-4-1-fast",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      }),
    } as never);
    expect(compat?.toolSchemaProfile).toBe("xai");
    expect(compat?.nativeWebSearchTool).toBe(true);
    expect(compat?.toolCallArgumentsEncoding).toBe("html-entities");
  });
});
