// Exercise the public TTS runtime with the actual OpenAI speech provider in one module graph.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withEnv, withServer } from "openclaw/plugin-sdk/test-env";
import * as ttsRuntime from "openclaw/plugin-sdk/tts-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

const { resolveTtsConfig, getTtsProvider } = ttsRuntime;
const { parseTtsDirectives, resolveModelOverridePolicy, getResolvedSpeechProviderConfig } =
  ttsRuntime.testApi;

function asLegacyTtsConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function mockCallAt(mock: { mock: { calls: Array<Array<unknown>> } }, index: number): unknown[] {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected mock call at index ${index}`);
  }
  return call;
}

function createOpenAiSpeechCfg(model: "tts-1" | "gpt-4o-mini-tts"): OpenClawConfig {
  return asLegacyTtsConfig({
    tts: {
      provider: "openai",
      providers: {
        openai: {
          apiKey: "test-key",
          baseUrl: "https://api.openai.com/v1",
          model,
          voice: "alloy",
          instructions: "Speak warmly",
        },
      },
    },
  });
}

async function withHangingSpeechServer(
  partialBody: boolean,
  run: (
    baseUrl: string,
    getRequestCount: () => number,
    isConnectionClosed: () => boolean,
  ) => Promise<void>,
): Promise<void> {
  let requestCount = 0;
  let connectionClosed = false;
  await withServer(
    (_req, res) => {
      requestCount += 1;
      res.on("close", () => {
        connectionClosed = true;
      });
      if (partialBody) {
        res.writeHead(200, { "content-type": "audio/mpeg" });
        res.write(Buffer.alloc(16));
      }
      // Leave the response unfinished to prove the provider deadline also closes the connection.
    },
    async (baseUrl) => {
      await run(
        `${baseUrl}/v1`,
        () => requestCount,
        () => connectionClosed,
      );
    },
  );
}

async function withMockedSpeechFetch(
  run: (fetchMock: ReturnType<typeof vi.fn>) => Promise<void>,
  audioLength: number,
) {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn(async () => new Response(new Uint8Array(audioLength)));
  globalThis.fetch = fetchMock;
  try {
    await run(fetchMock);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("OpenAI speech public runtime contract", () => {
  let prefsPath: string;

  beforeEach(() => {
    prefsPath = path.join(tmpdir(), `openclaw-openai-tts-${randomUUID()}.json`);
    vi.stubEnv("OPENCLAW_TTS_PREFS", prefsPath);
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_TTS_BASE_URL", "");
    const registry = createEmptyPluginRegistry();
    registry.speechProviders = [
      { pluginId: "openai", provider: buildOpenAISpeechProvider(), source: "test" },
    ];
    setActivePluginRegistry(registry);
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
  });

  it.each([
    { name: "configured environment key", apiKey: "test-openai-key", expected: "openai" },
    { name: "missing environment key", apiKey: "", expected: "" },
  ])("selects OpenAI through public readiness resolution: $name", ({ apiKey, expected }) => {
    vi.stubEnv("OPENAI_API_KEY", apiKey);
    expect(getTtsProvider(resolveTtsConfig({ tts: {} }), prefsPath)).toBe(expected);
  });

  describe("parseTtsDirectives", () => {
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

  describe("resolveTtsConfig – openai.baseUrl", () => {
    const baseCfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } },
      tts: {},
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
        cfg: asLegacyTtsConfig({
          ...baseCfg,
          tts: { ...baseCfg.tts, openai: { baseUrl: "http://my-server:9000/v1" } },
        }),
        env: { OPENAI_TTS_BASE_URL: "http://localhost:8880/v1" },
        expected: "http://my-server:9000/v1",
      },
      {
        name: "config slash trimming",
        cfg: asLegacyTtsConfig({
          ...baseCfg,
          tts: {
            ...baseCfg.tts,
            openai: { baseUrl: "http://my-server:9000/v1///" },
          },
        }),
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
  it.each([
    {
      name: "tts-1 telephony omits instructions",
      model: "tts-1",
      expectedInstructions: undefined,
      responseFormat: "pcm",
      run: ttsRuntime.textToSpeechTelephony,
    },
    {
      name: "gpt-4o-mini-tts telephony keeps instructions",
      model: "gpt-4o-mini-tts",
      expectedInstructions: "Speak warmly",
      responseFormat: "pcm",
      run: ttsRuntime.textToSpeechTelephony,
    },
    {
      name: "ordinary synthesis keeps instructions",
      model: "gpt-4o-mini-tts",
      expectedInstructions: "Speak warmly",
      responseFormat: "mp3",
      run: ttsRuntime.synthesizeSpeech,
    },
  ] as const)(
    "forwards OpenAI config through public synthesis: $name",
    async ({ model, expectedInstructions, responseFormat, run }) => {
      await withMockedSpeechFetch(async (fetchMock) => {
        const result = await run({
          text: "Hello there, friendly caller.",
          cfg: createOpenAiSpeechCfg(model),
        });

        expect(result.success).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, init] = mockCallAt(fetchMock, 0) as [string, RequestInit];
        expect(typeof init.body).toBe("string");
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(body).toMatchObject({
          input: "Hello there, friendly caller.",
          model,
          voice: "alloy",
          response_format: responseFormat,
        });
        expect(body.instructions).toBe(expectedInstructions);
      }, 2);
    },
  );

  it.each(
    [
      {
        name: "ordinary synthesis",
        run: async (cfg: OpenClawConfig, timeoutMs: number) =>
          await ttsRuntime.textToSpeech({
            text: "Hello from the timeout contract.",
            cfg,
            disableFallback: true,
            timeoutMs,
          }),
      },
      {
        name: "telephony synthesis",
        run: async (cfg: OpenClawConfig, timeoutMs: number) =>
          await ttsRuntime.textToSpeechTelephony({
            text: "Hello from the telephony timeout contract.",
            cfg,
            timeoutMs,
          }),
      },
    ].flatMap(({ name, run }) =>
      [false, true].map((partialBody) => ({
        name,
        run,
        partialBody,
        stage: partialBody ? "response body" : "response headers",
      })),
    ),
  )(
    "aborts stalled OpenAI $name waiting for $stage within the caller timeout",
    { timeout: 2_000 },
    async (testCase) => {
      await withHangingSpeechServer(
        testCase.partialBody,
        async (baseUrl, getRequestCount, isConnectionClosed) => {
          const cfg = asLegacyTtsConfig({
            tts: {
              provider: "openai",
              providers: {
                openai: {
                  apiKey: "test-api-key",
                  baseUrl,
                  model: "gpt-4o-mini-tts",
                  voice: "alloy",
                },
              },
            },
          });
          const timeoutMs = 100;
          const startedAt = Date.now();
          let watchdog: ReturnType<typeof setTimeout> | undefined;

          try {
            const result = await Promise.race([
              testCase.run(cfg, timeoutMs),
              new Promise<never>((_, reject) => {
                watchdog = setTimeout(
                  () => reject(new Error(`${testCase.name} did not time out`)),
                  1_000,
                );
              }),
            ]);

            expect(result.success).toBe(false);
            expect(result.error).toMatch(/aborted|timeout|timed out/i);
            expect(Date.now() - startedAt).toBeLessThan(1_000);
            expect(getRequestCount()).toBe(1);
            await vi.waitFor(() => expect(isConnectionClosed()).toBe(true), { timeout: 1_000 });
          } finally {
            if (watchdog) {
              clearTimeout(watchdog);
            }
          }
        },
      );
    },
  );
});
