import type { AssistantMessage } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { __testing as pluginLoaderTesting } from "../../../src/plugins/loader.js";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import type { SpeechProviderPlugin } from "../../../src/plugins/types.js";
import { withEnv } from "../../../src/test-utils/env.js";

type TtsRuntimeModule = typeof import("../../../src/tts/tts.js");

let ttsRuntime: TtsRuntimeModule;
let ttsRuntimePromise: Promise<TtsRuntimeModule> | null = null;
let completeSimple: typeof import("@mariozechner/pi-ai").completeSimple;
let getApiKeyForModelMock: typeof import("../../../src/agents/model-auth.js").getApiKeyForModel;
let requireApiKeyMock: typeof import("../../../src/agents/model-auth.js").requireApiKey;
let resolveModelAsyncMock: typeof import("../../../src/agents/pi-embedded-runner/model.js").resolveModelAsync;
let ensureCustomApiRegisteredMock: typeof import("../../../src/agents/custom-api-registry.js").ensureCustomApiRegistered;
let prepareModelForSimpleCompletionMock: typeof import("../../../src/agents/simple-completion-transport.js").prepareModelForSimpleCompletion;
let resolveTtsConfig: TtsRuntimeModule["resolveTtsConfig"];
let maybeApplyTtsToPayload: TtsRuntimeModule["maybeApplyTtsToPayload"];
let getTtsProvider: TtsRuntimeModule["getTtsProvider"];
let parseTtsDirectives: TtsRuntimeModule["_test"]["parseTtsDirectives"];
let resolveModelOverridePolicy: TtsRuntimeModule["_test"]["resolveModelOverridePolicy"];
let summarizeText: TtsRuntimeModule["_test"]["summarizeText"];
let getResolvedSpeechProviderConfig: TtsRuntimeModule["_test"]["getResolvedSpeechProviderConfig"];
let formatTtsProviderError: TtsRuntimeModule["_test"]["formatTtsProviderError"];
let sanitizeTtsErrorForLog: TtsRuntimeModule["_test"]["sanitizeTtsErrorForLog"];

vi.mock("@mariozechner/pi-ai", async () => {
  const original =
    await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...original,
    completeSimple: vi.fn(),
  };
});

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    getOAuthProviders: () => [],
    getOAuthApiKey: vi.fn(async () => null),
  };
});

function createResolvedModel(provider: string, modelId: string, api = "openai-completions") {
  return {
    model: {
      provider,
      id: modelId,
      name: modelId,
      api,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    },
    authStorage: { profiles: {} },
    modelRegistry: { find: vi.fn() },
  };
}

vi.mock("../../../src/agents/pi-embedded-runner/model.js", () => ({
  resolveModel: vi.fn((provider: string, modelId: string) =>
    createResolvedModel(provider, modelId),
  ),
  resolveModelAsync: vi.fn(async (provider: string, modelId: string) =>
    createResolvedModel(provider, modelId),
  ),
}));

vi.mock("../../../src/agents/model-auth.js", () => ({
  getApiKeyForModel: vi.fn(async () => ({
    apiKey: "test-api-key",
    source: "test",
    mode: "api-key",
  })),
  requireApiKey: vi.fn((auth: { apiKey?: string }) => auth.apiKey ?? ""),
}));

vi.mock("../../../src/agents/custom-api-registry.js", () => ({
  ensureCustomApiRegistered: vi.fn(),
}));

function asLegacyTtsConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function asLegacyOpenClawConfig(value: Record<string, unknown>): OpenClawConfig {
  return value as unknown as OpenClawConfig;
}

const mockAssistantMessage = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "openai",
  model: "gpt-4o-mini",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

function createSummarizeTextDeps() {
  return {
    completeSimple,
    getApiKeyForModel: getApiKeyForModelMock,
    prepareModelForSimpleCompletion: prepareModelForSimpleCompletionMock,
    requireApiKey: requireApiKeyMock,
    resolveModelAsync: resolveModelAsyncMock,
  };
}

function createOpenAiTelephonyCfg(model: "tts-1" | "gpt-4o-mini-tts"): OpenClawConfig {
  return asLegacyTtsConfig({
    messages: {
      tts: {
        provider: "openai",
        providers: {
          openai: {
            apiKey: "test-key",
            model,
            voice: "alloy",
            instructions: "Speak warmly",
          },
        },
      },
    },
  });
}

function createAudioBuffer(length = 2): Buffer {
  return Buffer.from(new Uint8Array(length).fill(1));
}

