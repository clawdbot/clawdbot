// Media runner proxy tests cover environment proxy fetch selection for audio
// and video providers.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withAudioFixture, withVideoFixture } from "./runner.test-utils.js";
import type { AudioTranscriptionRequest, VideoDescriptionRequest } from "./types.js";

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const { createEmptyCapabilityProviderMockModule } = await import("./runner.test-mocks.js");
  return createEmptyCapabilityProviderMockModule();
});

const proxyFetchMocks = vi.hoisted(() => {
  const proxyFetch = vi.fn() as unknown as typeof fetch;
  const resolveProxyFetchFromEnv = vi.fn((env: NodeJS.ProcessEnv = process.env) => {
    const hasProxy = Boolean(
      env.https_proxy?.trim() ||
      env.HTTPS_PROXY?.trim() ||
      env.http_proxy?.trim() ||
      env.HTTP_PROXY?.trim(),
    );
    return hasProxy ? proxyFetch : undefined;
  });
  return { proxyFetch, resolveProxyFetchFromEnv };
});

vi.mock("../infra/net/proxy-fetch.js", () => ({
  resolveProxyFetchFromEnv: proxyFetchMocks.resolveProxyFetchFromEnv,
}));

let buildProviderRegistry: typeof import("./runner.js").buildProviderRegistry;
let clearMediaUnderstandingBinaryCacheForTests: typeof import("./runner.test-support.js").clearMediaUnderstandingBinaryCacheForTests;
let runCapability: typeof import("./runner.js").runCapability;

function createOpenAiAudioCfg(providerOverrides: Record<string, unknown> = {}): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          apiKey: "test-key", // pragma: allowlist secret
          ...providerOverrides,
          models: [],
        },
      },
    },
    tools: {
      media: {
        models: [{ provider: "openai", model: "whisper-1", capabilities: ["audio"] }],
        audio: {
          enabled: true,
        },
      },
    },
  } as unknown as OpenClawConfig;
}

function expectSingleOutputText(
  result: Awaited<ReturnType<typeof runCapability>>,
  expectedText: string,
): void {
  expect(result.outputs).toHaveLength(1);
  const [output] = result.outputs;
  if (!output) {
    throw new Error("Expected media understanding output");
  }
  expect(output.text).toBe(expectedText);
}

async function runAudioCapabilityWithFetchCapture(params: {
  fixturePrefix: string;
  outputText: string;
}): Promise<typeof fetch | undefined> {
  let seenFetchFn: typeof fetch | undefined;
  await withAudioFixture(params.fixturePrefix, async ({ ctx, media, cache }) => {
    const providerRegistry = buildProviderRegistry({
      openai: {
        id: "openai",
        capabilities: ["audio"],
        transcribeAudio: async (req: AudioTranscriptionRequest) => {
          seenFetchFn = req.fetchFn;
          return { text: params.outputText, model: req.model };
        },
      },
    });

    const result = await runCapability({
      capability: "audio",
      cfg: createOpenAiAudioCfg(),
      ctx,
      attachments: cache,
      media,
      providerRegistry,
    });

    expectSingleOutputText(result, params.outputText);
  });
  return seenFetchFn;
}

describe("runCapability proxy fetch passthrough", () => {
  beforeAll(async () => {
    ({ buildProviderRegistry, runCapability } = await import("./runner.js"));
    ({ clearMediaUnderstandingBinaryCacheForTests } = await import("./runner.test-support.js"));
  });

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    clearMediaUnderstandingBinaryCacheForTests();
  });

  it("passes fetchFn to audio provider when HTTPS_PROXY is set", async () => {
    await withEnvAsync({ HTTPS_PROXY: "http://proxy.test:8080" }, async () => {
      const seenFetchFn = await runAudioCapabilityWithFetchCapture({
        fixturePrefix: "openclaw-audio-proxy",
        outputText: "transcribed",
      });
      expect(seenFetchFn).toBe(proxyFetchMocks.proxyFetch);
    });
  });

  it("passes fetchFn to video provider when HTTPS_PROXY is set", async () => {
    await withEnvAsync({ HTTPS_PROXY: "http://proxy.test:8080" }, async () => {
      await withVideoFixture("openclaw-video-proxy", async ({ ctx, media, cache }) => {
        let seenFetchFn: typeof fetch | undefined;

        const result = await runCapability({
          capability: "video",
          cfg: {
            models: {
              providers: {
                moonshot: {
                  apiKey: "test-key", // pragma: allowlist secret
                  models: [],
                },
              },
            },
            tools: {
              media: {
                models: [{ provider: "moonshot", model: "kimi-k2.5", capabilities: ["video"] }],
                video: {
                  enabled: true,
                },
              },
            },
          } as unknown as OpenClawConfig,
          ctx,
          attachments: cache,
          media,
          providerRegistry: new Map([
            [
              "moonshot",
              {
                id: "moonshot",
                capabilities: ["video"],
                describeVideo: async (req: VideoDescriptionRequest) => {
                  seenFetchFn = req.fetchFn;
                  return { text: "video ok", model: req.model };
                },
              },
            ],
          ]),
        });

        expectSingleOutputText(result, "video ok");
        expect(seenFetchFn).toBe(proxyFetchMocks.proxyFetch);
      });
    });
  });

  it("does not pass fetchFn when no proxy env vars are set", async () => {
    await withEnvAsync(
      { HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "" },
      async () => {
        const seenFetchFn = await runAudioCapabilityWithFetchCapture({
          fixturePrefix: "openclaw-audio-no-proxy",
          outputText: "ok",
        });
        expect(seenFetchFn).toBeUndefined();
      },
    );
  });

  it("passes allowPrivateNetwork to audio provider when set in providerConfig.request", async () => {
    let seenRequest: AudioTranscriptionRequest["request"];

    await withAudioFixture("openclaw-audio-allowprivatenetwork", async ({ ctx, media, cache }) => {
      const providerRegistry = buildProviderRegistry({
        openai: {
          id: "openai",
          capabilities: ["audio"],
          transcribeAudio: async (req: AudioTranscriptionRequest) => {
            seenRequest = req.request;
            return { text: "ok", model: req.model };
          },
        },
      });

      const result = await runCapability({
        capability: "audio",
        cfg: createOpenAiAudioCfg({
          request: {
            allowPrivateNetwork: true,
          },
        }),
        ctx,
        attachments: cache,
        media,
        providerRegistry,
      });

      expectSingleOutputText(result, "ok");
    });

    if (!seenRequest) {
      throw new Error("Expected audio provider request options");
    }
    expect(seenRequest.allowPrivateNetwork).toBe(true);
  });
});
