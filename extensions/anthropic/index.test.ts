import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { capturePluginRegistration } from "openclaw/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";

const { readClaudeCliCredentialsForSetupMock, readClaudeCliCredentialsForRuntimeMock } = vi.hoisted(
  () => ({
    readClaudeCliCredentialsForSetupMock: vi.fn(),
    readClaudeCliCredentialsForRuntimeMock: vi.fn(),
  }),
);

vi.mock("./cli-auth-seam.js", () => {
  return {
    readClaudeCliCredentialsForSetup: readClaudeCliCredentialsForSetupMock,
    readClaudeCliCredentialsForRuntime: readClaudeCliCredentialsForRuntimeMock,
  };
});

import anthropicPlugin from "./index.js";

function createModelRegistry(models: ProviderRuntimeModel[]) {
  return {
    find(providerId: string, modelId: string) {
      return (
        models.find(
          (model) =>
            model.provider === providerId && model.id.toLowerCase() === modelId.toLowerCase(),
        ) ?? null
      );
    },
  };
}

describe("anthropic provider replay hooks", () => {
  it("registers the claude-cli backend", async () => {
    const captured = capturePluginRegistration({ register: anthropicPlugin.register });

    expect(captured.cliBackends).toContainEqual(
      expect.objectContaining({
        id: "claude-cli",
        bundleMcp: true,
        config: expect.objectContaining({
          command: "claude",
          modelArg: "--model",
          sessionArg: "--session-id",
        }),
      }),
    );
  });

  it("owns native reasoning output mode for Claude transports", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "anthropic",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never),
    ).toBe("native");
  });

  it("owns replay policy for Claude transports", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.buildReplayPolicy?.({
        provider: "anthropic",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never),
    ).toEqual({
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      preserveNativeAnthropicToolUseIds: true,
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      validateAnthropicTurns: true,
      allowSyntheticToolResults: true,
    });
  });

  it("defaults provider api through plugin config normalization", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.normalizeConfig?.({
        provider: "anthropic",
        providerConfig: {
          models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
        },
      } as never),
    ).toMatchObject({
      api: "anthropic-messages",
    });
  });

  it("defaults Claude CLI provider api through plugin config normalization", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.normalizeConfig?.({
        provider: "claude-cli",
        providerConfig: {
          models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
        },
      } as never),
    ).toMatchObject({
      api: "anthropic-messages",
    });
  });

  it("does not default non-Anthropic provider api through plugin config normalization", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);
    const providerConfig = {
      baseUrl: "https://chatgpt.com/backend-api/codex",
      models: [{ id: "gpt-5.4", name: "GPT-5.4" }],
    };

    expect(
      provider.normalizeConfig?.({
        provider: "openai-codex",
        providerConfig,
      } as never),
    ).toBe(providerConfig);
  });

  it("applies Anthropic pruning defaults through plugin hooks", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const next = provider.applyConfigDefaults?.({
      provider: "anthropic",
      env: {},
      config: {
        auth: {
          profiles: {
            "anthropic:api": { provider: "anthropic", mode: "api_key" },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-5" },
          },
        },
      },
    } as never);

    expect(next?.agents?.defaults?.contextPruning).toMatchObject({
      mode: "cache-ttl",
      ttl: "1h",
    });
    expect(next?.agents?.defaults?.heartbeat).toMatchObject({
      every: "30m",
    });
    expect(
      next?.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.params?.cacheRetention,
    ).toBe("short");
  });

  it("backfills Claude CLI allowlist defaults through plugin hooks for older configs", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const next = provider.applyConfigDefaults?.({
      provider: "anthropic",
      env: {},
      config: {
        auth: {
          profiles: {
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
        agents: {
          defaults: {
            model: { primary: "claude-cli/claude-opus-4-7" },
            models: {
              "claude-cli/claude-opus-4-7": {},
            },
          },
        },
      },
    } as never);

    expect(next?.agents?.defaults?.heartbeat).toMatchObject({
      every: "1h",
    });
    expect(next?.agents?.defaults?.models).toMatchObject({
      "claude-cli/claude-opus-4-7": {},
      "claude-cli/claude-sonnet-4-6": {},
      "claude-cli/claude-opus-4-6": {},
      "claude-cli/claude-opus-4-5": {},
      "claude-cli/claude-sonnet-4-5": {},
      "claude-cli/claude-haiku-4-5": {},
    });
  });

  it("resolves explicit claude-opus-4-7 refs from the 4.6 template family", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);
    const resolved = provider.resolveDynamicModel?.({
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      modelRegistry: createModelRegistry([
        {
          id: "claude-opus-4-6",
          name: "Claude Opus 4.6",
          provider: "anthropic",
          api: "anthropic-messages",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 32_000,
        } as ProviderRuntimeModel,
      ]),
    } as ProviderResolveDynamicModelContext);

    expect(resolved).toMatchObject({
      provider: "anthropic",
      id: "claude-opus-4-7",
      api: "anthropic-messages",
      reasoning: true,
      contextWindow: 1_048_576,
      contextTokens: 1_048_576,
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "anthropic",
        modelId: "claude-opus-4-7",
      } as never),
    ).toMatchObject({
      levels: expect.arrayContaining([{ id: "xhigh" }, { id: "adaptive" }, { id: "max" }]),
      defaultLevel: "off",
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "anthropic",
        modelId: "claude-opus-4-6",
      } as never),
    ).toMatchObject({
      levels: expect.arrayContaining([{ id: "adaptive" }]),
      defaultLevel: "adaptive",
    });
    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "anthropic",
          modelId: "claude-opus-4-6",
        } as never)
        ?.levels.some((level) => level.id === "xhigh" || level.id === "max"),
    ).toBe(false);
  });

  it("normalizes exact claude opus 4.7 variants to 1M context", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    for (const [runtimeProvider, modelId] of [
      ["anthropic", "claude-opus-4-7"],
      ["claude-cli", "claude-opus-4.7-20260219"],
    ] as const) {
      expect(
        provider.normalizeResolvedModel?.({
          provider: runtimeProvider,
          modelId,
          model: {
            id: modelId,
            name: "Claude Opus 4.7",
            provider: runtimeProvider,
            api: "anthropic-messages",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            contextTokens: 200_000,
            maxTokens: 32_000,
          },
        } as never),
      ).toMatchObject({
        contextWindow: 1_048_576,
        contextTokens: 1_048_576,
      });
    }
  });

  it("resolves claude-cli synthetic oauth auth", async () => {
    readClaudeCliCredentialsForRuntimeMock.mockReset();
    readClaudeCliCredentialsForRuntimeMock.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
    });

    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.resolveSyntheticAuth?.({
        provider: "claude-cli",
      } as never),
    ).toEqual({
      apiKey: "access-token",
      source: "Claude CLI native auth",
      mode: "oauth",
    });
    expect(readClaudeCliCredentialsForRuntimeMock).toHaveBeenCalledTimes(1);
  });

  it("resolves claude-cli synthetic token auth", async () => {
    readClaudeCliCredentialsForRuntimeMock.mockReset();
    readClaudeCliCredentialsForRuntimeMock.mockReturnValue({
      type: "token",
      provider: "anthropic",
      token: "bearer-token",
      expires: 123,
    });

    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      provider.resolveSyntheticAuth?.({
        provider: "claude-cli",
      } as never),
    ).toEqual({
      apiKey: "bearer-token",
      source: "Claude CLI native auth",
      mode: "token",
    });
  });

  it("stores a claude-cli auth profile during anthropic cli migration", async () => {
    readClaudeCliCredentialsForSetupMock.mockReset();
    readClaudeCliCredentialsForSetupMock.mockReturnValue({
      type: "oauth",
      provider: "anthropic",
      access: "setup-access-token",
      refresh: "refresh-token",
      expires: 123,
    });

    const provider = await registerSingleProviderPlugin(anthropicPlugin);
    const cliAuth = provider.auth.find((entry) => entry.id === "cli");

    expect(cliAuth).toBeDefined();

    const result = await cliAuth?.run({
      config: {},
    } as never);

    expect(result?.profiles).toEqual([
      {
        profileId: "anthropic:claude-cli",
        credential: {
          type: "oauth",
          provider: "claude-cli",
          access: "setup-access-token",
          refresh: "refresh-token",
          expires: 123,
        },
      },
    ]);
  });
});