async function withMockedSpeechFetch(
  run: (fetchMock: ReturnType<typeof vi.fn>) => Promise<void>,
  audioLength: number,
) {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(audioLength),
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  try {
    await run(fetchMock);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function resolveBaseUrl(rawValue: unknown, fallback: string): string {
  return typeof rawValue === "string" && rawValue.trim() ? rawValue.replace(/\/+$/u, "") : fallback;
}

function resolveTestProviderConfig(
  rawConfig: Record<string, unknown>,
  providerId: string,
  ...aliases: string[]
): Record<string, unknown> {
  const providers =
    typeof rawConfig.providers === "object" &&
    rawConfig.providers !== null &&
    !Array.isArray(rawConfig.providers)
      ? (rawConfig.providers as Record<string, unknown>)
      : {};
  for (const key of [providerId, ...aliases]) {
    const direct = rawConfig[key];
    if (typeof direct === "object" && direct !== null && !Array.isArray(direct)) {
      return direct as Record<string, unknown>;
    }
    const nested = providers[key];
    if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
  }
  return {};
}

function buildTestOpenAISpeechProvider(): SpeechProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    autoSelectOrder: 10,
    resolveConfig: ({ rawConfig }) => {
      const config = resolveTestProviderConfig(rawConfig, "openai");
      return {
        ...config,
        baseUrl: resolveBaseUrl(
          config.baseUrl ?? process.env.OPENAI_TTS_BASE_URL,
          "https://api.openai.com/v1",
        ),
      };
    },
    parseDirectiveToken: ({ key, value, providerConfig }) => {
      if (key === "voice") {
        const baseUrl = resolveBaseUrl(
          (providerConfig as Record<string, unknown> | undefined)?.baseUrl,
          "https://api.openai.com/v1",
        );
        const isDefaultEndpoint = baseUrl === "https://api.openai.com/v1";
        const allowedVoices = new Set([
          "alloy",
          "ash",
          "ballad",
          "coral",
          "echo",
          "sage",
          "shimmer",
          "verse",
        ]);
        if (isDefaultEndpoint && !allowedVoices.has(value)) {
          return { handled: true, warnings: [`invalid OpenAI voice "${value}"`] };
        }
        return { handled: true, overrides: { voice: value } };
      }
      if (key === "model") {
        const baseUrl = resolveBaseUrl(
          (providerConfig as Record<string, unknown> | undefined)?.baseUrl,
          "https://api.openai.com/v1",
        );
        const isDefaultEndpoint = baseUrl === "https://api.openai.com/v1";
        const allowedModels = new Set(["tts-1", "tts-1-hd", "gpt-4o-mini-tts"]);
        if (isDefaultEndpoint && !allowedModels.has(value)) {
          return { handled: true, warnings: [`invalid OpenAI model "${value}"`] };
        }
        return { handled: true, overrides: { model: value } };
      }
      return { handled: false };
    },
    isConfigured: ({ providerConfig }) =>
      typeof (providerConfig as Record<string, unknown> | undefined)?.apiKey === "string" ||
      typeof process.env.OPENAI_API_KEY === "string",
    synthesize: async ({ text, providerConfig, providerOverrides }) => {
      const config = providerConfig as Record<string, unknown> | undefined;
      await fetch(`${resolveBaseUrl(config?.baseUrl, "https://api.openai.com/v1")}/audio/speech`, {
        method: "POST",
        body: JSON.stringify({
          input: text,
          model: providerOverrides?.model ?? config?.model ?? "gpt-4o-mini-tts",
          voice: providerOverrides?.voice ?? config?.voice ?? "alloy",
        }),
      });
      return {
        audioBuffer: createAudioBuffer(1),
        outputFormat: "mp3",
        fileExtension: ".mp3",
        voiceCompatible: true,
      };
    },
    synthesizeTelephony: async ({ text, providerConfig }) => {
      const config = providerConfig as Record<string, unknown> | undefined;
      const configuredModel = typeof config?.model === "string" ? config.model : undefined;
      const model = configuredModel ?? "tts-1";
      const configuredInstructions =
        typeof config?.instructions === "string" ? config.instructions : undefined;
      const instructions =
        model === "gpt-4o-mini-tts" ? configuredInstructions || undefined : undefined;
      await fetch(`${resolveBaseUrl(config?.baseUrl, "https://api.openai.com/v1")}/audio/speech`, {
        method: "POST",
        body: JSON.stringify({
          input: text,
          model,
          voice: config?.voice ?? "alloy",
          instructions,
        }),
      });
      return {
        audioBuffer: createAudioBuffer(2),
        outputFormat: "mp3",
        sampleRate: 24000,
      };
    },
    listVoices: async () => [{ id: "alloy", label: "Alloy" }],
  };
}

function buildTestMicrosoftSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "microsoft",
    label: "Microsoft",
    aliases: ["edge"],
    autoSelectOrder: 30,
    resolveConfig: ({ rawConfig }) => {
      const edgeConfig = resolveTestProviderConfig(rawConfig, "microsoft", "edge");
      return {
        ...edgeConfig,
        outputFormat: edgeConfig.outputFormat ?? "audio-24khz-48kbitrate-mono-mp3",
      };
    },
    isConfigured: ({ providerConfig }) =>
      (providerConfig as Record<string, unknown> | undefined)?.enabled !== false,
    synthesize: async () => ({
      audioBuffer: createAudioBuffer(),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: true,
    }),
    listVoices: async () => [{ id: "edge", label: "Edge" }],
  };
}

function buildTestElevenLabsSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "elevenlabs",
    label: "ElevenLabs",
    autoSelectOrder: 20,
    resolveConfig: ({ rawConfig }) => resolveTestProviderConfig(rawConfig, "elevenlabs"),
    parseDirectiveToken: ({ key, value, currentOverrides }) => {
      if (key === "voiceid") {
        return { handled: true, overrides: { voiceId: value } };
      }
      if (key === "stability") {
        return {
          handled: true,
          overrides: {
            voiceSettings: {
              ...(currentOverrides as { voiceSettings?: Record<string, unknown> } | undefined)
                ?.voiceSettings,
              stability: Number(value),
            },
          },
        };
      }
      if (key === "speed") {
        return {
          handled: true,
          overrides: {
            voiceSettings: {
              ...(currentOverrides as { voiceSettings?: Record<string, unknown> } | undefined)
                ?.voiceSettings,
              speed: Number(value),
            },
          },
        };
      }
      return { handled: false };
    },
    isConfigured: ({ providerConfig }) =>
      typeof (providerConfig as Record<string, unknown> | undefined)?.apiKey === "string" ||
      typeof process.env.ELEVENLABS_API_KEY === "string" ||
      typeof process.env.XI_API_KEY === "string",
    synthesize: async () => ({
      audioBuffer: createAudioBuffer(),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: true,
    }),
    listVoices: async () => [{ id: "eleven", label: "Eleven" }],
  };
}

function buildTestGoogleSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "google",
    label: "Google",
    autoSelectOrder: 50,
    resolveConfig: ({ rawConfig }) => resolveTestProviderConfig(rawConfig, "google"),
    isConfigured: ({ cfg, providerConfig }) =>
      typeof (providerConfig as Record<string, unknown> | undefined)?.apiKey === "string" ||
      typeof cfg?.models?.providers?.google?.apiKey === "string" ||
      typeof process.env.GEMINI_API_KEY === "string" ||
      typeof process.env.GOOGLE_API_KEY === "string",
    synthesize: async () => ({
      audioBuffer: createAudioBuffer(),
      outputFormat: "wav",
      fileExtension: ".wav",
      voiceCompatible: false,
    }),
    synthesizeTelephony: async () => ({
      audioBuffer: createAudioBuffer(),
      outputFormat: "pcm",
      sampleRate: 24_000,
    }),
    listVoices: async () => [{ id: "Kore", label: "Kore" }],
  };
}

async function loadTtsRuntime(): Promise<TtsRuntimeModule> {
  ttsRuntimePromise ??= import("../../../src/tts/tts.js");
  return await ttsRuntimePromise;
}

async function setupTtsRuntime() {
  ttsRuntime = await loadTtsRuntime();
  resolveTtsConfig = ttsRuntime.resolveTtsConfig;
  maybeApplyTtsToPayload = ttsRuntime.maybeApplyTtsToPayload;
  getTtsProvider = ttsRuntime.getTtsProvider;
  ({
    parseTtsDirectives,
    resolveModelOverridePolicy,
    summarizeText,
    getResolvedSpeechProviderConfig,
    formatTtsProviderError,
    sanitizeTtsErrorForLog,
  } = ttsRuntime._test);
}

function setupTestSpeechProviderRegistry() {
  prepareModelForSimpleCompletionMock = vi.fn(({ model }) => model);
  const registry = createEmptyPluginRegistry();
  registry.speechProviders = [
    { pluginId: "openai", provider: buildTestOpenAISpeechProvider(), source: "test" },
    { pluginId: "microsoft", provider: buildTestMicrosoftSpeechProvider(), source: "test" },
    { pluginId: "elevenlabs", provider: buildTestElevenLabsSpeechProvider(), source: "test" },
    { pluginId: "google", provider: buildTestGoogleSpeechProvider(), source: "test" },
  ];
  const { cacheKey } = pluginLoaderTesting.resolvePluginLoadCacheContext({ config: {} });
  setActivePluginRegistry(registry, cacheKey);
}

async function setupSummarizationMocks() {
  ({ completeSimple } = await import("@mariozechner/pi-ai"));
  ({ getApiKeyForModel: getApiKeyForModelMock, requireApiKey: requireApiKeyMock } =
    await import("../../../src/agents/model-auth.js"));
  ({ resolveModelAsync: resolveModelAsyncMock } =
    await import("../../../src/agents/pi-embedded-runner/model.js"));
  ({ ensureCustomApiRegistered: ensureCustomApiRegisteredMock } =
    await import("../../../src/agents/custom-api-registry.js"));
  vi.mocked(completeSimple).mockResolvedValue(
    mockAssistantMessage([{ type: "text", text: "Summary" }]),
  );
  vi.mocked(getApiKeyForModelMock).mockResolvedValue({
    apiKey: "test-api-key",
    source: "test",
    mode: "api-key",
  });
  vi.mocked(requireApiKeyMock).mockImplementation((auth: { apiKey?: string }) => auth.apiKey ?? "");
  vi.mocked(resolveModelAsyncMock).mockImplementation(
    async (provider: string, modelId: string) =>
      createResolvedModel(provider, modelId) as unknown as Awaited<
        ReturnType<typeof resolveModelAsyncMock>
      >,
  );
  vi.mocked(ensureCustomApiRegisteredMock).mockReset();
}

async function setupTtsContractTest() {
  await setupTtsRuntime();
  setupTestSpeechProviderRegistry();
  vi.clearAllMocks();
}

