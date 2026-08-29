import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedBuildEmbeddedRunPayloads,
  mockedGetApiKeyForModel,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
} from "./run.overflow-compaction.harness.js";

describe("prepared plugin harness credentials", () => {
  let runEmbeddedAgent: Awaited<
    ReturnType<typeof loadRunOverflowCompactionHarness>
  >["runEmbeddedAgent"];
  let registerPreparedAgentHarness: Awaited<
    ReturnType<typeof loadRunOverflowCompactionHarness>
  >["registerPreparedAgentHarness"];
  beforeAll(async () => {
    const loaded = await loadRunOverflowCompactionHarness();
    runEmbeddedAgent = loaded.runEmbeddedAgent;
    registerPreparedAgentHarness = loaded.registerPreparedAgentHarness;
    const modelAuth = await import("../model-auth.js");
    const actual = await vi.importActual<typeof modelAuth>("../model-auth.js");
    vi.mocked(modelAuth.applyAuthHeaderOverride).mockImplementation(actual.applyAuthHeaderOverride);
    vi.mocked(modelAuth.resolveProviderEntryApiKeyProfileReference).mockImplementation(
      actual.resolveProviderEntryApiKeyProfileReference,
    );
    vi.mocked(modelAuth.shouldPreferExplicitConfigApiKeyAuth).mockImplementation(
      actual.shouldPreferExplicitConfigApiKeyAuth,
    );
  });
  beforeEach(() => {
    registerPreparedAgentHarness({
      id: "test-byok",
      label: "Test BYOK",
      supports: ({ provider }) =>
        provider === "custom-proof" ? { supported: true, priority: 100 } : { supported: false },
      runAttempt: (params) => mockedRunEmbeddedAttempt(params),
    });
    mockedRunEmbeddedAttempt.mockClear();
    mockedGetApiKeyForModel.mockClear();
    mockedGetApiKeyForModel.mockResolvedValue({
      apiKey: "synthetic-configured-key",
      mode: "api-key",
      source: "models.providers.custom-proof",
    });
    mockedRunEmbeddedAttempt.mockResolvedValue(makeAttemptResult({ assistantTexts: ["OK"] }));
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "OK" }]);
  });

  it.each([true, false])(
    "forwards a configured direct key with authHeader=%s",
    async (authHeader) => {
      await runEmbeddedAgent({
        ...overflowBaseRunParams,
        provider: "custom-proof",
        model: "gpt-5.6-luna",
        config: {
          models: {
            providers: {
              "custom-proof": {
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                apiKey: "synthetic-configured-key",
                authHeader,
                models: [
                  {
                    id: "gpt-5.6-luna",
                    name: "Luna",
                    reasoning: true,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128_000,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
        },
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
      expect(mockedRunEmbeddedAttempt.mock.calls[0]?.[0].agentHarnessId).toBe("test-byok");
      expect(mockedRunEmbeddedAttempt.mock.calls[0]?.[0].resolvedApiKey).toBe(
        "synthetic-configured-key",
      );
      expect(mockedGetApiKeyForModel).toHaveBeenCalledWith(
        expect.objectContaining({ allowAuthProfileFallback: false }),
      );
      expect(mockedRunEmbeddedAttempt.mock.calls[0]?.[0].model.headers).toEqual(
        authHeader ? { Authorization: "Bearer synthetic-configured-key" } : undefined,
      );
    },
  );

  it("does not discover a credential for an implicit harness auth attempt", async () => {
    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "custom-proof",
      model: "gpt-5.6-luna",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(mockedRunEmbeddedAttempt.mock.calls[0]?.[0].agentHarnessId).toBe("test-byok");
    expect(mockedRunEmbeddedAttempt.mock.calls[0]?.[0].resolvedApiKey).toBeUndefined();
    expect(mockedGetApiKeyForModel).not.toHaveBeenCalled();
  });
});
