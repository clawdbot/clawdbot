import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  capturePluginRegistration,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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

beforeEach(() => {
  readClaudeCliCredentialsForSetupMock.mockReset();
  readClaudeCliCredentialsForRuntimeMock.mockReset();
});

afterAll(() => {
  vi.doUnmock("./cli-auth-seam.js");
  vi.resetModules();
});

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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function expectFields(value: unknown, fields: Record<string, unknown>) {
  const record = requireRecord(value, "record");
  for (const [key, expected] of Object.entries(fields)) {
    expect(record[key]).toEqual(expected);
  }
}

function expectModelParams(models: unknown, modelId: string, params: Record<string, unknown>) {
  const model = requireRecord(requireRecord(models, "models")[modelId], modelId);
  expectFields(model.params, params);
}

function levelIds(profile: unknown): Array<unknown> {
  const levels = requireRecord(profile, "thinking profile").levels;
  expect(Array.isArray(levels), "thinking levels").toBe(true);
  return (levels as Array<{ id?: unknown }>).map((level) => level.id);
}

describe("anthropic provider replay hooks", () => {
  it("registers the claude-cli backend", () => {
    const captured = capturePluginRegistration({ register: anthropicPlugin.register });

    const backend = captured.cliBackends.find((entry) => entry.id === "claude-cli");
    if (!backend) {
      throw new Error("Expected claude-cli backend");
    }
    expect(backend.bundleMcp).toBe(true);
    expectFields(backend.config, {
      command: "claude",
      modelArg: "--model",
      sessionArg: "--session-id",
    });
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
      requireRecord(
        provider.normalizeConfig?.({
          provider: "anthropic",
          providerConfig: {
            models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
          },
        } as never),
        "normalized config",
      ).api,
    ).toBe("anthropic-messages");
  });

  it("defaults Claude CLI provider api through plugin config normalization", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(
      requireRecord(
        provider.normalizeConfig?.({
          provider: "claude-cli",
          providerConfig: {
            models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
          },
        } as never),
        "normalized config",
      ).api,
    ).toBe("anthropic-messages");
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

    expectFields(next?.agents?.defaults?.contextPruning, {
      mode: "cache-ttl",
      ttl: "1h",
    });
    expectFields(next?.agents?.defaults?.heartbeat, {
      every: "30m",
    });
    expect(
      next?.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.params?.cacheRetention,
    ).toBe("short");
  });

  it("backfills Haiku into API-key agent model allowlists", async () => {
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
            model: { primary: "anthropic/claude-sonnet-4-6" },
            models: {
              "anthropic/claude-sonnet-4-6": {},
            },
          },
        },
      },
    } as never);

    const models = next?.agents?.defaults?.models;
    expectModelParams(models, "anthropic/claude-sonnet-4-6", { cacheRetention: "short" });
    expectModelParams(models, "anthropic/claude-haiku-4-5", { cacheRetention: "short" });
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
            agentRuntime: { id: "claude-cli" },
            model: { primary: "anthropic/claude-opus-4-7" },
            models: {
              "anthropic/claude-opus-4-7": {},
            },
          },
        },
      },
    } as never);

    expectFields(next?.agents?.defaults?.heartbeat, {
      every: "1h",
    });
    const models = requireRecord(next?.agents?.defaults?.models, "models");
    for (const modelId of [
      "anthropic/claude-opus-4-7",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-opus-4-5",
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-haiku-4-5",
    ]) {
      expect(models[modelId]).toEqual({});
    }
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

    expectFields(resolved, {
      provider: "anthropic",
      id: "claude-opus-4-7",
      api: "anthropic-messages",
      reasoning: true,
      contextWindow: 1_048_576,
      contextTokens: 1_048_576,
    });
    const opus47Profile = provider.resolveThinkingProfile?.({
      provider: "anthropic",
      modelId: "claude-opus-4-7",
    } as never);
    const opus47LevelIds = levelIds(opus47Profile);
    expect(opus47LevelIds).toContain("xhigh");
    expect(opus47LevelIds).toContain("adaptive");
    expect(opus47LevelIds).toContain("max");
    expect(requireRecord(opus47Profile, "opus 4.7 thinking profile").defaultLevel).toBe("off");
    const opus46Profile = provider.resolveThinkingProfile?.({
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    } as never);
    expect(levelIds(opus46Profile)).toContain("adaptive");
    expect(requireRecord(opus46Profile, "opus 4.6 thinking profile").defaultLevel).toBe("adaptive");
    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "anthropic",
          modelId: "claude-opus-4-6",
        } as never)
        ?.levels.some((level) => level.id === "xhigh" || level.id === "max"),
    ).toBe(false);
  });

  it("does not forward-compat case-mismatched Anthropic model ids", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const resolved = provider.resolveDynamicModel?.({
      provider: "anthropic",
      modelId: "CLAUDE-OPUS-4-7",
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

    expect(resolved).toBeUndefined();
  });

  it("normalizes exact claude opus 4.7 variants to 1M context", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    for (const [runtimeProvider, modelId] of [
      ["anthropic", "claude-opus-4-7"],
      ["claude-cli", "claude-opus-4.7-20260219"],
    ] as const) {
      expectFields(
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
        {
          contextWindow: 1_048_576,
          contextTokens: 1_048_576,
        },
      );
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
      expiresAt: 123,
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
      expiresAt: 123,
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

    if (!cliAuth) {
      throw new Error("expected Anthropic CLI auth method");
    }

    const result = await cliAuth.run({
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