async function setupTtsSummarizationTest() {
  await setupTtsContractTest();
  await setupSummarizationMocks();
}

export function describeTtsConfigContract() {
  describe("tts config contract", () => {
    beforeEach(setupTtsContractTest);

    describe("resolveEdgeOutputFormat", () => {
      const baseCfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: { tts: {} },
      };

      it.each([
        {
          name: "default",
          cfg: baseCfg,
          expected: "audio-24khz-48kbitrate-mono-mp3",
        },
        {
          name: "override",
          cfg: {
            ...baseCfg,
            messages: {
              tts: {
                edge: { outputFormat: "audio-24khz-96kbitrate-mono-mp3" },
              },
            },
          } as unknown as OpenClawConfig,
          expected: "audio-24khz-96kbitrate-mono-mp3",
        },
      ] as const)("$name", ({ cfg, expected, name }) => {
        const config = resolveTtsConfig(cfg);
        const providerConfig = getResolvedSpeechProviderConfig(config, "microsoft") as {
          outputFormat?: string;
        };
        expect(providerConfig.outputFormat, name).toBe(expected);
      });
    });

    describe("parseTtsDirectives", () => {
      it("extracts overrides and strips directives when enabled", () => {
        const policy = resolveModelOverridePolicy({ enabled: true, allowProvider: true });
        const input =
          "Hello [[tts:provider=elevenlabs voiceId=pMsXgVXv3BLzUgSXRplE stability=0.4 speed=1.1]] world\n\n" +
          "[[tts:text]](laughs) Read the song once more.[[/tts:text]]";
        const result = parseTtsDirectives(input, policy);
        const elevenlabsOverrides = result.overrides.providerOverrides?.elevenlabs as
          | {
              voiceId?: string;
              voiceSettings?: { stability?: number; speed?: number };
            }
          | undefined;

        expect(result.cleanedText).not.toContain("[[tts:");
        expect(result.ttsText).toBe("(laughs) Read the song once more.");
        expect(result.overrides.provider).toBe("elevenlabs");
        expect(elevenlabsOverrides?.voiceId).toBe("pMsXgVXv3BLzUgSXRplE");
        expect(elevenlabsOverrides?.voiceSettings?.stability).toBe(0.4);
        expect(elevenlabsOverrides?.voiceSettings?.speed).toBe(1.1);
      });

      it("accepts edge as a legacy microsoft provider override", () => {
        const policy = resolveModelOverridePolicy({ enabled: true, allowProvider: true });
        const input = "Hello [[tts:provider=edge]] world";
        const result = parseTtsDirectives(input, policy);

        expect(result.overrides.provider).toBe("edge");
      });

      it("rejects provider override by default while keeping voice overrides enabled", () => {
        const policy = resolveModelOverridePolicy({ enabled: true });
        const input = "Hello [[tts:provider=edge voice=alloy]] world";
        const result = parseTtsDirectives(input, policy);
        const openaiOverrides = result.overrides.providerOverrides?.openai as
          | { voice?: string }
          | undefined;

        expect(result.overrides.provider).toBeUndefined();
        expect(openaiOverrides?.voice).toBe("alloy");
      });

      it("keeps text intact when overrides are disabled", () => {
        const policy = resolveModelOverridePolicy({ enabled: false });
        const input = "Hello [[tts:voice=alloy]] world";
        const result = parseTtsDirectives(input, policy);

        expect(result.cleanedText).toBe(input);
        expect(result.overrides.provider).toBeUndefined();
      });

      it("accepts custom voices and models when openaiBaseUrl is a non-default endpoint", () => {
        const policy = resolveModelOverridePolicy({ enabled: true });
        const input = "Hello [[tts:voice=kokoro-chinese model=kokoro-v1]] world";
        const result = parseTtsDirectives(input, policy, {
          providerConfigs: {
            openai: { baseUrl: "http://localhost:8880/v1" },
          },
        });
        const openaiOverrides = result.overrides.providerOverrides?.openai as
          | { voice?: string; model?: string }
          | undefined;

        expect(openaiOverrides?.voice).toBe("kokoro-chinese");
        expect(openaiOverrides?.model).toBe("kokoro-v1");
        expect(result.warnings).toHaveLength(0);
      });

      it("rejects unknown voices and models when openaiBaseUrl is the default OpenAI endpoint", () => {
        const policy = resolveModelOverridePolicy({ enabled: true });
        const input = "Hello [[tts:voice=kokoro-chinese model=kokoro-v1]] world";
        const result = parseTtsDirectives(input, policy, {
          providerConfigs: {
            openai: { baseUrl: "https://api.openai.com/v1" },
          },
        });
        const openaiOverrides = result.overrides.providerOverrides?.openai as
          | { voice?: string }
          | undefined;

        expect(openaiOverrides?.voice).toBeUndefined();
        expect(result.warnings).toContain('invalid OpenAI voice "kokoro-chinese"');
      });
    });

    describe("getTtsProvider", () => {
      it.each([
        {
          name: "openai key available",
          env: {
            OPENAI_API_KEY: "test-openai-key",
            ELEVENLABS_API_KEY: undefined,
            XI_API_KEY: undefined,
          },
          prefsPath: "/tmp/tts-prefs-openai.json",
          expected: "openai",
        },
        {
          name: "elevenlabs key available",
          env: {
            OPENAI_API_KEY: undefined,
            ELEVENLABS_API_KEY: "test-elevenlabs-key",
            XI_API_KEY: undefined,
          },
          prefsPath: "/tmp/tts-prefs-elevenlabs.json",
          expected: "elevenlabs",
        },
        {
          name: "falls back to microsoft",
          env: {
            OPENAI_API_KEY: undefined,
            ELEVENLABS_API_KEY: undefined,
            XI_API_KEY: undefined,
          },
          prefsPath: "/tmp/tts-prefs-microsoft.json",
          expected: "microsoft",
        },
      ] as const)("selects provider based on available API keys: $name", (testCase) => {
        withEnv(testCase.env, () => {
          const config = {
            auto: "off",
            mode: "final",
            provider: "openai",
            providerSource: "default",
            summaryModel: undefined,
            modelOverrides: resolveModelOverridePolicy(undefined),
            providerConfigs: {
              openai: {},
              microsoft: {},
              elevenlabs: {},
            },
            prefsPath: undefined,
            maxTextLength: 4000,
            timeoutMs: 30_000,
          } as ReturnType<typeof resolveTtsConfig>;
          const provider = getTtsProvider(config, testCase.prefsPath);
          expect(provider).toBe(testCase.expected);
        });
      });

      it("passes cfg into auto-selection so model-provider Google keys can configure TTS", () => {
        const cfg = asLegacyOpenClawConfig({
          agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
          models: {
            providers: {
              google: {
                apiKey: "model-provider-google-key",
              },
            },
          },
          messages: {
            tts: {
              providers: {
                microsoft: {
                  enabled: false,
                },
              },
            },
          },
        });
        const config = resolveTtsConfig(cfg);
        const prefsPath = `/tmp/tts-prefs-google-model-provider-${Date.now()}.json`;

        expect(getTtsProvider(config, prefsPath)).toBe("google");
      });
    });

    describe("resolveTtsConfig provider normalization", () => {
      it("normalizes legacy edge provider ids to microsoft", () => {
        const config = resolveTtsConfig(
          asLegacyOpenClawConfig({
            agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
            messages: {
              tts: {
                provider: "edge",
                providers: {
                  edge: {
                    enabled: true,
                  },
                },
              },
            },
          }),
        );

        expect(config.provider).toBe("microsoft");
        expect(getTtsProvider(config, "/tmp/tts-prefs-normalized.json")).toBe("microsoft");
      });
    });

    describe("resolveTtsConfig – openai.baseUrl", () => {
      const baseCfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        messages: { tts: {} },
      };

      it.each([
        {
          name: "default endpoint",
          cfg: baseCfg,
          env: { OPENAI_TTS_BASE_URL: undefined },
          expected: "https://api.openai.com/v1",
        },
        {
          name: "env override",
          cfg: baseCfg,
          env: { OPENAI_TTS_BASE_URL: "http://localhost:8880/v1" },
          expected: "http://localhost:8880/v1",
        },
        {
          name: "config wins over env",
          cfg: {
            ...baseCfg,
            messages: {
              tts: { ...baseCfg.messages!.tts, openai: { baseUrl: "http://my-server:9000/v1" } },
            },
          } as unknown as OpenClawConfig,
          env: { OPENAI_TTS_BASE_URL: "http://localhost:8880/v1" },
          expected: "http://my-server:9000/v1",
        },
        {
          name: "config slash trimming",
          cfg: {
            ...baseCfg,
            messages: {
              tts: {
                ...baseCfg.messages!.tts,
                openai: { baseUrl: "http://my-server:9000/v1///" },
              },
            },
          } as unknown as OpenClawConfig,
          env: { OPENAI_TTS_BASE_URL: undefined },
          expected: "http://my-server:9000/v1",
        },
        {
          name: "env slash trimming",
          cfg: baseCfg,
          env: { OPENAI_TTS_BASE_URL: "http://localhost:8880/v1/" },
          expected: "http://localhost:8880/v1",
        },
      ] as const)(
        "resolves openai.baseUrl from config/env with config precedence and slash trimming: $name",
        (testCase) => {
          withEnv(testCase.env, () => {
            const config = resolveTtsConfig(testCase.cfg);
            const openaiConfig = getResolvedSpeechProviderConfig(config, "openai") as {
              baseUrl?: string;
            };
            expect(openaiConfig.baseUrl, testCase.name).toBe(testCase.expected);
          });
        },
      );

      it("hydrates provider config lazily when no explicit speech provider is configured", () => {
        withEnv({ OPENAI_TTS_BASE_URL: "http://localhost:8880/v1" }, () => {
          const config = resolveTtsConfig(baseCfg);
          const openaiConfig = getResolvedSpeechProviderConfig(config, "openai", baseCfg) as {
            baseUrl?: string;
          };

          expect(config.provider).toBe("");
          expect(openaiConfig.baseUrl).toBe("http://localhost:8880/v1");
        });
      });
    });
  });
}

