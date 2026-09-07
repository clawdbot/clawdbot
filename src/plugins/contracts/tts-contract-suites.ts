// TTS contract suites provide reusable text-to-speech plugin contract assertions.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedTtsConfig, SpeechProviderPlugin } from "openclaw/plugin-sdk/speech-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Model } from "../../llm/types.js";
import {
  createEmptyPluginRegistry,
  pluginRegistrationContractRegistry,
  setActivePluginRegistry,
} from "../../plugin-sdk/plugin-test-runtime.js";
import { withEnv, withEnvAsync } from "../../plugin-sdk/test-env.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";

type TtsRuntimeModule = typeof import("openclaw/plugin-sdk/tts-runtime");
type TtsCoreModule = typeof import("openclaw/plugin-sdk/speech-core");
type SummarizeTextDeps = NonNullable<Parameters<TtsCoreModule["summarizeText"]>[1]>;

let ttsRuntime: TtsRuntimeModule;
let ttsRuntimeInitialized = false;
let completeWithPreparedSimpleCompletionModel: SummarizeTextDeps["completeWithPreparedSimpleCompletionModel"];
let prepareSimpleCompletionModelMock: SummarizeTextDeps["prepareSimpleCompletionModel"];
let requireApiKeyMock: SummarizeTextDeps["requireApiKey"];
let summarizeTextCore: TtsCoreModule["summarizeText"];
let resolveTtsConfig: TtsRuntimeModule["resolveTtsConfig"];
let maybeApplyTtsToPayload: TtsRuntimeModule["maybeApplyTtsToPayload"];
let getTtsProvider: TtsRuntimeModule["getTtsProvider"];
let parseTtsDirectives: TtsRuntimeModule["testApi"]["parseTtsDirectives"];
let resolveModelOverridePolicy: TtsRuntimeModule["testApi"]["resolveModelOverridePolicy"];
let getResolvedSpeechProviderConfig: TtsRuntimeModule["testApi"]["getResolvedSpeechProviderConfig"];
let formatTtsProviderError: TtsRuntimeModule["testApi"]["formatTtsProviderError"];
let sanitizeTtsErrorForLog: TtsRuntimeModule["testApi"]["sanitizeTtsErrorForLog"];

const SPEECH_PROVIDER_ENV_KEYS = [
  ...new Set(
    pluginRegistrationContractRegistry.flatMap((entry) =>
      entry.speechProviderIds.flatMap((providerId) => entry.providerEnvVars[providerId] ?? []),
    ),
  ),
].toSorted((left, right) => left.localeCompare(right));

function isolatedSpeechProviderEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(SPEECH_PROVIDER_ENV_KEYS.map((key) => [key, undefined])),
    ...overrides,
  };
}

function withIsolatedSpeechProviderEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => T,
): T {
  return withEnv(isolatedSpeechProviderEnv(overrides), fn);
}

async function withIsolatedSpeechProviderEnvAsync<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  return await withEnvAsync(isolatedSpeechProviderEnv(overrides), fn);
}

vi.mock("openclaw/plugin-sdk/llm", () => {
  const getApiProvider = vi.fn(() => undefined);
  return {
    completeSimple: vi.fn(),
    createAssistantMessageEventStream: vi.fn(),
    getApiProvider,
    getModel: vi.fn(),
    streamSimple: vi.fn(),
  };
});

function createResolvedModel(provider: string, modelId: string) {
  return {
    model: {
      provider,
      id: modelId,
      name: modelId,
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    } satisfies Model<"openai-completions">,
    authStorage: { profiles: {} },
    modelRegistry: { find: vi.fn() },
  };
}

function asLegacyTtsConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function asLegacyOpenClawConfig(value: Record<string, unknown>): OpenClawConfig {
  return asLegacyTtsConfig(value);
}

