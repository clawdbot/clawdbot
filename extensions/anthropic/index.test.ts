import { calculateCost, type Usage } from "openclaw/plugin-sdk/llm";
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  capturePluginRegistration,
  createRuntimeEnv,
  createTestWizardPrompter,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
// Anthropic tests cover index plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const { probeClaudeCliAuthStatusMock } = vi.hoisted(() => ({
  probeClaudeCliAuthStatusMock: vi.fn(),
}));

vi.mock("./cli-auth-seam.js", () => {
  return {
    probeClaudeCliAuthStatus: probeClaudeCliAuthStatusMock,
  };
});

import { buildClaudeCliCatalogEntries } from "./cli-catalog.js";
import { CLAUDE_CLI_NATIVE_AUTH_MARKER } from "./cli-constants.js";
import anthropicPlugin from "./index.js";
import anthropicProviderDiscovery from "./provider-discovery.js";

beforeEach(() => {
  probeClaudeCliAuthStatusMock.mockReset();
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

const requireRecord = createRequireRecord("object", "expected-label");

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

type Claude5ContractCase = {
  name: string;
  modelId: string;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  thinkingLevelMap: Record<string, string>;
  checksMedia?: boolean;
  restoresMissingCost?: boolean;
  checksCliPolicy?: boolean;
};

const ANTHROPIC_SETUP_TOKEN = `sk-ant-oat01-${"a".repeat(80)}`;

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
      freshSessionRecovery: "invalidated-only",
      modelArg: "--model",
      sessionArgs: ["--session-id", "{sessionId}"],
    });
    expect(backend.config.reliability?.watchdog?.resume).toBeUndefined();
  });

  it("declares the copied Claude CLI profile as retired", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    expect(provider.deprecatedProfileIds).toEqual(["anthropic:claude-cli"]);
  });

  it("lets native session discovery be disabled without disabling Anthropic", () => {
    const registerCliBackend = vi.fn();
    const registerNodeHostCommand = vi.fn();
    const registerNodeInvokePolicy = vi.fn();
    const registerProvider = vi.fn();
    const registerSessionCatalog = vi.fn();
    anthropicPlugin.register(
      createTestPluginApi({
        id: "anthropic",
        name: "Anthropic",
        source: "test",
        config: {},
        pluginConfig: { sessionCatalog: { enabled: false } },
        registerCliBackend,
        registerNodeHostCommand,
        registerNodeInvokePolicy,
        registerProvider,
        registerSessionCatalog,
      }),
    );

    expect(registerCliBackend).toHaveBeenCalledOnce();
    expect(registerNodeInvokePolicy).toHaveBeenCalledOnce();
    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerNodeHostCommand).not.toHaveBeenCalled();
    expect(registerSessionCatalog).not.toHaveBeenCalled();
  });

  it.each([
    ["Opus", "claude-opus-5"],
    ["Sonnet", "claude-sonnet-5"],
    ["Fable", "claude-fable-5"],
  ])("publishes Claude %s 5 CLI metadata without downgrading its API contract", (family, id) => {
    expect(buildClaudeCliCatalogEntries().find((model) => model.id === id)).toMatchObject({
      id,
      name: `Claude ${family} 5 (Claude CLI)`,
      contextWindow: 1_000_000,
      contextWindows: [
        { id: "200k", label: "200K", contextWindow: 200_000 },
        { id: "1m", label: "1M", contextWindow: 1_000_000 },
      ],
      contextWindowDefault: "1m",
      maxTokens: 128_000,
      mediaInput: {
        image: { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
      },
    });
  });

  it("keeps bare Claude CLI context plan-safe while publishing output limits", () => {
    const models = buildClaudeCliCatalogEntries();
    for (const id of [
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]) {
      expect(models.find((model) => model.id === id)).toMatchObject({
        contextWindow: 200_000,
        maxTokens: 128_000,
      });
    }
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

  it("classifies Anthropic-native structured failover errors", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    for (const providerId of ["anthropic", "claude-cli"]) {
      expect(
        provider.classifyFailoverReason?.({
          provider: providerId,
          errorMessage: "",
          errorType: "rate_limit_error",
        }),
      ).toBe("rate_limit");
      expect(
        provider.classifyFailoverReason?.({
          provider: providerId,
          errorMessage: "",
          errorType: "api_error",
        }),
      ).toBe("server_error");
    }
    expect(
      provider.classifyFailoverReason?.({
        provider: "anthropic",
        errorMessage: "",
        errorType: "rate_limit_error",
        code: "API_ERROR",
      }),
    ).toBe("rate_limit");
    expect(
      provider.classifyFailoverReason?.({
        provider: "anthropic",
        errorMessage: "",
        code: "RATE_LIMIT_ERROR",
      }),
    ).toBe("rate_limit");
    expect(
      provider.classifyFailoverReason?.({
        provider: "anthropic",
        errorMessage: "",
        code: "API_ERROR",
      }),
    ).toBe("server_error");
    expect(
      provider.classifyFailoverReason?.({
        provider: "anthropic",
        errorMessage: "",
        errorType: "UNKNOWN_ERROR",
        code: "INSUFFICIENT_QUOTA",
      }),
    ).toBeUndefined();
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

  it("preserves Fable thinking in its same-model replay policy", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);
    const fableContext = {
      provider: "anthropic",
      modelApi: "anthropic-messages",
      modelId: "claude-fable-5",
    };

    expect(provider.buildReplayPolicy?.(fableContext)).toEqual({
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

  it.each([
    ["provider", "anthropic"],
    ["Claude CLI provider", "claude-cli"],
  ])("defaults %s api through plugin config normalization", async (_label, providerId) => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);
    expect(
      requireRecord(
        provider.normalizeConfig?.({
          provider: providerId,
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
        provider: "openai",
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
            model: { primary: "anthropic/claude-opus-4-6" },
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
      next?.agents?.defaults?.models?.["anthropic/claude-opus-4-6"]?.params?.cacheRetention,
    ).toBe("short");
  });

  it("backfills current Sonnet models into API-key agent model allowlists", async () => {
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
            model: { primary: "anthropic/claude-opus-4-6" },
            models: {
              "anthropic/claude-opus-4-6": {},
            },
          },
        },
      },
    } as never);

    const models = next?.agents?.defaults?.models;
    expectModelParams(models, "anthropic/claude-opus-4-6", { cacheRetention: "short" });
    expectModelParams(models, "anthropic/claude-sonnet-5", { cacheRetention: "short" });
    expectModelParams(models, "anthropic/claude-sonnet-4-6", { cacheRetention: "short" });
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
      "anthropic/claude-opus-4-8",
      "anthropic/claude-opus-4-7",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-4-6",
    ]) {
      expect(models[modelId]).toEqual({ agentRuntime: { id: "claude-cli" } });
    }
  });

  it("backfills Claude CLI routing from a retired provider-entry profile reference", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const next = provider.applyConfigDefaults?.({
      provider: "anthropic",
      env: {},
      config: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              apiKey: "anthropic:claude-cli",
              models: [],
            },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
          },
        },
      },
    } as never);

    expect(next?.agents?.defaults?.models?.["anthropic/claude-sonnet-4-6"]?.agentRuntime).toEqual({
      id: "claude-cli",
    });
  });

  it("backfills raw and canonical Claude CLI policies for provider-qualified shorthand refs", async () => {
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
            model: { primary: "anthropic/opus-4.7" },
            models: {
              "anthropic/opus-4.7": { params: { maxTokens: 1200 } },
            },
          },
        },
      },
    } as never);

    const models = requireRecord(next?.agents?.defaults?.models, "models");
    expect(models["anthropic/opus-4.7"]).toEqual({
      params: { maxTokens: 1200 },
      agentRuntime: { id: "claude-cli" },
    });
    expect(models["anthropic/claude-opus-4-7"]).toEqual({
      agentRuntime: { id: "claude-cli" },
    });
  });

  it("backfills Claude CLI policy from per-agent shorthand refs selected under Claude CLI auth", async () => {
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
            models: {},
          },
          entries: {
            main: {
              default: true,
              model: { primary: "anthropic/opus-4.7" },
              name: "Main",
              workspace: "/tmp/openclaw-agent",
            },
          },
        },
      },
    } as never);

    const models = requireRecord(next?.agents?.defaults?.models, "models");
    expect(models["anthropic/opus-4.7"]).toEqual({ agentRuntime: { id: "claude-cli" } });
    expect(models["anthropic/claude-opus-4-7"]).toEqual({
      agentRuntime: { id: "claude-cli" },
    });
  });

  it("backfills Claude CLI policy from shorthand model-map keys under Claude CLI auth", async () => {
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
            models: {
              "anthropic/opus-4.7": { params: { maxTokens: 1200 } },
            },
          },
          entries: {
            main: {
              models: {
                "anthropic/sonnet-4.6": { alias: "Sonnet shorthand" },
              },
              name: "Main",
              workspace: "/tmp/openclaw-agent",
            },
          },
        },
      },
    } as never);

    const models = requireRecord(next?.agents?.defaults?.models, "models");
    expect(models["anthropic/opus-4.7"]).toEqual({
      params: { maxTokens: 1200 },
      agentRuntime: { id: "claude-cli" },
    });
    expect(models["anthropic/claude-opus-4-7"]).toEqual({
      agentRuntime: { id: "claude-cli" },
    });
    expect(models["anthropic/sonnet-4.6"]).toEqual({ agentRuntime: { id: "claude-cli" } });
    expect(models["anthropic/claude-sonnet-4-6"]).toEqual({
      agentRuntime: { id: "claude-cli" },
    });
  });

  it("does not backfill Claude CLI policy from an unselected rollback profile", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const next = provider.applyConfigDefaults?.({
      provider: "anthropic",
      env: {},
      config: {
        auth: {
          order: {
            anthropic: ["anthropic:oauth", "anthropic:claude-cli"],
          },
          profiles: {
            "anthropic:oauth": { provider: "anthropic", mode: "oauth" },
            "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
          },
        },
        agents: {
          defaults: {
            model: { primary: "anthropic/opus-4.7" },
            models: {
              "anthropic/opus-4.7": { params: { maxTokens: 1200 } },
            },
          },
        },
      },
    } as never);

    const models = requireRecord(next?.agents?.defaults?.models, "models");
    expect(models["anthropic/opus-4.7"]).toEqual({ params: { maxTokens: 1200 } });
    expect(models["anthropic/claude-opus-4-7"]).toBeUndefined();
  });

  it("backfills Claude CLI policy for unknown future Anthropic refs without guessing aliases", async () => {
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
            model: { primary: "anthropic/opus-5.0" },
            models: {
              "anthropic/opus-5.0": { alias: "Future Opus" },
            },
          },
        },
      },
    } as never);

    const models = requireRecord(next?.agents?.defaults?.models, "models");
    expect(models["anthropic/opus-5.0"]).toEqual({
      alias: "Future Opus",
      agentRuntime: { id: "claude-cli" },
    });
    expect(models["anthropic/claude-opus-5-0"]).toBeUndefined();
  });

  it("resolves explicit claude-opus-4-8 refs from the 4.7 template family", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);
    const resolved = provider.resolveDynamicModel?.({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      modelRegistry: createModelRegistry([
        {
          id: "claude-opus-4-7",
          name: "Claude Opus 4.7",
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
      id: "claude-opus-4-8",
      api: "anthropic-messages",
      reasoning: true,
      contextWindow: 1_000_000,
      contextTokens: 1_000_000,
      maxTokens: 128_000,
    });
    const opus48Profile = provider.resolveThinkingProfile?.({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
    } as never);
    const opus48LevelIds = levelIds(opus48Profile);
    expect(opus48LevelIds).toContain("xhigh");
    expect(opus48LevelIds).toContain("adaptive");
    expect(opus48LevelIds).toContain("max");
    expect(requireRecord(opus48Profile, "opus 4.8 thinking profile").defaultLevel).toBe("off");
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
        ?.levels.some((level) => level.id === "max"),
    ).toBe(true);
    expect(
      provider
        .resolveThinkingProfile?.({
          provider: "anthropic",
          modelId: "claude-opus-4-6",
        } as never)
        ?.levels.some((level) => level.id === "xhigh"),
    ).toBe(false);
  });

  const claude5ContractCases: Claude5ContractCase[] = [
    {
      name: "resolves Claude Opus 5 with its exact API contract",
      modelId: "claude-opus-5",
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      checksMedia: true,
      restoresMissingCost: true,
    },
    {
      name: "resolves Claude Fable 5 with its always-adaptive model contract",
      modelId: "claude-fable-5",
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
      checksMedia: true,
      checksCliPolicy: true,
    },
    {
      name: "resolves Claude Sonnet 5 with its exact API contract",
      modelId: "claude-sonnet-5",
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    },
  ];

  it.each(claude5ContractCases)(
    "$name",
    async ({
      modelId,
      cost,
      thinkingLevelMap,
      checksMedia,
      restoresMissingCost,
      checksCliPolicy,
    }) => {
      // This table describes the promotional contract before the September pricing cutover.
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 7, 31));
      onTestFinished(() => clock.mockRestore());
      const provider = await registerSingleProviderPlugin(anthropicPlugin);
      const resolved = provider.resolveDynamicModel?.({
        provider: "anthropic",
        modelId,
        modelRegistry: createModelRegistry([]),
      } as ProviderResolveDynamicModelContext);
      expectFields(resolved, {
        provider: "anthropic",
        id: modelId,
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image"],
        cost,
        contextWindow: 1_000_000,
        contextTokens: 1_000_000,
        maxTokens: 128_000,
        thinkingLevelMap,
      });
      if (checksMedia) {
        expect(requireRecord(resolved, `${modelId} model`).mediaInput).toEqual({
          image: { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
        });
      }
      const profile = provider.resolveThinkingProfile?.({
        provider: "anthropic",
        modelId,
      } as never);
      expect(levelIds(profile)).toStrictEqual(
        modelId === "claude-fable-5"
          ? ["minimal", "low", "medium", "high", "xhigh", "adaptive", "max"]
          : ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"],
      );
      expect(requireRecord(profile, `${modelId} thinking profile`).defaultLevel).toBe("high");
      const normalized = provider.normalizeResolvedModel?.({
        provider: "anthropic",
        modelId,
        model: {
          ...(resolved as ProviderRuntimeModel),
          reasoning: false,
          ...(checksCliPolicy
            ? {}
            : { contextWindow: 200_000, contextTokens: 200_000, maxTokens: 64_000 }),
          ...(restoresMissingCost ? { cost: undefined } : {}),
        } as ProviderRuntimeModel,
      } as never);
      expectFields(normalized, {
        reasoning: true,
        ...(checksCliPolicy
          ? {}
          : { contextWindow: 1_000_000, contextTokens: 1_000_000, maxTokens: 128_000 }),
        ...(restoresMissingCost ? { cost } : {}),
      });
      if (checksCliPolicy) {
        expect(
          provider.resolveDynamicModel?.({
            provider: "claude-cli",
            modelId,
            modelRegistry: createModelRegistry([]),
          } as ProviderResolveDynamicModelContext),
        ).toBeUndefined();
        expect(
          provider.resolveThinkingProfile?.({ provider: "claude-cli", modelId } as never),
        ).toEqual(profile);
        expect(
          provider
            .resolveThinkingProfile?.({
              provider: "claude-cli",
              modelId: "claude-opus-4-6",
            } as never)
            ?.levels.map((level) => level.id),
        ).toContain("max");
        expect(provider.isModernModelRef?.({ provider: "claude-cli", modelId })).toBe(false);
      }
    },
  );

  it("normalizes a Sonnet 5 model without cost metadata instead of crashing", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);
    const resolved = provider.resolveDynamicModel?.({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      modelRegistry: createModelRegistry([]),
    } as ProviderResolveDynamicModelContext);

    const costlessModel = {
      ...(resolved as ProviderRuntimeModel),
      cost: undefined,
    } as unknown as ProviderRuntimeModel;
    const normalized = provider.normalizeResolvedModel?.({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      model: costlessModel,
    } as never);
    // Compare against the resolver's own cost so the assertion survives the
    // promotional -> standard pricing cutover.
    expect(normalized?.cost).toEqual((resolved as ProviderRuntimeModel).cost);
  });

  it.each(["claude-sonnet-5", "claude-opus-5"])(
    "uses operator-configured %s pricing for assistant usage",
    async (modelId) => {
      const provider = await registerSingleProviderPlugin(anthropicPlugin);
      const configuredCost = { input: 777, output: 888, cacheRead: 999, cacheWrite: 666 };
      const config: NonNullable<ProviderResolveDynamicModelContext["config"]> = {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              models: [
                {
                  id: modelId,
                  name: modelId,
                  reasoning: true,
                  input: ["text", "image"],
                  cost: configuredCost,
                  contextWindow: 1_000_000,
                  maxTokens: 128_000,
                },
              ],
            },
          },
        },
      };
      const discoveredModel = provider.resolveDynamicModel?.({
        config,
        provider: "anthropic",
        modelId,
        modelRegistry: createModelRegistry([]),
      } as ProviderResolveDynamicModelContext);
      expect(discoveredModel).toBeDefined();

      const configuredModel = {
        ...(discoveredModel as ProviderRuntimeModel),
        cost: configuredCost,
      };
      const resolvedModel =
        provider.normalizeResolvedModel?.({
          config,
          provider: "anthropic",
          modelId,
          model: configuredModel,
        } as never) ?? configuredModel;
      const usage: Usage = {
        input: 1_000,
        output: 1_000,
        cacheRead: 1_000,
        cacheWrite: 1_000,
        totalTokens: 4_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };

      calculateCost(resolvedModel as Parameters<typeof calculateCost>[0], usage);

      expect(resolvedModel.cost).toEqual(configuredCost);
      expect(usage.cost.input).toBeCloseTo(0.777);
      expect(usage.cost.output).toBeCloseTo(0.888);
      expect(usage.cost.cacheRead).toBeCloseTo(0.999);
      expect(usage.cost.cacheWrite).toBeCloseTo(0.666);
      expect(usage.cost.total).toBeCloseTo(3.33);
    },
  );

  it("resolves Claude Mythos 5 with its direct-only mandatory-adaptive contract", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);
    const resolved = provider.resolveDynamicModel?.({
      provider: "anthropic",
      modelId: "claude-mythos-5",
      modelRegistry: createModelRegistry([]),
    } as ProviderResolveDynamicModelContext);

    expectFields(resolved, {
      provider: "anthropic",
      id: "claude-mythos-5",
      api: "anthropic-messages",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      contextWindow: 1_000_000,
      contextTokens: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: {
        minimal: "low",
        xhigh: "xhigh",
        max: "max",
      },
    });
    expect(requireRecord(resolved, "Mythos model").mediaInput).toEqual({
      image: { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
    });
    const thinkingProfile = provider.resolveThinkingProfile?.({
      provider: "anthropic",
      modelId: "claude-mythos-5",
    } as never);
    expect(thinkingProfile?.defaultLevel).toBe("high");
    expect(levelIds(thinkingProfile)).not.toContain("off");
    expect(
      provider.resolveDynamicModel?.({
        provider: "claude-cli",
        modelId: "claude-mythos-5",
        modelRegistry: createModelRegistry([]),
      } as ProviderResolveDynamicModelContext),
    ).toBeUndefined();
    expect(
      provider.resolveThinkingProfile?.({
        provider: "claude-cli",
        modelId: "claude-mythos-5",
      } as never),
    ).toEqual({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });
  });

  it("rolls Claude Sonnet 5 to standard pricing on September 1, 2026", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 1));
    try {
      const provider = await registerSingleProviderPlugin(anthropicPlugin);
      const model = {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        provider: "anthropic",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        contextWindow: 1_000_000,
        contextTokens: 1_000_000,
        maxTokens: 128_000,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      } as ProviderRuntimeModel;

      expect(
        provider.normalizeResolvedModel?.({
          provider: "anthropic",
          modelId: model.id,
          model,
        } as never)?.cost,
      ).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
      expect(
        provider.resolveDynamicModel?.({
          provider: "anthropic",
          modelId: "claude-sonnet-5-20260901",
          modelRegistry: createModelRegistry([]),
        } as ProviderResolveDynamicModelContext)?.cost,
      ).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not apply direct API pricing to Claude CLI Sonnet 5", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);
    const model = {
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5 (Claude CLI)",
      provider: "claude-cli",
      api: "anthropic-messages",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      contextTokens: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    } as ProviderRuntimeModel;

    expect(
      provider.normalizeResolvedModel?.({
        provider: "claude-cli",
        modelId: model.id,
        model,
      } as never)?.cost,
    ).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("resolves dated modern Claude refs without discovery templates", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const resolved = provider.resolveDynamicModel?.({
      provider: "anthropic",
      modelId: "claude-opus-4.7-20260219",
      modelRegistry: createModelRegistry([]),
    } as ProviderResolveDynamicModelContext);

    expectFields(resolved, {
      provider: "anthropic",
      id: "claude-opus-4.7-20260219",
      api: "anthropic-messages",
      input: ["text", "image"],
      reasoning: true,
    });
  });

  it("uses canonical model identity instead of a Fable-looking deployment alias", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);
    const model = {
      id: "claude-fable-5-prod",
      name: "Production Claude",
      provider: "anthropic",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
      params: { canonicalModelId: "claude-opus-4-8" },
    } as ProviderRuntimeModel;

    expectFields(
      provider.normalizeResolvedModel?.({
        provider: "anthropic",
        modelId: model.id,
        model,
      } as never),
      {
        reasoning: false,
        contextWindow: 1_000_000,
        contextTokens: 1_000_000,
        maxTokens: 128_000,
        thinkingLevelMap: {
          xhigh: "xhigh",
          max: "max",
        },
      },
    );
    expect(
      provider.resolveThinkingProfile?.({
        provider: "anthropic",
        modelId: model.id,
        params: model.params,
      } as never)?.defaultLevel,
    ).toBe("off");
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

  it("normalizes Claude Mythos Preview with native max but no xhigh thinking map", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const normalized = provider.normalizeResolvedModel?.({
      provider: "anthropic",
      modelId: "claude-mythos-preview",
      model: {
        id: "claude-mythos-preview",
        name: "Claude Mythos Preview",
        provider: "anthropic",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
    } as never);

    expect(normalized?.thinkingLevelMap).toEqual({ max: "max" });
  });

  it("normalizes stale text-only modern Claude vision rows to image-capable", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const normalized = provider.normalizeResolvedModel?.({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      model: {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        provider: "anthropic",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 64_000,
        thinkingLevelMap: { max: null },
      },
    } as never);

    expect(normalized?.input).toEqual(["text", "image"]);
    expect(normalized?.mediaInput).toEqual({
      image: { maxSidePx: 1568, preferredSidePx: 1568, tokenMode: "provider" },
    });
    expect(normalized?.thinkingLevelMap).toEqual({ xhigh: null, max: null });
  });

  it("does not normalize numeric successors as known Claude contracts", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const normalized = provider.normalizeResolvedModel?.({
      provider: "anthropic",
      modelId: "claude-opus-4-60",
      model: {
        id: "claude-opus-4-60",
        name: "Claude Opus 4.60",
        provider: "anthropic",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
    } as never);

    expect(normalized).toBeUndefined();
  });

  it("merges partial Claude image media metadata with provider limits", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const normalized = provider.normalizeResolvedModel?.({
      provider: "anthropic",
      modelId: "claude-opus-4-7",
      model: {
        id: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        provider: "anthropic",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 64_000,
        mediaInput: { image: { maxBytes: 1 } },
      },
    } as never);

    expect(normalized?.mediaInput).toEqual({
      image: { maxBytes: 1, maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
    });
  });

  it("normalizes direct Anthropic GA models to exact context and output limits", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    for (const modelId of [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]) {
      expectFields(
        provider.normalizeResolvedModel?.({
          provider: "anthropic",
          modelId,
          model: {
            id: modelId,
            name: "Claude Opus 4.7",
            provider: "anthropic",
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
          contextWindow: 1_000_000,
          contextTokens: 1_000_000,
          maxTokens: 128_000,
        },
      );
    }
  });

  it("keeps bare Claude CLI context plan-safe and honors explicit 1M variants", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);
    const baseModel = {
      id: "claude-opus-4-7",
      name: "Claude Opus 4.7",
      provider: "claude-cli",
      api: "anthropic-messages",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      contextTokens: 200_000,
      maxTokens: 64_000,
    } as ProviderRuntimeModel;

    expectFields(
      provider.normalizeResolvedModel?.({
        provider: "claude-cli",
        modelId: baseModel.id,
        model: baseModel,
      } as never),
      {
        contextWindow: 200_000,
        contextTokens: 200_000,
        maxTokens: 128_000,
      },
    );
    expectFields(
      provider.normalizeResolvedModel?.({
        provider: "claude-cli",
        modelId: `${baseModel.id}[1m]`,
        model: { ...baseModel, id: `${baseModel.id}[1m]` },
      } as never),
      {
        contextWindow: 1_000_000,
        contextTokens: 1_000_000,
        maxTokens: 128_000,
      },
    );
  });

  it("normalizes Claude Opus 4.8 to 128k max output tokens", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const normalized = provider.normalizeResolvedModel?.({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      model: {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        provider: "anthropic",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
    } as never);

    expectFields(normalized, {
      contextWindow: 1_000_000,
      contextTokens: 1_000_000,
      maxTokens: 128_000,
    });
  });

  it("does not normalize legacy Claude 4.5 models to 1M context", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);

    const normalized = provider.normalizeResolvedModel?.({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      model: {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        contextTokens: 200_000,
        maxTokens: 32_000,
      },
    } as never);

    expect(normalized).toBeUndefined();
  });

  it("preserves API-key validation and interactive and non-interactive auth", async () => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);
    const method = provider.auth.find(({ id }) => id === "api-key");
    if (!method?.validateNonInteractive || !method.runNonInteractive) {
      throw new Error("expected complete Anthropic API-key auth");
    }
    const runtime = createRuntimeEnv();
    const resolveApiKey = vi.fn(async () => ({ key: "test-token", source: "profile" as const }));
    const context = {
      authChoice: "apiKey",
      config: {},
      baseConfig: {},
      opts: { anthropicApiKey: "test-token" },
      runtime,
      resolveApiKey,
      toApiKeyCredential: vi.fn(() => null),
    };
    expect(await method.validateNonInteractive(context)).toBe(true);
    expect(resolveApiKey).toHaveBeenCalledWith({
      provider: "anthropic",
      flagValue: "test-token",
      flagName: "--anthropic-api-key",
      envVar: "ANTHROPIC_API_KEY",
    });
    expect(await method.runNonInteractive(context)).toMatchObject({
      auth: { profiles: { "anthropic:default": { provider: "anthropic", mode: "api_key" } } },
      agents: { defaults: { model: { primary: "anthropic/claude-opus-5" } } },
    });
    const result = await method.run({
      config: {},
      env: {},
      opts: context.opts,
      runtime,
      prompter: createTestWizardPrompter(),
      secretInputMode: "plaintext",
      isRemote: false,
      openUrl: vi.fn(),
      oauth: { createVpsAwareHandlers: vi.fn() },
    });
    expect(result).toMatchObject({
      defaultModel: "anthropic/claude-opus-5",
      profiles: [
        {
          profileId: "anthropic:default",
          credential: { type: "api_key", provider: "anthropic", key: "test-token" },
        },
      ],
    });
  });

  it("stores setup-token expiry from a bounded duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const provider = await registerSingleProviderPlugin(anthropicPlugin);
      const setupTokenAuth = provider.auth.find((entry) => entry.id === "setup-token");
      if (!setupTokenAuth) {
        throw new Error("expected Anthropic setup-token auth method");
      }

      const result = await setupTokenAuth.run({
        opts: {
          token: ANTHROPIC_SETUP_TOKEN,
          tokenExpiresIn: "1h",
        },
      } as never);

      expect(result?.profiles[0]?.credential).toMatchObject({
        type: "token",
        provider: "anthropic",
        token: ANTHROPIC_SETUP_TOKEN,
        expires: 3_601_000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: "preflights non-interactive setup-token input without writing credentials",
      opts: {},
    },
    {
      name: "rejects setup-token ref storage during non-interactive preflight",
      opts: { secretInputMode: "ref" }, // pragma: allowlist secret
      error:
        "Anthropic setup-token input cannot be stored with --secret-input-mode ref. Use --secret-input-mode plaintext.",
    },
    {
      name: "rejects invalid setup-token expiry during non-interactive preflight",
      opts: { tokenExpiresIn: "nope" },
      error: "Invalid --token-expires-in",
      partialError: true,
    },
  ] as Array<{
    name: string;
    opts: Record<string, string>;
    error?: string;
    partialError?: boolean;
  }>)("$name", async ({ opts, error, partialError }) => {
    const provider = await registerSingleProviderPlugin(anthropicPlugin);
    const setupTokenAuth = provider.auth.find((entry) => entry.id === "setup-token");
    if (!setupTokenAuth?.validateNonInteractive) {
      throw new Error("expected setup-token reset preflight");
    }
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    const valid = await setupTokenAuth.validateNonInteractive({
      authChoice: "setup-token",
      config: {},
      baseConfig: {},
      opts: { token: ANTHROPIC_SETUP_TOKEN, ...opts },
      runtime,
      resolveApiKey: vi.fn(async () => null),
    });

    expect(valid).toBe(!error);
    if (error) {
      expect(runtime.error).toHaveBeenCalledWith(
        partialError ? expect.stringContaining(error) : error,
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
    } else {
      expect(runtime.error).not.toHaveBeenCalled();
    }
  });

  it("omits setup-token expiry when duration overflows the Date range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(8_640_000_000_000_000);
    try {
      const provider = await registerSingleProviderPlugin(anthropicPlugin);
      const setupTokenAuth = provider.auth.find((entry) => entry.id === "setup-token");
      if (!setupTokenAuth) {
        throw new Error("expected Anthropic setup-token auth method");
      }

      const result = await setupTokenAuth.run({
        opts: {
          token: ANTHROPIC_SETUP_TOKEN,
          tokenExpiresIn: "1h",
        },
      } as never);

      expect(result?.profiles[0]?.credential).toEqual({
        type: "token",
        provider: "anthropic",
        token: ANTHROPIC_SETUP_TOKEN,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { status: "available", authenticated: true },
    { status: "missing", authenticated: false },
    { status: "unreadable", authenticated: false },
  ] as const)(
    "publishes native Claude auth only when its CLI reports $status",
    async ({ status, authenticated }) => {
      probeClaudeCliAuthStatusMock.mockReturnValue({ status });
      const provider = await registerSingleProviderPlugin(anthropicPlugin);
      const config = {};

      const runtimeAuth = provider.resolveSyntheticAuth?.({
        config,
        provider: "claude-cli",
      } as never);
      const discoveryAuth = anthropicProviderDiscovery.resolveSyntheticAuth?.({
        config,
        provider: "claude-cli",
      } as never);
      for (const auth of [runtimeAuth, discoveryAuth]) {
        expect(auth).toEqual(
          authenticated
            ? {
                apiKey: CLAUDE_CLI_NATIVE_AUTH_MARKER,
                source: "Claude CLI native auth",
                mode: "oauth",
              }
            : undefined,
        );
      }
      expect(probeClaudeCliAuthStatusMock).toHaveBeenCalledOnce();
    },
  );

  it("reuses native login facts within one config generation and reprobes its replacement", async () => {
    probeClaudeCliAuthStatusMock.mockReturnValue({ status: "available" });
    const provider = await registerSingleProviderPlugin(anthropicPlugin);
    const firstConfig = {};

    for (let request = 0; request < 4; request += 1) {
      expect(
        anthropicProviderDiscovery.resolveSyntheticAuth?.({
          config: firstConfig,
          provider: "claude-cli",
        } as never)?.apiKey,
      ).toBe(CLAUDE_CLI_NATIVE_AUTH_MARKER);
      expect(
        provider.resolveSyntheticAuth?.({ config: firstConfig, provider: "claude-cli" } as never)
          ?.apiKey,
      ).toBe(CLAUDE_CLI_NATIVE_AUTH_MARKER);
    }
    expect(probeClaudeCliAuthStatusMock).toHaveBeenCalledOnce();

    probeClaudeCliAuthStatusMock.mockReturnValue({ status: "missing" });
    expect(
      anthropicProviderDiscovery.resolveSyntheticAuth?.({
        config: {},
        provider: "claude-cli",
      } as never),
    ).toBeUndefined();
    expect(probeClaudeCliAuthStatusMock).toHaveBeenCalledTimes(2);
    expect(provider.resolveSyntheticAuth?.({ provider: "claude-cli" } as never)).toBeUndefined();
    expect(probeClaudeCliAuthStatusMock).toHaveBeenCalledTimes(2);
  });

  it("does not copy native Claude auth during anthropic cli migration", async () => {
    probeClaudeCliAuthStatusMock.mockReturnValue({ status: "available" });

    const provider = await registerSingleProviderPlugin(anthropicPlugin);
    const cliAuth = provider.auth.find((entry) => entry.id === "cli");

    if (!cliAuth) {
      throw new Error("expected Anthropic CLI auth method");
    }

    const result = await cliAuth.run({
      config: {},
    } as never);

    expect(result?.profiles).toEqual([]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