export function describeTtsSummarizationContract() {
  describe("tts summarization contract", () => {
    beforeEach(setupTtsSummarizationTest);

    const baseCfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: { tts: {} },
    };

    async function runSummarizeText(params?: {
      text?: string;
      targetLength?: number;
      cfg?: OpenClawConfig;
    }) {
      const cfg = params?.cfg ?? baseCfg;
      const config = resolveTtsConfig(cfg);
      return await summarizeText(
        {
          text: params?.text ?? "Long text to summarize",
          targetLength: params?.targetLength ?? 500,
          cfg,
          config,
          timeoutMs: 30_000,
        },
        createSummarizeTextDeps(),
      );
    }

    it("summarizes text and returns result with metrics", async () => {
      const mockSummary = "This is a summarized version of the text.";
      vi.mocked(completeSimple).mockResolvedValue(
        mockAssistantMessage([{ type: "text", text: mockSummary }]),
      );

      const longText = "A".repeat(2000);
      const result = await runSummarizeText({
        text: longText,
        targetLength: 1500,
      });

      expect(result.summary).toBe(mockSummary);
      expect(result.inputLength).toBe(2000);
      expect(result.outputLength).toBe(mockSummary.length);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(completeSimple).toHaveBeenCalledTimes(1);
    });

    it("calls the summary model with the expected parameters", async () => {
      await runSummarizeText();

      const callArgs = vi.mocked(completeSimple).mock.calls[0];
      expect(callArgs?.[1]?.messages?.[0]?.role).toBe("user");
      expect(callArgs?.[2]?.maxTokens).toBe(250);
      expect(callArgs?.[2]?.temperature).toBe(0.3);
      expect(getApiKeyForModelMock).toHaveBeenCalledTimes(1);
    });

    it("uses summaryModel override when configured", async () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
        messages: { tts: { summaryModel: "openai/gpt-4.1-mini" } },
      };
      await runSummarizeText({ cfg });

      expect(resolveModelAsyncMock).toHaveBeenCalledWith("openai", "gpt-4.1-mini", undefined, cfg);
    });

    it("keeps the Ollama api for direct summarization", async () => {
      vi.mocked(resolveModelAsyncMock).mockResolvedValue({
        ...createResolvedModel("ollama", "qwen3:8b", "ollama"),
        model: {
          ...createResolvedModel("ollama", "qwen3:8b", "ollama").model,
          baseUrl: "http://127.0.0.1:11434",
        },
      } as never);

      await runSummarizeText();

      expect(vi.mocked(completeSimple).mock.calls[0]?.[0]?.api).toBe("ollama");
      expect(ensureCustomApiRegisteredMock).not.toHaveBeenCalled();
    });

    it.each([
      { targetLength: 99, shouldThrow: true },
      { targetLength: 100, shouldThrow: false },
      { targetLength: 10000, shouldThrow: false },
      { targetLength: 10001, shouldThrow: true },
    ] as const)("validates targetLength bounds: $targetLength", async (testCase) => {
      const call = runSummarizeText({ text: "text", targetLength: testCase.targetLength });
      if (testCase.shouldThrow) {
        await expect(call, String(testCase.targetLength)).rejects.toThrow(
          `Invalid targetLength: ${testCase.targetLength}`,
        );
      } else {
        await expect(call, String(testCase.targetLength)).resolves.toBeDefined();
      }
    });

    it.each([
      { name: "no summary blocks", message: mockAssistantMessage([]) },
      {
        name: "empty summary content",
        message: mockAssistantMessage([{ type: "text", text: "   " }]),
      },
    ] as const)("throws when summary output is missing or empty: $name", async (testCase) => {
      vi.mocked(completeSimple).mockResolvedValue(testCase.message);
      await expect(runSummarizeText({ text: "text" }), testCase.name).rejects.toThrow(
        "No summary returned",
      );
    });
  });
}