function mockCallAt(mock: { mock: { calls: Array<Array<unknown>> } }, index: number): unknown[] {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected mock call at index ${index}`);
  }
  return call;
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
    completeWithPreparedSimpleCompletionModel,
    prepareSimpleCompletionModel: prepareSimpleCompletionModelMock,
    requireApiKey: requireApiKeyMock,
  };
}

function createAudioBuffer(length = 2): Buffer {
  return Buffer.from(new Uint8Array(length).fill(1));
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

const synthesizeTestSpeech = vi.fn<SpeechProviderPlugin["synthesize"]>(async () => ({
  audioBuffer: createAudioBuffer(),
  outputFormat: "mp3",
  fileExtension: ".mp3",
  voiceCompatible: true,
}));

function buildTestSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "test-speech",
    label: "Test speech",
    autoSelectOrder: 10,
    resolveConfig: ({ rawConfig }) => resolveTestProviderConfig(rawConfig, "test-speech"),
    parseDirectiveToken: ({ key, value }) =>
      key === "voice" ? { handled: true, overrides: { voice: value } } : { handled: false },
    isConfigured: ({ providerConfig }) => providerConfig.enabled === true,
    synthesize: synthesizeTestSpeech,
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

const loadTtsRuntime = createLazyRuntimeModule(() => import("../../plugin-sdk/tts-runtime.js"));

const loadTtsCore = createLazyRuntimeModule(() => import("../../plugin-sdk/speech-core.js"));

function createPrepareSimpleCompletionModelMock(): SummarizeTextDeps["prepareSimpleCompletionModel"] {
  return vi.fn(async ({ provider, modelId }) => ({
    model: createResolvedModel(provider, modelId).model,
    auth: {
      apiKey: "test-api-key",
      source: "test",
      mode: "api-key" as const,
    },
  })) as SummarizeTextDeps["prepareSimpleCompletionModel"];
}

async function setupTtsRuntime() {
  if (ttsRuntimeInitialized) {
    return;
  }
  ttsRuntime = await loadTtsRuntime();
  resolveTtsConfig = ttsRuntime.resolveTtsConfig;
  maybeApplyTtsToPayload = ttsRuntime.maybeApplyTtsToPayload;
  getTtsProvider = ttsRuntime.getTtsProvider;
  ({
    parseTtsDirectives,
    resolveModelOverridePolicy,
    getResolvedSpeechProviderConfig,
    formatTtsProviderError,
    sanitizeTtsErrorForLog,
  } = ttsRuntime.testApi);
  ttsRuntimeInitialized = true;
}

function setupTestSpeechProviderRegistry() {
  const registry = createEmptyPluginRegistry();
  registry.speechProviders = [
    { pluginId: "test-speech", provider: buildTestSpeechProvider(), source: "test" },
    { pluginId: "microsoft", provider: buildTestMicrosoftSpeechProvider(), source: "test" },
    { pluginId: "elevenlabs", provider: buildTestElevenLabsSpeechProvider(), source: "test" },
    { pluginId: "google", provider: buildTestGoogleSpeechProvider(), source: "test" },
  ];
  setActivePluginRegistry(registry);
}

function createResolvedSummarizationConfig(cfg: OpenClawConfig): ResolvedTtsConfig {
  const rawConfig = typeof cfg.tts === "object" && cfg.tts !== null ? cfg.tts : {};
  return {
    auto: "off",
    mode: rawConfig.mode ?? "final",
    provider: "",
    providerSource:
      typeof rawConfig.provider === "string" && rawConfig.provider ? "config" : "default",
    summaryModel: typeof rawConfig.summaryModel === "string" ? rawConfig.summaryModel : undefined,
    modelOverrides: {
      enabled: true,
      allowText: true,
      allowProvider: false,
      allowVoice: true,
      allowModelId: true,
      allowVoiceSettings: true,
      allowNormalization: true,
      allowSeed: true,
    },
    providerConfigs: {},
    personas: {},
    prefsPath: undefined,
    maxTextLength: typeof rawConfig.maxTextLength === "number" ? rawConfig.maxTextLength : 4096,
    timeoutMs: typeof rawConfig.timeoutMs === "number" ? rawConfig.timeoutMs : 30_000,
    rawConfig,
    sourceConfig: cfg,
  };
}

async function setupSummarizationMocks() {
  ({ summarizeText: summarizeTextCore } = await loadTtsCore());
  completeWithPreparedSimpleCompletionModel = vi.fn();
  prepareSimpleCompletionModelMock = createPrepareSimpleCompletionModelMock();
  requireApiKeyMock = vi.fn() as SummarizeTextDeps["requireApiKey"];
  vi.mocked(completeWithPreparedSimpleCompletionModel).mockResolvedValue(
    mockAssistantMessage([{ type: "text", text: "Summary" }]),
  );
  vi.mocked(requireApiKeyMock).mockImplementation((auth: { apiKey?: string }) => auth.apiKey ?? "");
}

async function setupTtsContractTest() {
  await setupTtsRuntime();
  setupTestSpeechProviderRegistry();
  vi.clearAllMocks();
}

async function setupTtsSummarizationTest() {
  vi.clearAllMocks();
  await setupSummarizationMocks();
}

export function describeTtsConfigContract() {
  describe("tts config contract", () => {
    beforeEach(setupTtsContractTest);

    describe("resolveEdgeOutputFormat", () => {
      const baseCfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
        tts: {},
      };

      it.each([
        {
          name: "default",
          cfg: baseCfg,
          expected: "audio-24khz-48kbitrate-mono-mp3",
        },
        {
          name: "override",
          cfg: asLegacyTtsConfig({
            ...baseCfg,
            tts: {
              edge: { outputFormat: "audio-24khz-96kbitrate-mono-mp3" },
            },
          }),
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
        const speechOverrides = result.overrides.providerOverrides?.["test-speech"] as
          | { voice?: string }
          | undefined;

        expect(result.overrides.provider).toBeUndefined();
        expect(speechOverrides?.voice).toBe("alloy");
      });

      it("keeps text intact when overrides are disabled", () => {
        const policy = resolveModelOverridePolicy({ enabled: false });
        const input = "Hello [[tts:voice=alloy]] world";
        const result = parseTtsDirectives(input, policy);

        expect(result.cleanedText).toBe(input);
        expect(result.overrides.provider).toBeUndefined();
      });
    });

    describe("getTtsProvider", () => {
      it.each([
        {
          name: "primary readiness succeeds",
          primaryConfigured: true,
          env: {
            ELEVENLABS_API_KEY: undefined,
            XI_API_KEY: undefined,
          },
          prefsPath: "/tmp/tts-prefs-primary.json",
          expected: "test-speech",
        },
        {
          name: "secondary readiness succeeds",
          primaryConfigured: false,
          env: {
            ELEVENLABS_API_KEY: "test-elevenlabs-key",
            XI_API_KEY: undefined,
          },
          prefsPath: "/tmp/tts-prefs-elevenlabs.json",
          expected: "elevenlabs",
        },
        {
          name: "falls back to microsoft",
          primaryConfigured: false,
          env: {
            ELEVENLABS_API_KEY: undefined,
            XI_API_KEY: undefined,
          },
          prefsPath: "/tmp/tts-prefs-microsoft.json",
          expected: "microsoft",
        },
      ] as const)("selects provider based on readiness: $name", (testCase) => {
        withIsolatedSpeechProviderEnv(testCase.env, () => {
          const config = {
            auto: "off",
            mode: "final",
            provider: "test-speech",
            providerSource: "default",
            summaryModel: undefined,
            modelOverrides: resolveModelOverridePolicy(undefined),
            providerConfigs: {
              "test-speech": { enabled: testCase.primaryConfigured },
              microsoft: {},
              elevenlabs: {},
            },
            personas: {},
            prefsPath: undefined,
            maxTextLength: 4000,
            timeoutMs: 30_000,
          } as ReturnType<typeof resolveTtsConfig>;
          const provider = getTtsProvider(config, testCase.prefsPath);
          expect(provider).toBe(testCase.expected);
        });
      });

      it("passes cfg into auto-selection so model-provider Google keys can configure TTS", () => {
        withIsolatedSpeechProviderEnv(
          {
            ELEVENLABS_API_KEY: undefined,
            XI_API_KEY: undefined,
            MINIMAX_API_KEY: undefined,
            GEMINI_API_KEY: undefined,
            GOOGLE_API_KEY: undefined,
          },
          () => {
            const cfg = asLegacyOpenClawConfig({
              agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
              models: {
                providers: {
                  google: {
                    apiKey: "model-provider-google-key",
                  },
                },
              },
              tts: {
                providers: {
                  microsoft: {
                    enabled: false,
                  },
                },
              },
            });
            const config = resolveTtsConfig(cfg);
            const prefsPath = `/tmp/tts-prefs-google-model-provider-${Date.now()}.json`;

            expect(getTtsProvider(config, prefsPath)).toBe("google");
          },
        );
      });
    });

    describe("resolveTtsConfig provider normalization", () => {
      it("normalizes legacy edge provider ids to microsoft", () => {
        const config = resolveTtsConfig(
          asLegacyOpenClawConfig({
            agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
            tts: {
              provider: "edge",
              providers: {
                edge: {
                  enabled: true,
                },
              },
            },
          }),
        );

        expect(config.provider).toBe("microsoft");
        expect(getTtsProvider(config, "/tmp/tts-prefs-normalized.json")).toBe("microsoft");
      });
    });
  });
}

export function describeTtsSummarizationContract() {
  describe("tts summarization contract", () => {
    beforeEach(setupTtsSummarizationTest);

    const baseCfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      tts: {},
    };

    async function runSummarizeText(params?: {
      text?: string;
      targetLength?: number;
      cfg?: OpenClawConfig;
    }) {
      const cfg = params?.cfg ?? baseCfg;
      const config = createResolvedSummarizationConfig(cfg);
      return await summarizeTextCore(
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
      vi.mocked(completeWithPreparedSimpleCompletionModel).mockResolvedValue(
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
      expect(completeWithPreparedSimpleCompletionModel).toHaveBeenCalledTimes(1);
    });

    it("calls the summary model with the expected parameters", async () => {
      await runSummarizeText();

      const callArgs = mockCallAt(vi.mocked(completeWithPreparedSimpleCompletionModel), 0);
      expect(
        (callArgs[0] as { context?: { messages?: Array<{ role?: string }> } } | undefined)?.context
          ?.messages?.[0]?.role,
      ).toBe("user");
      expect(
        (callArgs[0] as { options?: { maxTokens?: number } } | undefined)?.options?.maxTokens,
      ).toBe(250);
      expect(
        (callArgs[0] as { options?: { temperature?: number } } | undefined)?.options?.temperature,
      ).toBe(0.3);
      expect(requireApiKeyMock).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "test-api-key" }),
        "openai",
      );
    });

    it("uses summaryModel override when configured", async () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
        tts: { summaryModel: "openai/gpt-4.1-mini" },
      };
      await runSummarizeText({ cfg });

      expect(prepareSimpleCompletionModelMock).toHaveBeenCalledWith({
        cfg,
        provider: "openai",
        modelId: "gpt-4.1-mini",
      });
    });

    it("keeps native completion APIs for direct summarization", async () => {
      vi.mocked(prepareSimpleCompletionModelMock).mockResolvedValue({
        model: {
          ...createResolvedModel("local-summary", "demo-model").model,
          baseUrl: "http://127.0.0.1:4000/v1",
        },
        auth: { apiKey: "test-api-key", source: "test", mode: "api-key" },
      });

      await runSummarizeText();

      expect(
        (
          mockCallAt(vi.mocked(completeWithPreparedSimpleCompletionModel), 0)[0] as
            | { model?: { api?: string } }
            | undefined
        )?.model?.api,
      ).toBe("openai-completions");
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
        const result = await call;
        expect(typeof result.summary, String(testCase.targetLength)).toBe("string");
        expect(result.inputLength, String(testCase.targetLength)).toBe(4);
      }
    });

    it.each([
      { name: "no summary blocks", message: mockAssistantMessage([]) },
      {
        name: "empty summary content",
        message: mockAssistantMessage([{ type: "text", text: "   " }]),
      },
    ] as const)("throws when summary output is missing or empty: $name", async (testCase) => {
      vi.mocked(completeWithPreparedSimpleCompletionModel).mockResolvedValue(testCase.message);
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
      it.each([
        {
          name: "synthesize",
          primaryId: "openai",
          primaryLabel: "OpenAI",
          token: "sk-readiness-throw-token-1234567890",
          separator: "\n",
          text: "hello fallback",
        },
        {
          name: "telephony",
          primaryId: "primary-throws",
          primaryLabel: "PrimaryThrows",
          token: "sk-telephony-throw-token-1234567890",
          separator: "\t",
          text: "hello telephony fallback",
        },
      ])(
        "continues $name fallback when primary readiness checks throw",
        async ({ name, primaryId, primaryLabel, token, separator, text }) => {
          await withIsolatedSpeechProviderEnvAsync({}, async () => {
            const throwingPrimary: SpeechProviderPlugin = {
              id: primaryId,
              label: primaryLabel,
              autoSelectOrder: 10,
              resolveConfig: () => ({}),
              isConfigured: () => {
                throw new Error(`Authorization: Bearer ${token}${separator}boom`);
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
              ...(name === "telephony"
                ? {
                    synthesizeTelephony: async () => ({
                      audioBuffer: createAudioBuffer(2),
                      outputFormat: "mp3",
                      sampleRate: 24000,
                    }),
                  }
                : {}),
            };
            const registry = createEmptyPluginRegistry();
            registry.speechProviders = [
              { pluginId: primaryId, provider: throwingPrimary, source: "test" },
              { pluginId: "microsoft", provider: fallback, source: "test" },
            ];
            setActivePluginRegistry(registry);

            const params = { text, cfg: { tts: { provider: primaryId } } };
            const result =
              name === "telephony"
                ? await ttsRuntime.textToSpeechTelephony(params)
                : await ttsRuntime.synthesizeSpeech(params);

            expect(result.success).toBe(true);
            if (!result.success) {
              throw new Error(
                `expected ${name === "telephony" ? "telephony " : ""}fallback synthesis success`,
              );
            }
            expect(result.provider).toBe("microsoft");
            expect(result.fallbackFrom).toBe(primaryId);
            expect(result.attemptedProviders).toEqual([primaryId, "microsoft"]);
            expect(result.attempts).toHaveLength(2);
            expect(result.attempts?.[0]?.provider).toBe(primaryId);
            expect(result.attempts?.[0]?.outcome).toBe("failed");
            expect(result.attempts?.[0]?.reasonCode).toBe("provider_error");
            expect(result.attempts?.[0]?.persona).toBeUndefined();
            expect(result.attempts?.[0]?.personaBinding).toBe("none");
            expect(typeof result.attempts?.[0]?.latencyMs).toBe("number");
            expect(result.attempts?.[0]?.error).toContain(`${primaryId}: Authorization: Bearer`);
            expect(result.attempts?.[0]?.error).not.toContain(token);
            expect(result.attempts?.[1]?.provider).toBe("microsoft");
            expect(result.attempts?.[1]?.outcome).toBe("success");
            expect(result.attempts?.[1]?.reasonCode).toBe("success");
            expect(result.attempts?.[1]?.persona).toBeUndefined();
            expect(result.attempts?.[1]?.personaBinding).toBe("none");
            expect(typeof result.attempts?.[1]?.latencyMs).toBe("number");
            expect(result.attempts?.[1]?.error).toBeUndefined();
          });
        },
      );

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
        setActivePluginRegistry(registry);

        const result = await ttsRuntime.textToSpeech({
          text: "hello",
          cfg: {
            tts: {
              provider: "openai",
            },
          },
          disableFallback: true,
        });

        expect(result.success).toBe(false);
        if (result.success) {
          throw new Error("expected synthesis failure");
        }
        const errorMessage = result.error;
        if (typeof errorMessage !== "string") {
          throw new Error("expected synthesis failure error message");
        }
        expect(errorMessage).toBe("TTS conversion failed: openai: provider failed");
        expect(errorMessage).not.toContain("TTS conversion failed: TTS conversion failed:");
        expect(errorMessage.match(/TTS conversion failed:/g)).toHaveLength(1);
      });
    });
  });
}

export function describeTtsAutoApplyContract() {
  describe("tts auto-apply contract", () => {
    beforeAll(setupTtsRuntime);
    beforeEach(setupTtsContractTest);

    const baseCfg: OpenClawConfig = asLegacyOpenClawConfig({
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      tts: {
        auto: "inbound",
        provider: "test-speech",
        providers: {
          "test-speech": { enabled: true },
        },
      },
    });

    const taggedCfg: OpenClawConfig = {
      ...baseCfg,
      tts: { ...baseCfg.tts, auto: "tagged" },
    };

    async function expectAutoTtsOutcome(params: {
      cfg: OpenClawConfig;
      payload: { text: string };
      inboundAudio?: boolean;
      expectedSynthesisCalls: number;
      expectSamePayload: boolean;
    }) {
      await withEnvAsync({ OPENCLAW_TTS_PREFS: `/tmp/tts-test-${Date.now()}.json` }, async () => {
        const result = await maybeApplyTtsToPayload({
          payload: params.payload,
          cfg: params.cfg,
          kind: "final",
          ...(params.inboundAudio !== undefined ? { inboundAudio: params.inboundAudio } : {}),
        });
        expect(synthesizeTestSpeech).toHaveBeenCalledTimes(params.expectedSynthesisCalls);
        if (params.expectSamePayload) {
          expect(result).toBe(params.payload);
        } else if (typeof result.mediaUrl !== "string" || result.mediaUrl.length === 0) {
          throw new Error("expected auto TTS to attach mediaUrl");
        }
      });
    }

    it.each([
      {
        name: "inbound gating blocks non-audio",
        payload: { text: "Hello world" },
        inboundAudio: false,
        expectedSynthesisCalls: 0,
        expectSamePayload: true,
      },
      {
        name: "inbound gating blocks too-short cleaned text",
        payload: { text: "### **bold**" },
        inboundAudio: true,
        expectedSynthesisCalls: 0,
        expectSamePayload: true,
      },
      {
        name: "inbound gating allows audio with real text",
        payload: { text: "Hello world" },
        inboundAudio: true,
        expectedSynthesisCalls: 1,
        expectSamePayload: false,
      },
    ] as const)(
      "applies inbound auto-TTS gating by audio status and cleaned text length: $name",
      async (testCase) => {
        await expectAutoTtsOutcome({
          cfg: baseCfg,
          payload: testCase.payload,
          inboundAudio: testCase.inboundAudio,
          expectedSynthesisCalls: testCase.expectedSynthesisCalls,
          expectSamePayload: testCase.expectSamePayload,
        });
      },
    );

    it.each([
      {
        name: "plain text is skipped",
        payload: { text: "Hello world" },
        expectedSynthesisCalls: 0,
        expectSamePayload: true,
      },
      {
        name: "tagged text is synthesized",
        payload: { text: "[[tts:text]]Hello world[[/tts:text]]" },
        expectedSynthesisCalls: 1,
        expectSamePayload: false,
      },
    ] as const)("respects tagged-mode auto-TTS gating: $name", async (testCase) => {
      await expectAutoTtsOutcome({
        cfg: taggedCfg,
        payload: testCase.payload,
        expectedSynthesisCalls: testCase.expectedSynthesisCalls,
        expectSamePayload: testCase.expectSamePayload,
      });
    });
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