export function describeTtsProviderRuntimeContract() {
  describe("tts provider runtime contract", () => {
    beforeEach(setupTtsContractTest);

    describe("provider error redaction", () => {
      it("redacts sensitive tokens in provider errors", () => {
        const result = formatTtsProviderError(
          "openai",
          new Error("Authorization: Bearer sk-super-secret-token-1234567890"),
        );

        expect(result).toContain("openai:");
        expect(result).toContain("Authorization: Bearer");
        expect(result).not.toContain("sk-super-secret-token-1234567890");
      });

      it("escapes control characters in verbose fallback error logs", () => {
        const result = sanitizeTtsErrorForLog(
          new Error("failed\nAuthorization: Bearer sk-super-secret-token-1234567890\tboom"),
        );

        expect(result).toContain("\\n");
        expect(result).toContain("\\t");
        expect(result).not.toContain("sk-super-secret-token-1234567890");
      });
    });

    describe("fallback readiness errors", () => {
      it("continues synthesize fallback when primary readiness checks throw", async () => {
        const throwingPrimary: SpeechProviderPlugin = {
          id: "openai",
          label: "OpenAI",
          autoSelectOrder: 10,
          resolveConfig: () => ({}),
          isConfigured: () => {
            throw new Error("Authorization: Bearer sk-readiness-throw-token-1234567890\nboom");
          },
          synthesize: async () => {
            throw new Error("unexpected synthesize call");
          },
        };
        const fallback: SpeechProviderPlugin = {
          id: "microsoft",
          label: "Microsoft",
          autoSelectOrder: 20,
          resolveConfig: () => ({}),
          isConfigured: () => true,
          synthesize: async () => ({
            audioBuffer: createAudioBuffer(2),
            outputFormat: "mp3",
            fileExtension: ".mp3",
            voiceCompatible: true,
          }),
        };
        const registry = createEmptyPluginRegistry();
        registry.speechProviders = [
          { pluginId: "openai", provider: throwingPrimary, source: "test" },
          { pluginId: "microsoft", provider: fallback, source: "test" },
        ];
        const { cacheKey } = pluginLoaderTesting.resolvePluginLoadCacheContext({ config: {} });
        setActivePluginRegistry(registry, cacheKey);

        const result = await ttsRuntime.synthesizeSpeech({
          text: "hello fallback",
          cfg: {
            messages: {
              tts: {
                provider: "openai",
              },
            },
          },
        });

        expect(result.success).toBe(true);
        if (!result.success) {
          throw new Error("expected fallback synthesis success");
        }
        expect(result.provider).toBe("microsoft");
        expect(result.fallbackFrom).toBe("openai");
        expect(result.attemptedProviders).toEqual(["openai", "microsoft"]);
        expect(result.attempts?.[0]).toMatchObject({
          provider: "openai",
          outcome: "failed",
          reasonCode: "provider_error",
        });
        expect(result.attempts?.[1]).toMatchObject({
          provider: "microsoft",
          outcome: "success",
          reasonCode: "success",
        });
      });

      it("continues telephony fallback when primary readiness checks throw", async () => {
        const throwingPrimary: SpeechProviderPlugin = {
          id: "primary-throws",
          label: "PrimaryThrows",
          autoSelectOrder: 10,
          resolveConfig: () => ({}),
          isConfigured: () => {
            throw new Error("Authorization: Bearer sk-telephony-throw-token-1234567890\tboom");
          },
          synthesize: async () => {
            throw new Error("unexpected synthesize call");
          },
        };
        const fallback: SpeechProviderPlugin = {
          id: "microsoft",
          label: "Microsoft",
          autoSelectOrder: 20,
          resolveConfig: () => ({}),
          isConfigured: () => true,
          synthesize: async () => ({
            audioBuffer: createAudioBuffer(2),
            outputFormat: "mp3",
            fileExtension: ".mp3",
            voiceCompatible: true,
          }),
          synthesizeTelephony: async () => ({
            audioBuffer: createAudioBuffer(2),
            outputFormat: "mp3",
            sampleRate: 24000,
          }),
        };
        const registry = createEmptyPluginRegistry();
        registry.speechProviders = [
          { pluginId: "primary-throws", provider: throwingPrimary, source: "test" },
          { pluginId: "microsoft", provider: fallback, source: "test" },
        ];
        const { cacheKey } = pluginLoaderTesting.resolvePluginLoadCacheContext({ config: {} });
        setActivePluginRegistry(registry, cacheKey);

        const result = await ttsRuntime.textToSpeechTelephony({
          text: "hello telephony fallback",
          cfg: {
            messages: {
              tts: {
                provider: "primary-throws",
              },
            },
          },
        });

        expect(result.success).toBe(true);
        if (!result.success) {
          throw new Error("expected telephony fallback success");
        }
        expect(result.provider).toBe("microsoft");
        expect(result.fallbackFrom).toBe("primary-throws");
        expect(result.attemptedProviders).toEqual(["primary-throws", "microsoft"]);
        expect(result.attempts?.[0]).toMatchObject({
          provider: "primary-throws",
          outcome: "failed",
          reasonCode: "provider_error",
        });
        expect(result.attempts?.[1]).toMatchObject({
          provider: "microsoft",
          outcome: "success",
          reasonCode: "success",
        });
      });

      it("does not double-prefix textToSpeech failure messages", async () => {
        const failingProvider: SpeechProviderPlugin = {
          id: "openai",
          label: "OpenAI",
          autoSelectOrder: 10,
          resolveConfig: () => ({}),
          isConfigured: () => true,
          synthesize: async () => {
            throw new Error("provider failed");
          },
        };
        const registry = createEmptyPluginRegistry();
        registry.speechProviders = [
          { pluginId: "openai", provider: failingProvider, source: "test" },
        ];
        const { cacheKey } = pluginLoaderTesting.resolvePluginLoadCacheContext({ config: {} });
        setActivePluginRegistry(registry, cacheKey);

        const result = await ttsRuntime.textToSpeech({
          text: "hello",
          cfg: {
            messages: {
              tts: {
                provider: "openai",
              },
            },
          },
          disableFallback: true,
        });

        expect(result.success).toBe(false);
        if (result.success) {
          throw new Error("expected synthesis failure");
        }
        expect(result.error).toBeDefined();
        const errorMessage = result.error ?? "";
        expect(errorMessage).toBe("TTS conversion failed: openai: provider failed");
        expect(errorMessage).not.toContain("TTS conversion failed: TTS conversion failed:");
        expect(errorMessage.match(/TTS conversion failed:/g)).toHaveLength(1);
      });
    });

    describe("textToSpeechTelephony – openai instructions", () => {
      async function expectTelephonyInstructions(
        model: "tts-1" | "gpt-4o-mini-tts",
        expectedInstructions: string | undefined,
      ) {
        await withMockedSpeechFetch(async (fetchMock) => {
          const result = await ttsRuntime.textToSpeechTelephony({
            text: "Hello there, friendly caller.",
            cfg: createOpenAiTelephonyCfg(model),
          });

          expect(result.success).toBe(true);
          expect(fetchMock).toHaveBeenCalledTimes(1);
          const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
          expect(typeof init.body).toBe("string");
          const body = JSON.parse(init.body as string) as Record<string, unknown>;
          expect(body.instructions).toBe(expectedInstructions);
        }, 2);
      }

      it.each([
        { name: "tts-1 omits instructions", model: "tts-1", expectedInstructions: undefined },
        {
          name: "gpt-4o-mini-tts keeps instructions",
          model: "gpt-4o-mini-tts",
          expectedInstructions: "Speak warmly",
        },
      ] as const)(
        "only includes instructions for supported telephony models: $name",
        async (testCase) => {
          await expectTelephonyInstructions(testCase.model, testCase.expectedInstructions);
        },
      );
    });
  });
}

export function describeTtsAutoApplyContract() {
  describe("tts auto-apply contract", () => {
    beforeEach(setupTtsContractTest);

    const baseCfg: OpenClawConfig = asLegacyOpenClawConfig({
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      messages: {
        tts: {
          auto: "inbound",
          provider: "openai",
          providers: {
            openai: { apiKey: "test-key", model: "gpt-4o-mini-tts", voice: "alloy" },
          },
        },
      },
    });

    const withMockedAutoTtsFetch = async (
      run: (fetchMock: ReturnType<typeof vi.fn>) => Promise<void>,
    ) => {
      const prevPrefs = process.env.OPENCLAW_TTS_PREFS;
      process.env.OPENCLAW_TTS_PREFS = `/tmp/tts-test-${Date.now()}.json`;
      try {
        await withMockedSpeechFetch(run, 1);
      } finally {
        process.env.OPENCLAW_TTS_PREFS = prevPrefs;
      }
    };

    const taggedCfg: OpenClawConfig = {
      ...baseCfg,
      messages: {
        ...baseCfg.messages!,
        tts: { ...baseCfg.messages!.tts, auto: "tagged" },
      },
    };

    async function expectAutoTtsOutcome(params: {
      cfg: OpenClawConfig;
      payload: { text: string };
      inboundAudio?: boolean;
      expectedFetchCalls: number;
      expectSamePayload: boolean;
    }) {
      await withMockedAutoTtsFetch(async (fetchMock) => {
        const result = await maybeApplyTtsToPayload({
          payload: params.payload,
          cfg: params.cfg,
          kind: "final",
          ...(params.inboundAudio !== undefined ? { inboundAudio: params.inboundAudio } : {}),
        });
        expect(fetchMock).toHaveBeenCalledTimes(params.expectedFetchCalls);
        if (params.expectSamePayload) {
          expect(result).toBe(params.payload);
        } else {
          expect(result.mediaUrl).toBeDefined();
        }
      });
    }

    it.each([
      {
        name: "inbound gating blocks non-audio",
        payload: { text: "Hello world" },
        inboundAudio: false,
        expectedFetchCalls: 0,
        expectSamePayload: true,
      },
      {
        name: "inbound gating blocks too-short cleaned text",
        payload: { text: "### **bold**" },
        inboundAudio: true,
        expectedFetchCalls: 0,
        expectSamePayload: true,
      },
      {
        name: "inbound gating allows audio with real text",
        payload: { text: "Hello world" },
        inboundAudio: true,
        expectedFetchCalls: 1,
        expectSamePayload: false,
      },
    ] as const)(
      "applies inbound auto-TTS gating by audio status and cleaned text length: $name",
      async (testCase) => {
        await expectAutoTtsOutcome({
          cfg: baseCfg,
          payload: testCase.payload,
          inboundAudio: testCase.inboundAudio,
          expectedFetchCalls: testCase.expectedFetchCalls,
          expectSamePayload: testCase.expectSamePayload,
        });
      },
    );

    it.each([
      {
        name: "plain text is skipped",
        payload: { text: "Hello world" },
        expectedFetchCalls: 0,
        expectSamePayload: true,
      },
      {
        name: "tagged text is synthesized",
        payload: { text: "[[tts:text]]Hello world[[/tts:text]]" },
        expectedFetchCalls: 1,
        expectSamePayload: false,
      },
    ] as const)("respects tagged-mode auto-TTS gating: $name", async (testCase) => {
      await expectAutoTtsOutcome({
        cfg: taggedCfg,
        payload: testCase.payload,
        expectedFetchCalls: testCase.expectedFetchCalls,
        expectSamePayload: testCase.expectSamePayload,
      });
    });
  });
}
