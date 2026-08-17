/** Tests auto-reply status message formatting. */
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { getContextWindowCaches, providerContextTokenCacheKey } from "../agents/context-cache.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  appendTranscriptMessageSync,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import {
  buildStatusMessage as buildStatusMessageRaw,
  type buildStatusMessage as BuildStatusMessage,
} from "../status/status-message.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { createSuccessfulImageMediaDecision } from "./media-understanding.test-fixtures.js";
import { buildCommandsMessage, buildCommandsMessagePaginated, buildHelpMessage } from "./status.js";

const buildStatusMessage: typeof BuildStatusMessage = (args) =>
  buildStatusMessageRaw({
    modelAuth: "api-key",
    activeModelAuth: "api-key",
    ...args,
  });

const { listPluginCommands } = vi.hoisted(() => ({
  listPluginCommands: vi.fn(
    (): Array<{ name: string; description: string; pluginId: string }> => [],
  ),
}));

vi.mock("../plugins/commands.js", () => ({
  listPluginCommands,
}));

beforeEach(() => {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  cliBackendsTesting.resetDepsForTest();
  listPluginCommands.mockReset();
  listPluginCommands.mockImplementation(() => []);
  getContextWindowCaches().discoveredTokenCache.clear();
});

function registerAnthropicCliBackendForTest(): void {
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
    resolveRuntimeCliBackends: () => [
      {
        id: "claude-cli",
        modelProvider: "anthropic",
        pluginId: "anthropic",
        config: { command: "claude" },
        bundleMcp: false,
      },
    ],
  });
}

type ContextBudgetStatus = NonNullable<
  NonNullable<Parameters<typeof buildStatusMessage>[0]["sessionEntry"]>["contextBudgetStatus"]
>;

function makeContextBudgetStatus(
  overrides: Partial<ContextBudgetStatus> = {},
): ContextBudgetStatus {
  return {
    schemaVersion: 1,
    source: "pre-prompt-estimate",
    updatedAt: 1,
    provider: "anthropic",
    model: "claude-sonnet-4.6",
    route: "fits",
    shouldCompact: false,
    estimatedPromptTokens: 640_000,
    contextTokenBudget: 1_000_000,
    promptBudgetBeforeReserve: 900_000,
    reserveTokens: 100_000,
    effectiveReserveTokens: 100_000,
    remainingPromptBudgetTokens: 260_000,
    overflowTokens: 0,
    toolResultReducibleChars: 0,
    messageCount: 2,
    unwindowedMessageCount: 2,
    ...overrides,
  };
}

type FallbackContextStatusOverrides = {
  sessionId: string;
  selectedContextWindow?: number;
  activeProvider?: string;
  activeModel?: string;
  activeContextWindow?: number | null;
  runtimeContextTokens?: number;
  sessionContextTokens?: number;
};

function makeFallbackContextStatusArgs({
  sessionId,
  selectedContextWindow = 1_048_576,
  activeProvider = "minimax-portal",
  activeModel = "MiniMax-M2.7",
  activeContextWindow = 200_000,
  runtimeContextTokens,
  sessionContextTokens,
}: FallbackContextStatusOverrides): Parameters<typeof buildStatusMessage>[0] {
  const providers: Record<string, { models: Array<{ id: string; contextWindow: number }> }> = {
    xiaomi: {
      models: [{ id: "mimo-v2-flash", contextWindow: selectedContextWindow }],
    },
  };
  if (activeContextWindow !== null) {
    providers[activeProvider] = {
      models: [{ id: activeModel, contextWindow: activeContextWindow }],
    };
  }

  return {
    config: { models: { providers } } as unknown as OpenClawConfig,
    agent: { model: "xiaomi/mimo-v2-flash" },
    ...(runtimeContextTokens === undefined ? {} : { runtimeContextTokens }),
    sessionEntry: {
      sessionId,
      updatedAt: 0,
      providerOverride: "xiaomi",
      modelOverride: "mimo-v2-flash",
      modelProvider: activeProvider,
      model: activeModel,
      fallbackNotice: {
        kind: "active",
        selectedModel: "xiaomi/mimo-v2-flash",
        activeModel: `${activeProvider}/${activeModel}`,
        reason: "model not allowed",
      },
      totalTokens: 49_000,
      totalTokensFresh: true,
      totalTokensVersion: 1 as const,
      ...(sessionContextTokens === undefined ? {} : { contextTokens: sessionContextTokens }),
    },
    sessionKey: "agent:main:main",
    sessionScope: "per-sender",
    queue: { mode: "collect", depth: 0 },
    modelAuth: "api-key",
    activeModelAuth: "api-key",
  };
}

describe("buildStatusMessage", () => {
  it("summarizes agent readiness and context usage", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            anthropic: {
              apiKey: "test-key",
              models: [
                {
                  id: "test:opus",
                  contextTokens: 32_000,
                  cost: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "anthropic/test:opus",
      },
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
        sessionStartedAt: 1 * 60 * 60_000 + 46 * 60_000,
        inputTokens: 1200,
        outputTokens: 800,
        totalTokens: 16_000,
        totalTokensFresh: true,
        totalTokensVersion: 1 as const,
        contextTokens: 32_000,
        thinkingLevel: "low",
        verboseLevel: "on",
        compactionCount: 2,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      resolvedThink: "medium",
      resolvedVerbose: "off",
      resolvedHarness: "openclaw",
      queue: { mode: "collect", depth: 0 },
      pluginHealthLine: "🔌 Plugins: OK",
      modelAuth: "api-key",
      subagentsLine: "🤖 Subagents: 1\n- active run",
      now: 4 * 60 * 60_000, // 4 hours after epoch
    });
    const normalized = normalizeTestText(text);

    expect(normalized).toContain("OpenClaw");
    expect(normalized).toContain("Model: anthropic/test:opus");
    expect(normalized).toContain("api-key");
    expect(normalized).toContain("Plugins: OK");
    expect(normalized).toContain("Tokens: 1.2k in / 800 out");
    expect(normalized).toContain("Cost: $0.0020");
    expect(normalized).toContain("Context: 16k/32k (50%)");
    expect(normalized).toContain("Compactions: 2");
    expect(normalized).toContain("Session: agent:main:main");
    expect(normalized).toContain("duration 2h 14m");
    expect(normalized).toContain("updated 4h ago");
    expect(normalized).toContain("Execution: direct");
    expect(normalized).toContain("Runtime: OpenClaw Default");
    expect(normalized).not.toContain("Runner:");
    expect(normalized).toContain("think medium");
    expect(normalized).not.toContain("verbose");
    expect(normalized).toContain("elevated");
    expect(normalized).toContain("Queue: collect");
    expect(normalized).toContain("- active run");
  });

  it("shows configured model costs for aws-sdk providers", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            "amazon-bedrock": {
              auth: "aws-sdk",
              models: [
                {
                  id: "us.anthropic.claude-sonnet-4-6",
                  cost: {
                    input: 3,
                    output: 15,
                    cacheRead: 0.3,
                    cacheWrite: 3.75,
                  },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "amazon-bedrock/us.anthropic.claude-sonnet-4-6",
      },
      sessionEntry: {
        sessionId: "bedrock-session",
        updatedAt: 0,
        inputTokens: 1_000,
        outputTokens: 2_000,
        cacheRead: 500,
        cacheWrite: 2_000,
        totalTokens: 5_500,
        contextTokens: 200_000,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "aws-sdk",
      activeModelAuth: "aws-sdk",
      now: 10 * 60_000,
    });
    const normalized = normalizeTestText(text);

    expect(normalized).toContain("Model: amazon-bedrock/us.anthropic.claude-sonnet-4-6");
    expect(normalized).toContain("aws-sdk");
    expect(normalized).toContain("Tokens: 1.0k in / 2.0k out");
    expect(normalized).toContain("Cost: $0.04");
  });

  it.each([
    {
      name: "does not render stale totalTokens as current context usage",
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
        inputTokens: 3_800_000,
        outputTokens: 20_000,
        totalTokens: 3_800_000,
        totalTokensFresh: false,
        contextTokens: 1_000_000,
      },
      expectedContext: "Context: ?/1.0m",
      unexpectedContext: "Context: 3.8m/1.0m",
    },
    {
      name: "treats legacy unknown-freshness totalTokens as unknown context",
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
        totalTokens: 25_000,
        contextTokens: 1_000_000,
      },
      expectedContext: "Context: ?/1.0m",
      unexpectedContext: "Context: 25k/1.0m",
    },
  ])("$name", ({ sessionEntry, expectedContext, unexpectedContext }) => {
    const text = buildStatusMessage({
      agent: {
        model: "anthropic/test:opus",
      },
      runtimeContextTokens: 1_000_000,
      sessionEntry,
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      now: 10 * 60_000,
    });
    const normalized = normalizeTestText(text);

    expect(normalized).toContain(expectedContext);
    expect(normalized).not.toContain(unexpectedContext);
  });

  it("uses estimated context budget status when fresh totalTokens are unavailable", () => {
    const text = buildStatusMessage({
      agent: {
        model: "anthropic/claude-sonnet-4.6",
      },
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
        inputTokens: 3_800_000,
        outputTokens: 20_000,
        totalTokens: 3_800_000,
        totalTokensFresh: false,
        contextTokens: 1_000_000,
        contextBudgetStatus: makeContextBudgetStatus(),
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      now: 10 * 60_000,
    });
    const normalized = normalizeTestText(text);

    expect(normalized).toContain("Context: ~640k/1.0m (64% est)");
    expect(normalized).not.toContain("Context: ?/1.0m");
    expect(normalized).not.toContain("Context: 3.8m/1.0m");
  });

  it.each([
    {
      name: "prefers fresh totalTokens over estimated context budget status",
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
        totalTokens: 36_000,
        totalTokensFresh: true,
        totalTokensVersion: 1 as const,
        contextTokens: 1_000_000,
        contextBudgetStatus: makeContextBudgetStatus(),
      },
      expectedContext: "Context: 36k/1.0m (4%)",
      unexpectedContext: "~640k",
    },
    {
      name: "uses estimated context budget status when token usage is absent",
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
        contextTokens: 1_000_000,
        contextBudgetStatus: makeContextBudgetStatus({
          estimatedPromptTokens: 125_000,
          remainingPromptBudgetTokens: 775_000,
        }),
      },
      expectedContext: "Context: ~125k/1.0m (13% est)",
      unexpectedContext: "Context: 0/1.0m",
    },
  ])("$name", ({ sessionEntry, expectedContext, unexpectedContext }) => {
    const text = buildStatusMessage({
      agent: {
        model: "anthropic/claude-sonnet-4.6",
      },
      sessionEntry,
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      now: 10 * 60_000,
    });
    const normalized = normalizeTestText(text);

    expect(normalized).toContain(expectedContext);
    expect(normalized).not.toContain(unexpectedContext);
  });

  it("shows sanitized TTS provider details in the voice status line", async () => {
    await withTempHome(async () => {
      const text = buildStatusMessage({
        config: {
          tts: {
            auto: "always",
            provider: "openai",
            providers: {
              openai: {
                displayName: "NeuTTS local",
                baseUrl: "http://username@127.0.0.1:18801/v1?token=hidden#fragment",
                model: "neutts-nano",
                voice: "clara",
              },
            },
          },
        } as unknown as OpenClawConfig,
        agent: {},
        now: 0,
      });
      const normalized = normalizeTestText(text);

      expect(normalized).toContain(
        "Voice: always · provider=openai · name=NeuTTS local · model=neutts-nano · voice=clara · endpoint=custom(http://127.0.0.1:18801/v1)",
      );
      expect(normalized).not.toContain("username");
      expect(normalized).not.toContain("token=hidden");
      expect(normalized).not.toContain("fragment");
    });
  });

  it("shows the model runtime for CLI-backed providers", () => {
    const text = buildStatusMessage({
      config: {
        agents: {
          defaults: {},
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "claude-cli/opus",
      },
      sessionEntry: {
        sessionId: "cli",
        updatedAt: 0,
        modelProvider: "claude-cli",
        model: "opus",
      },
      sessionKey: "agent:main:main",
      queue: { mode: "collect", depth: 0 },
    });

    expect(normalizeTestText(text)).toContain("Runtime: Claude CLI");
  });

  it("falls back to the configured CLI provider when session provider fields are empty", () => {
    const text = buildStatusMessage({
      config: {
        agents: {
          defaults: {},
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "claude-cli/opus",
      },
      sessionEntry: {
        sessionId: "cli-default",
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      queue: { mode: "collect", depth: 0 },
    });

    expect(normalizeTestText(text)).toContain("Runtime: Claude CLI");
  });

  it("shows the ACP runtime agent and backend when ACP owns the session", () => {
    const text = buildStatusMessage({
      agent: {
        model: "anthropic/claude-opus-4-6",
      },
      sessionEntry: {
        sessionId: "acp",
        updatedAt: 0,
        acp: {
          backend: "acpx",
          agent: "gemini",
          runtimeSessionName: "status-test",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 0,
        },
      },
      sessionKey: "agent:main:main",
      queue: { mode: "collect", depth: 0 },
    });

    expect(normalizeTestText(text)).toContain("Runtime: gemini (acp/acpx)");
  });

  it("sanitizes runtime labels sourced from session metadata", () => {
    const text = buildStatusMessage({
      agent: {
        model: "anthropic/claude-opus-4-6",
      },
      sessionEntry: {
        sessionId: "acp-sanitized",
        updatedAt: 0,
        acp: {
          backend: "acpx\nrewritten",
          agent: "gemini\u001b[2K",
          runtimeSessionName: "status-test",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 0,
        },
      },
      sessionKey: "agent:main:main",
      queue: { mode: "collect", depth: 0 },
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Runtime: gemini (acp/acpx\\nrewritten)");
    expect(normalized).not.toContain("\u001b");
  });

  it("falls back to sessionEntry levels when resolved levels are not passed", () => {
    const text = buildStatusMessage({
      agent: {
        model: "anthropic/test:opus",
      },
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
        thinkingLevel: "high",
        verboseLevel: "full",
        reasoningLevel: "on",
      },
      sessionKey: "agent:main:main",
      queue: { mode: "collect", depth: 0 },
    });
    const normalized = normalizeTestText(text);

    expect(normalized).toContain("think high");
    expect(normalized).toContain("verbose:full");
    expect(normalized).toContain("reasoning on");
  });

  it("shows plugin status lines only when verbose is enabled", () => {
    const visible = normalizeTestText(
      buildStatusMessage({
        agent: {
          model: "anthropic/test:opus",
        },
        sessionEntry: {
          sessionId: "abc",
          updatedAt: 0,
          verboseLevel: "on",
          pluginDebugEntries: [
            {
              pluginId: "active-memory",
              lines: ["🧩 Active Memory: status=timeout elapsed=15s query=recent"],
            },
          ],
        },
        sessionKey: "agent:main:main",
        queue: { mode: "collect", depth: 0 },
      }),
    );
    const hidden = normalizeTestText(
      buildStatusMessage({
        agent: {
          model: "anthropic/test:opus",
        },
        sessionEntry: {
          sessionId: "abc",
          updatedAt: 0,
          verboseLevel: "off",
          pluginDebugEntries: [
            {
              pluginId: "active-memory",
              lines: ["🧩 Active Memory: status=timeout elapsed=15s query=recent"],
            },
          ],
        },
        sessionKey: "agent:main:main",
        queue: { mode: "collect", depth: 0 },
      }),
    );

    expect(visible).toContain("Active Memory: status=timeout elapsed=15s query=recent");
    expect(hidden).not.toContain("Active Memory: status=timeout elapsed=15s query=recent");
  });

  it("shows structured plugin debug lines in verbose status", () => {
    const visible = normalizeTestText(
      buildStatusMessage({
        agent: {
          model: "anthropic/test:opus",
        },
        sessionEntry: {
          sessionId: "abc",
          updatedAt: 0,
          verboseLevel: "on",
          pluginDebugEntries: [
            {
              pluginId: "active-memory",
              lines: ["🧩 Active Memory: status=ok elapsed=842ms query=recent summary=34 chars"],
            },
          ],
        },
        sessionKey: "agent:main:main",
        queue: { mode: "collect", depth: 0 },
      }),
    );

    expect(visible).toContain(
      "Active Memory: status=ok elapsed=842ms query=recent summary=34 chars",
    );
  });

  it("shows trace lines only when trace is enabled", () => {
    const hidden = normalizeTestText(
      buildStatusMessage({
        agent: {
          model: "anthropic/test:opus",
        },
        sessionEntry: {
          sessionId: "abc",
          updatedAt: 0,
          verboseLevel: "on",
          pluginDebugEntries: [
            { pluginId: "active-memory", lines: ["🔎 Active Memory Debug: spicy ramen; tacos"] },
          ],
        },
        sessionKey: "agent:main:main",
        queue: { mode: "collect", depth: 0 },
      }),
    );
    const visible = normalizeTestText(
      buildStatusMessage({
        agent: {
          model: "anthropic/test:opus",
        },
        sessionEntry: {
          sessionId: "abc",
          updatedAt: 0,
          verboseLevel: "off",
          traceLevel: "on",
          pluginDebugEntries: [
            { pluginId: "active-memory", lines: ["🔎 Active Memory Debug: spicy ramen; tacos"] },
          ],
        },
        sessionKey: "agent:main:main",
        queue: { mode: "collect", depth: 0 },
      }),
    );

    expect(hidden).not.toContain("Active Memory Debug: spicy ramen; tacos");
    expect(visible).toContain("Active Memory Debug: spicy ramen; tacos");
    expect(visible).toContain("trace");
  });

  it("shows raw trace mode and plugin trace lines in status", () => {
    const visible = normalizeTestText(
      buildStatusMessage({
        agent: {
          model: "anthropic/test:opus",
        },
        sessionEntry: {
          sessionId: "abc",
          updatedAt: 0,
          verboseLevel: "off",
          traceLevel: "raw",
          pluginDebugEntries: [
            { pluginId: "active-memory", lines: ["🔎 Active Memory Debug: spicy ramen; tacos"] },
          ],
        },
        sessionKey: "agent:main:main",
        queue: { mode: "collect", depth: 0 },
      }),
    );

    expect(visible).toContain("Active Memory Debug: spicy ramen; tacos");
    expect(visible).toContain("trace:raw");
  });

  it.each([
    {
      name: "shows fast mode when enabled",
      model: "openai/gpt-5.4",
      sessionId: "fast",
      fastMode: true,
      expected: "fast",
    },
    {
      name: "shows fast mode when disabled",
      model: "anthropic/claude-opus-4-6",
      sessionId: "fast-off",
      fastMode: false,
      expected: "fast off",
    },
  ])("$name", ({ model, sessionId, fastMode, expected }) => {
    const text = buildStatusMessage({
      agent: { model },
      sessionEntry: { sessionId, updatedAt: 0, fastMode },
      sessionKey: "agent:main:main",
      queue: { mode: "collect", depth: 0 },
    });

    expect(normalizeTestText(text)).toContain(expected);
  });

  it.each([
    {
      name: "shows the Codex harness as the model runtime when resolved",
      sessionId: "codex-harness",
      resolvedHarness: "codex" as const,
      expectedRuntime: "Runtime: OpenAI Codex",
      unexpectedSuffix: "· codex",
    },
    {
      name: "shows the default OpenClaw harness as the model runtime",
      sessionId: "openclaw-harness",
      resolvedHarness: "openclaw" as const,
      expectedRuntime: "Runtime: OpenClaw Default",
      unexpectedSuffix: "· openclaw",
    },
  ])("$name", ({ sessionId, resolvedHarness, expectedRuntime, unexpectedSuffix }) => {
    const text = buildStatusMessage({
      agent: { model: "openai/gpt-5.4" },
      sessionEntry: { sessionId, updatedAt: 0, fastMode: true },
      sessionKey: "agent:main:main",
      queue: { mode: "collect", depth: 0 },
      resolvedHarness,
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("fast");
    expect(normalized).toContain(expectedRuntime);
    expect(normalized).not.toContain(unexpectedSuffix);
  });

  it("shows configured text verbosity for the active model", () => {
    const text = buildStatusMessage({
      config: {
        agents: {
          defaults: {
            model: "openai/gpt-5.4",
            models: {
              "openai/gpt-5.4": {
                params: {
                  textVerbosity: "low",
                },
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "openai/gpt-5.4",
      },
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      queue: { mode: "collect", depth: 0 },
    });

    expect(normalizeTestText(text)).toContain("text low");
  });

  it("shows per-agent text verbosity overrides for the active model", () => {
    const text = buildStatusMessage({
      config: {
        agents: {
          defaults: {
            model: "openai/gpt-5.4",
            models: {
              "openai/gpt-5.4": {
                params: {
                  textVerbosity: "high",
                },
              },
            },
          },
          list: [
            {
              id: "main",
              params: {
                text_verbosity: "low",
              },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      agentId: "main",
      agent: {
        model: "openai/gpt-5.4",
      },
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      queue: { mode: "collect", depth: 0 },
    });

    expect(normalizeTestText(text)).toContain("text low");
  });

  it("notes channel model overrides in status output", () => {
    const text = buildStatusMessage({
      config: {
        channels: {
          modelByChannel: {
            discord: {
              "123": "openai/gpt-4.1",
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "openai/gpt-4.1",
      },
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
        delivery: normalizeSessionDeliveryState({ context: { channel: "discord" } }),
        groupId: "123",
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
    });
    const normalized = normalizeTestText(text);

    expect(normalized).toContain("Model: openai/gpt-4.1");
    expect(normalized).toContain("channel override");
  });

  it("uses the channel override model context window instead of stale persisted context", () => {
    const text = buildStatusMessage({
      config: {
        channels: {
          modelByChannel: {
            discord: {
              "123": "minimax-portal/MiniMax-M2.7",
            },
          },
        },
        models: {
          providers: {
            "minimax-portal": {
              models: [{ id: "MiniMax-M2.7", contextWindow: 200_000 }],
            },
            anthropic: {
              models: [{ id: "claude-opus-4-6", contextWindow: 1_048_576 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "minimax-portal/MiniMax-M2.7",
      },
      sessionEntry: {
        sessionId: "channel-context-window",
        updatedAt: 0,
        delivery: normalizeSessionDeliveryState({ context: { channel: "discord" } }),
        groupId: "123",
        totalTokens: 49_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        contextTokens: 1_048_576,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
    });
    const normalized = normalizeTestText(text);

    expect(normalized).toContain("Model: minimax-portal/MiniMax-M2.7");
    expect(normalized).toContain("channel override");
    expect(normalized).toContain("Context: 49k/200k");
    expect(normalized).not.toContain("Context: 49k/1.0m");
  });

  it("shows 1M context window when anthropic context1m is enabled", () => {
    const text = buildStatusMessage({
      config: {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {
                params: { context1m: true },
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "anthropic/claude-opus-4-6",
      },
      sessionEntry: {
        sessionId: "ctx1m",
        updatedAt: 0,
        totalTokens: 200_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
    });

    expect(normalizeTestText(text)).toContain("Context: 200k/1.0m");
  });

  it("keeps bare Claude CLI opus 4.7 variants at the plan-safe context window", () => {
    const text = buildStatusMessage({
      agent: {
        model: "claude-cli/claude-opus-4.7-20260219",
      },
      sessionEntry: {
        sessionId: "opus47",
        updatedAt: 0,
        totalTokens: 200_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 200k/200k");
    expect(normalized).not.toContain("Context: 200k/1.0m");
  });

  it("recomputes context window from the active model after switching away from a smaller session override", () => {
    const sessionEntry = {
      sessionId: "switch-back",
      updatedAt: 0,
      providerOverride: "local",
      modelOverride: "small-model",
      contextTokens: 4_096,
      totalTokens: 1_024,
      totalTokensFresh: true,
      totalTokensVersion: 1 as const,
    };

    applyModelOverrideToSessionEntry({
      entry: sessionEntry,
      selection: {
        provider: "local",
        model: "large-model",
        isDefault: true,
      },
    });

    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            local: {
              models: [{ id: "large-model", contextWindow: 65_536 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "local/large-model",
      },
      sessionEntry,
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
    });

    expect(normalizeTestText(text)).toContain("Context: 1.0k/66k");
  });

  it("ignores stale session contextTokens after the default model changes", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            "ollama-cloud": {
              models: [{ id: "kimi-k2.7-code", contextWindow: 262_144 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "ollama-cloud/kimi-k2.7-code",
      },
      sessionEntry: {
        sessionId: "default-model-context-window",
        updatedAt: 0,
        modelProvider: "ollama-cloud",
        model: "deepseek-v4-pro",
        totalTokens: 501,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        contextTokens: 1_000_000,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: ollama-cloud/kimi-k2.7-code");
    expect(normalized).toContain("Context: 501/262k");
    expect(normalized).not.toContain("Context: 501/1.0m");
  });

  it("uses the selected model window when a stale runtime snapshot is smaller", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            "ollama-cloud": {
              models: [
                { id: "deepseek-v4-pro", contextWindow: 1_000_000 },
                { id: "kimi-k2.7-code", contextWindow: 262_144 },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "ollama-cloud/deepseek-v4-pro",
      },
      sessionEntry: {
        sessionId: "default-model-context-window-larger",
        updatedAt: 0,
        modelProvider: "ollama-cloud",
        model: "kimi-k2.7-code",
        totalTokens: 0,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        contextTokens: 262_144,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: ollama-cloud/deepseek-v4-pro");
    expect(normalized).toContain("Context: 0/1.0m");
    expect(normalized).not.toContain("Context: 0/262k");
  });

  it.each([
    {
      name: "recomputes context window from the active fallback model when session contextTokens are stale",
      overrides: {
        sessionId: "fallback-context-window",
        sessionContextTokens: 1_048_576,
      },
      expectedFallback: "Fallback: minimax-portal/MiniMax-M2.7",
      expectedContext: "Context: 49k/200k",
      unexpectedContext: "Context: 49k/1.0m",
    },
    {
      name: "keeps a persisted fallback limit when the active runtime model lookup is unavailable",
      overrides: {
        sessionId: "fallback-context-window-persisted-unknown-active",
        activeProvider: "custom-runtime",
        activeModel: "unknown-fallback-model",
        activeContextWindow: null,
        sessionContextTokens: 128_000,
      },
      expectedFallback: "Fallback: custom-runtime/unknown-fallback-model",
      expectedContext: "Context: 49k/128k",
      unexpectedContext: "Context: 49k/1.0m",
    },
    {
      name: "does not synthesize a 32k fallback window when the active runtime model is unknown",
      overrides: {
        sessionId: "fallback-context-window-unknown-active-model",
        selectedContextWindow: 128_000,
        activeProvider: "custom-runtime",
        activeModel: "unknown-fallback-model",
        activeContextWindow: null,
        sessionContextTokens: 128_000,
      },
      expectedFallback: "Fallback: custom-runtime/unknown-fallback-model",
      expectedContext: "Context: 49k/128k",
      unexpectedContext: "Context: 49k/32k",
    },
  ])("$name", ({ overrides, expectedFallback, expectedContext, unexpectedContext }) => {
    const normalized = normalizeTestText(
      buildStatusMessage(makeFallbackContextStatusArgs(overrides)),
    );

    expect(normalized).toContain(expectedFallback);
    expect(normalized).toContain(expectedContext);
    expect(normalized).not.toContain(unexpectedContext);
  });

  it("renders CLI runtime aliases as the selected model route", () => {
    registerAnthropicCliBackendForTest();

    const text = buildStatusMessage({
      agent: {
        model: "anthropic/claude-opus-4-7",
      },
      sessionEntry: {
        sessionId: "claude-cli-runtime-alias",
        updatedAt: 0,
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-7",
        modelProvider: "claude-cli",
        model: "claude-opus-4-7",
        fallbackNotice: {
          kind: "active",
          selectedModel: "anthropic/claude-opus-4-7",
          activeModel: "claude-cli/claude-opus-4-7",
          reason: "selected model unavailable",
        },
        inputTokens: 29,
        outputTokens: 19_000,
        cacheRead: 3_000_000,
        totalTokens: 36_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        contextTokens: 1_000_000,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "unknown",
      activeModelAuth: "oauth (anthropic:claude-cli)",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: anthropic/claude-opus-4-7");
    expect(normalized).toContain("oauth (anthropic:claude-cli)");
    expect(normalized).not.toContain("Fallback: claude-cli/claude-opus-4-7");
    expect(normalized).not.toContain("unknown");
    expect(normalized).toContain("Context: 36k/200k (18%)");
  });

  it("prefers active CLI OAuth over selected env API-key labels for runtime aliases", () => {
    registerAnthropicCliBackendForTest();

    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            anthropic: {
              models: [
                {
                  id: "claude-opus-4-7",
                  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "anthropic/claude-opus-4-7",
      },
      sessionEntry: {
        sessionId: "claude-cli-runtime-alias-env-key",
        updatedAt: 0,
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-7",
        modelProvider: "claude-cli",
        model: "claude-opus-4-7",
        fallbackNotice: {
          kind: "active",
          selectedModel: "anthropic/claude-opus-4-7",
          activeModel: "claude-cli/claude-opus-4-7",
          reason: "selected model unavailable",
        },
        inputTokens: 29,
        outputTokens: 19_000,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key (env: ANTHROPIC_API_KEY)",
      activeModelAuth: "oauth (anthropic:claude-cli)",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: anthropic/claude-opus-4-7");
    expect(normalized).toContain("oauth (anthropic:claude-cli)");
    expect(normalized).not.toContain("api-key (env: ANTHROPIC_API_KEY)");
    expect(normalized).not.toContain("Fallback: claude-cli/claude-opus-4-7");
    expect(normalized).not.toContain("Cost:");
  });

  it.each([
    {
      name: "keeps an explicit runtime context limit when fallback status already computed one",
      overrides: {
        sessionId: "fallback-context-window-live-limit",
        runtimeContextTokens: 123_456,
        sessionContextTokens: 1_048_576,
      },
      expectedContext: "Context: 49k/123k",
      unexpectedContext: "Context: 49k/1.0m",
      otherUnexpectedContext: "Context: 49k/200k",
    },
    {
      name: "keeps the persisted runtime context limit for fallback sessions when no live override is passed",
      overrides: {
        sessionId: "fallback-context-window-persisted-limit",
        sessionContextTokens: 123_456,
      },
      expectedContext: "Context: 49k/123k",
      unexpectedContext: "Context: 49k/1.0m",
      otherUnexpectedContext: "Context: 49k/200k",
    },
  ])("$name", ({ overrides, expectedContext, unexpectedContext, otherUnexpectedContext }) => {
    const normalized = normalizeTestText(
      buildStatusMessage(makeFallbackContextStatusArgs(overrides)),
    );

    expect(normalized).toContain("Fallback: minimax-portal/MiniMax-M2.7");
    expect(normalized).toContain(expectedContext);
    expect(normalized).not.toContain(unexpectedContext);
    expect(normalized).not.toContain(otherUnexpectedContext);
  });

  it("uses per-agent sandbox config when config and session key are provided", () => {
    const text = buildStatusMessage({
      config: {
        agents: {
          list: [
            { id: "main", default: true },
            { id: "discord", sandbox: { mode: "all" } },
          ],
        },
      } as unknown as OpenClawConfig,
      agent: {},
      sessionKey: "agent:discord:discord:channel:1456350065223270435",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
    });

    expect(normalizeTestText(text)).toContain("Execution: docker/all");
  });

  it("shows verbose/elevated labels only when enabled", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-6" },
      sessionEntry: { sessionId: "v1", updatedAt: 0 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      resolvedThink: "low",
      resolvedVerbose: "on",
      resolvedElevated: "on",
      queue: { mode: "collect", depth: 0 },
    });

    expect(text).toContain("verbose");
    expect(text).toContain("elevated");
  });

  it("includes media understanding decisions when present", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-6" },
      sessionEntry: { sessionId: "media", updatedAt: 0 },
      sessionKey: "agent:main:main",
      queue: { mode: "none" },
      mediaDecisions: [
        createSuccessfulImageMediaDecision() as unknown as NonNullable<
          Parameters<typeof buildStatusMessage>[0]["mediaDecisions"]
        >[number],
        {
          capability: "audio",
          outcome: "skipped",
          attachmentDispositions: { 1: { kind: "failed" } },
          attachments: [
            {
              attachmentIndex: 1,
              attempts: [
                {
                  type: "provider",
                  outcome: "skipped",
                  reason: "maxBytes: too large",
                },
              ],
            },
          ],
        },
      ],
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Media: image ok (openai/gpt-5.4) · audio skipped (maxBytes)");
  });

  it("distinguishes observed local STT backends from requested backends", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-6" },
      sessionEntry: { sessionId: "media-local-stt", updatedAt: 0 },
      sessionKey: "agent:main:main",
      queue: { mode: "none" },
      mediaDecisions: [
        {
          capability: "audio",
          outcome: "success",
          attachmentDispositions: { 0: { kind: "handled" } },
          attachments: [
            {
              attachmentIndex: 0,
              attempts: [],
              chosen: {
                type: "cli",
                provider: "whisper-cli",
                model: "whisper-cli",
                requestedBackend: "device:0",
                observedBackend: "metal",
                outcome: "success",
              },
            },
          ],
        },
      ],
    });

    expect(normalizeTestText(text)).toContain("Media: audio ok (whisper-cli observed=metal)");
  });

  it("includes failed media understanding decisions with the surfaced reason", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-6" },
      sessionEntry: { sessionId: "media-failed", updatedAt: 0 },
      sessionKey: "agent:main:main",
      queue: { mode: "none" },
      mediaDecisions: [
        {
          capability: "audio",
          outcome: "failed",
          attachmentDispositions: { 0: { kind: "failed" } },
          attachments: [
            {
              attachmentIndex: 0,
              attempts: [
                {
                  type: "provider",
                  outcome: "skipped",
                  reason: "empty output",
                },
                {
                  type: "provider",
                  outcome: "failed",
                  reason: "Error: Audio transcription response missing text",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(normalizeTestText(text)).toContain(
      "Media: audio failed (Audio transcription response missing text)",
    );
    expect(normalizeTestText(text)).not.toContain("empty output");
  });

  it("omits media line when all decisions are none", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-6" },
      sessionEntry: { sessionId: "media-none", updatedAt: 0 },
      sessionKey: "agent:main:main",
      queue: { mode: "none" },
      mediaDecisions: [
        {
          capability: "image",
          outcome: "no-attachment",
          attachments: [],
          attachmentDispositions: {},
          nativeVisionActive: false,
        },
        {
          capability: "audio",
          outcome: "no-attachment",
          attachments: [],
          attachmentDispositions: {},
        },
        {
          capability: "video",
          outcome: "no-attachment",
          attachments: [],
          attachmentDispositions: {},
        },
      ],
    });

    expect(normalizeTestText(text)).not.toContain("Media:");
  });

  it("does not show elevated label when session explicitly disables it", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-6", elevatedDefault: "on" },
      sessionEntry: { sessionId: "v1", updatedAt: 0, elevatedLevel: "off" },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      resolvedThink: "low",
      resolvedVerbose: "off",
      queue: { mode: "collect", depth: 0 },
    });

    const optionsLine = text.split("\n").find((line) => line.trim().startsWith("⚙️"));
    if (!optionsLine) {
      throw new Error("expected status options line");
    }
    expect(optionsLine).not.toContain("elevated");
  });

  it("shows selected model and active runtime model when they differ", () => {
    const text = buildStatusMessage({
      agent: {
        model: "anthropic/claude-opus-4-6",
      },
      sessionEntry: {
        sessionId: "override-1",
        updatedAt: 0,
        providerOverride: "openai",
        modelOverride: "gpt-4.1-mini",
        modelProvider: "anthropic",
        model: "claude-haiku-4-5",
        fallbackNotice: {
          kind: "active",
          selectedModel: "openai/gpt-4.1-mini",
          activeModel: "anthropic/claude-haiku-4-5",
          reason: "rate limit",
        },
        contextTokens: 32_000,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      activeModelAuth: "api-key di_123…abc (deepinfra:default)",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: openai/gpt-4.1-mini");
    expect(normalized).toContain("Fallback: anthropic/claude-haiku-4-5");
    expect(normalized).toContain("(rate limit)");
    expect(normalized).not.toContain(" - Reason:");
    expect(normalized).not.toContain("Active:");
    expect(normalized).toContain("di_123...abc");
  });

  it("omits active fallback details when runtime drift does not match fallback state", () => {
    const text = buildStatusMessage({
      agent: {
        model: "openai/gpt-4.1-mini",
      },
      sessionEntry: {
        sessionId: "runtime-drift-only",
        updatedAt: 0,
        modelProvider: "anthropic",
        model: "claude-haiku-4-5",
        fallbackNotice: {
          kind: "active",
          selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
          activeModel: "deepinfra/moonshotai/Kimi-K2.5",
          reason: "rate limit",
        },
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      activeModelAuth: "api-key di_123…abc (deepinfra:default)",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: openai/gpt-4.1-mini");
    expect(normalized).not.toContain("Fallback:");
    expect(normalized).not.toContain("(rate limit)");
  });

  it("omits active lines when runtime matches selected model", () => {
    const text = buildStatusMessage({
      agent: {
        model: "openai/gpt-4.1-mini",
      },
      sessionEntry: {
        sessionId: "selected-active-same",
        updatedAt: 0,
        modelProvider: "openai",
        model: "gpt-4.1-mini",
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).not.toContain("Fallback:");
  });

  it("shows configured fallback models when provided", () => {
    const text = buildStatusMessage({
      agent: {
        model: {
          primary: "anthropic/claude-opus-4-6",
          fallbacks: ["google/gemini-2.5-flash", "openai/gpt-5-mini"],
        },
      },
      sessionEntry: { sessionId: "fb1", updatedAt: 0 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallbacks: google/gemini-2.5-flash, openai/gpt-5-mini");
  });

  it("omits configured fallbacks for a session-selected model", () => {
    const text = buildStatusMessage({
      configuredDefaultModelLabel: "google/gemini-3-flash-preview",
      agent: {
        model: {
          primary: "google/gemini-3-flash-preview",
          fallbacks: [
            "google/gemini-3.1-flash-lite",
            "google/gemini-2.5-flash",
            "google/gemini-3.1-pro-preview",
          ],
        },
      },
      sessionEntry: {
        sessionId: "fb-session-selected",
        updatedAt: 0,
        modelProvider: "google",
        model: "gemini-3.1-flash-lite",
        modelOverride: "gemini-3.1-flash-lite",
        modelOverrideSource: "user",
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: google/gemini-3.1-flash-lite");
    expect(normalized).not.toContain("Fallbacks:");
  });

  it("omits configured fallbacks line when no fallbacks provided", () => {
    const text = buildStatusMessage({
      agent: {
        model: "anthropic/claude-opus-4-6",
      },
      sessionEntry: { sessionId: "fb2", updatedAt: 0 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).not.toContain("Fallbacks:");
  });

  it("keeps provider prefix from configured model", () => {
    const text = buildStatusMessage({
      agent: {
        model: "google-antigravity/claude-sonnet-4-6",
      },
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    expect(normalizeTestText(text)).toContain("Model: google-antigravity/claude-sonnet-4-6");
  });

  it("renders session-selected model overrides compactly", () => {
    const text = buildStatusMessage({
      agent: {
        model: "zhipu/glm-4.5-air",
      },
      configuredDefaultModelLabel: "zhipu/glm-4.5-air",
      sessionEntry: {
        sessionId: "pinned-session",
        updatedAt: 0,
        providerOverride: "deepseek",
        modelOverride: "deepseek-v4-flash",
        modelOverrideSource: "user",
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: deepseek/deepseek-v4-flash");
    expect(normalized).toContain("pinned session; config primary zhipu/glm-4.5-air");
    expect(normalized).toContain("clear /model default");
    expect(normalized).not.toContain("Configured default:");
    expect(normalized).not.toContain("Session selected:");
    expect(normalized).not.toContain("Reason: session override");
    expect(normalized).not.toContain("This session is pinned");
    expect(normalized).not.toContain(
      "Docs: https://docs.openclaw.ai/concepts/models#selection-source-and-fallback-behavior",
    );
  });

  it("does not warn when only the last runtime model differs from the configured default", () => {
    const text = buildStatusMessage({
      agent: {
        model: "zhipu/glm-4.5-air",
      },
      configuredDefaultModelLabel: "zhipu/glm-4.5-air",
      sessionEntry: {
        sessionId: "runtime-snapshot-only",
        updatedAt: 0,
        modelProvider: "deepseek",
        model: "deepseek-v4-flash",
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: zhipu/glm-4.5-air");
    expect(normalized).not.toContain("Configured default:");
    expect(normalized).not.toContain("Reason: session override");
  });

  it("does not label auto fallback model overrides as pinned selections", () => {
    const text = buildStatusMessage({
      agent: {
        model: "zhipu/glm-4.5-air",
      },
      configuredDefaultModelLabel: "zhipu/glm-4.5-air",
      sessionEntry: {
        sessionId: "auto-fallback",
        updatedAt: 0,
        providerOverride: "deepseek",
        modelOverride: "deepseek-v4-flash",
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "zhipu",
        modelOverrideFallbackOriginModel: "glm-4.5-air",
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: deepseek/deepseek-v4-flash");
    expect(normalized).not.toContain("Configured default:");
    expect(normalized).not.toContain("Reason: session override");
  });

  it("handles missing agent config gracefully", () => {
    const text = buildStatusMessage({
      agent: {},
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model:");
    expect(normalized).toContain("Context:");
    expect(normalized).toContain("Queue: collect");
  });

  it("includes group activation for group sessions", () => {
    const text = buildStatusMessage({
      agent: {},
      sessionEntry: {
        sessionId: "g1",
        updatedAt: 0,
        groupActivation: "always",
        chatType: "group",
      },
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    expect(text).toContain("Activation: always");
  });

  it("shows queue details when overridden", () => {
    const text = buildStatusMessage({
      agent: {},
      sessionEntry: { sessionId: "q1", updatedAt: 0 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: {
        mode: "collect",
        depth: 3,
        debounceMs: 2000,
        cap: 5,
        dropPolicy: "old",
        showDetails: true,
      },
      modelAuth: "api-key",
    });

    expect(text).toContain("Queue: collect (depth 3 · debounce 2s · cap 5 · drop old)");
  });

  it("inserts usage summary beneath context line", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-6" },
      runtimeContextTokens: 32_000,
      sessionEntry: { sessionId: "u1", updatedAt: 0, totalTokens: 1000 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      usageLine: "📊 Usage: Claude 80% left (5h)",
      modelAuth: "api-key",
    });

    const lines = normalizeTestText(text).split("\n");
    const contextIndex = lines.findIndex((line) => line.includes("Context:"));
    expect(contextIndex).toBeGreaterThan(-1);
    expect(lines[contextIndex + 1]).toContain("Usage: Claude 80% left (5h)");
  });

  it("shows configured model costs when not using an API key", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            anthropic: {
              models: [
                {
                  id: "claude-opus-4-6",
                  cost: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: { model: "anthropic/claude-opus-4-6" },
      sessionEntry: { sessionId: "c1", updatedAt: 0, inputTokens: 10 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "oauth",
    });

    expect(text).toContain("💵 Cost: $0.0000");
  });

  function writeTranscriptUsageLog(params: {
    dir: string;
    agentId: string;
    sessionId: string;
    model?: string;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
    };
  }) {
    void params.dir;
    const scope = {
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: `agent:${params.agentId}:main`,
      storePath: resolveSessionStorePathCore(undefined, { agentId: params.agentId }),
    };
    replaceSessionEntrySync(scope, { sessionId: params.sessionId, updatedAt: Date.now() });
    appendTranscriptMessageSync(scope, {
      message: {
        role: "assistant",
        model: params.model ?? "claude-opus-4-6",
        usage: params.usage,
      },
    });
  }

  const baselineTranscriptUsage = {
    input: 1,
    output: 2,
    cacheRead: 1000,
    cacheWrite: 0,
    totalTokens: 1003,
  } as const;

  function writeBaselineTranscriptUsageLog(params: {
    dir: string;
    agentId: string;
    sessionId: string;
  }) {
    writeTranscriptUsageLog({
      ...params,
      usage: baselineTranscriptUsage,
    });
  }

  function buildTranscriptStatusText(params: { sessionId: string; sessionKey: string }) {
    return buildStatusMessage({
      agent: {
        model: "anthropic/claude-opus-4-6",
      },
      sessionEntry: {
        sessionId: params.sessionId,
        updatedAt: 0,
        totalTokens: 3,
        contextTokens: 32_000,
      },
      sessionKey: params.sessionKey,
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      includeTranscriptUsage: true,
      modelAuth: "api-key",
    });
  }

  it.each([
    {
      name: "prefers cached prompt tokens from the session log",
      agentId: "main",
      sessionId: "sess-1",
      sessionKey: "agent:main:main",
      expected: "Context: 1.0k/32k",
    },
    {
      name: "reads transcript usage for non-default agents",
      agentId: "worker1",
      sessionId: "sess-worker1",
      sessionKey: "agent:worker1:telegram:12345",
      expected: "Context: 1.0k/32k",
    },
    {
      name: "hydrates cache usage from transcript fallback",
      agentId: "main",
      sessionId: "sess-cache-hydration",
      sessionKey: "agent:main:main",
      expected: "Cache: 100% hit · 1.0k cached, 0 new",
    },
  ])("$name", async ({ agentId, sessionId, sessionKey, expected }) => {
    await withTempHome(
      async (dir) => {
        writeBaselineTranscriptUsageLog({ dir, agentId, sessionId });

        const text = buildTranscriptStatusText({ sessionId, sessionKey });

        expect(normalizeTestText(text)).toContain(expected);
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("does not render stale context usage from transcript fallback", async () => {
    await withTempHome(
      async (dir) => {
        const sessionId = "sess-stale-transcript-context";
        writeTranscriptUsageLog({
          dir,
          agentId: "main",
          sessionId,
          usage: {
            input: 3_800_000,
            output: 20_000,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3_820_000,
          },
        });

        const text = buildStatusMessage({
          agent: {
            model: "anthropic/claude-opus-4-6",
          },
          sessionEntry: {
            sessionId,
            updatedAt: 0,
            inputTokens: 3_800_000,
            outputTokens: 20_000,
            totalTokens: 3_800_000,
            totalTokensFresh: false,
            contextTokens: 1_000_000,
          },
          sessionKey: "agent:main:main",
          sessionScope: "per-sender",
          queue: { mode: "collect", depth: 0 },
          includeTranscriptUsage: true,
          modelAuth: "api-key",
        });
        const normalized = normalizeTestText(text);

        expect(normalized).toContain("Context: ?/1.0m");
        expect(normalized).not.toContain("Context: 3.8m/1.0m");
        expect(normalized).not.toContain("Context: 3.82m/1.0m");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("does not let legacy cumulative session totals override fresh transcript context usage", async () => {
    await withTempHome(
      async (dir) => {
        const sessionId = "sess-legacy-cumulative-context";
        writeTranscriptUsageLog({
          dir,
          agentId: "main",
          sessionId,
          usage: {
            input: 10_000,
            output: 1_000,
            cacheRead: 26_000,
            cacheWrite: 0,
            totalTokens: 36_000,
          },
        });

        const text = buildStatusMessage({
          agent: {
            model: "anthropic/claude-opus-4-6",
          },
          sessionEntry: {
            sessionId,
            updatedAt: 0,
            inputTokens: 16,
            outputTokens: 5_100,
            cacheRead: 2_300_000,
            cacheWrite: 11_000,
            totalTokens: 2_300_000,
            contextTokens: 1_000_000,
          },
          sessionKey: "agent:main:main",
          sessionScope: "per-sender",
          queue: { mode: "collect", depth: 0 },
          includeTranscriptUsage: true,
          modelAuth: "api-key",
        });
        const normalized = normalizeTestText(text);

        expect(normalized).toContain("Cache: 100% hit · 2.3m cached, 11k new");
        expect(normalized).toContain("Context: 36k/1.0m (4%)");
        expect(normalized).not.toContain("Context: 2.3m/1.0m");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("reads transcript usage using explicit agentId when sessionKey is missing", async () => {
    await withTempHome(
      async (dir) => {
        const sessionId = "sess-worker2";
        writeTranscriptUsageLog({
          dir,
          agentId: "worker2",
          sessionId,
          usage: {
            input: 2,
            output: 3,
            cacheRead: 1200,
            cacheWrite: 0,
            totalTokens: 1205,
          },
        });

        const text = buildStatusMessage({
          agent: {
            model: "anthropic/claude-opus-4-6",
          },
          agentId: "worker2",
          sessionEntry: {
            sessionId,
            updatedAt: 0,
            totalTokens: 5,
            contextTokens: 32_000,
          },
          // Intentionally omitted: sessionKey
          sessionScope: "per-sender",
          queue: { mode: "collect", depth: 0 },
          includeTranscriptUsage: true,
          modelAuth: "api-key",
        });

        expect(normalizeTestText(text)).toContain("Context: 1.2k/32k");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("uses the same transcript usage fallback as sessions.list when a delivery mirror is last", async () => {
    await withTempHome(
      async (dir) => {
        const sessionId = "sess-cache-delivery-mirror";
        writeBaselineTranscriptUsageLog({ dir, agentId: "main", sessionId });
        appendTranscriptMessageSync(
          {
            agentId: "main",
            sessionId,
            sessionKey: "agent:main:main",
            storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
          },
          {
            message: {
              role: "assistant",
              provider: "openclaw",
              model: "delivery-mirror",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
              },
            },
          },
        );

        const text = buildTranscriptStatusText({
          sessionId,
          sessionKey: "agent:main:main",
        });

        expect(normalizeTestText(text)).toContain("Cache: 100% hit · 1.0k cached, 0 new");
        expect(normalizeTestText(text)).toContain("Context: 1.0k/32k");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("preserves existing nonzero cache usage over transcript fallback values", async () => {
    await withTempHome(
      async (dir) => {
        const sessionId = "sess-cache-preserve";
        writeBaselineTranscriptUsageLog({
          dir,
          agentId: "main",
          sessionId,
        });

        const text = buildStatusMessage({
          agent: {
            model: "anthropic/claude-opus-4-6",
          },
          sessionEntry: {
            sessionId,
            updatedAt: 0,
            totalTokens: 3,
            contextTokens: 32_000,
            cacheRead: 12,
            cacheWrite: 34,
          },
          sessionKey: "agent:main:main",
          sessionScope: "per-sender",
          queue: { mode: "collect", depth: 0 },
          includeTranscriptUsage: true,
          modelAuth: "api-key",
        });

        expect(normalizeTestText(text)).toContain("Cache: 26% hit · 12 cached, 34 new");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("keeps transcript-derived slash model ids on model-only context lookup", async () => {
    await withTempHome(
      async (dir) => {
        getContextWindowCaches().discoveredTokenCache.set("google/gemini-2.5-pro", 999_000);

        const sessionId = "sess-openrouter-google";
        writeTranscriptUsageLog({
          dir,
          agentId: "main",
          sessionId,
          model: "google/gemini-2.5-pro",
          usage: {
            input: 2,
            output: 3,
            cacheRead: 1200,
            cacheWrite: 0,
            totalTokens: 1205,
          },
        });

        const text = buildStatusMessage({
          config: {
            models: {
              providers: {
                google: {
                  models: [{ id: "gemini-2.5-pro", contextWindow: 2_000_000 }],
                },
              },
            },
          } as unknown as OpenClawConfig,
          agent: {
            model: "openrouter/google/gemini-2.5-pro",
          },
          sessionEntry: {
            sessionId,
            updatedAt: 0,
            totalTokens: 5,
          },
          sessionKey: "agent:main:main",
          sessionScope: "per-sender",
          queue: { mode: "collect", depth: 0 },
          includeTranscriptUsage: true,
          modelAuth: "api-key",
        });

        const normalized = normalizeTestText(text);
        expect(normalized).toContain("Context: 1.2k/999k");
        expect(normalized).not.toContain("Context: 1.2k/2.0m");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("keeps runtime slash model ids on model-only context lookup when modelProvider is missing", () => {
    getContextWindowCaches().discoveredTokenCache.set("google/gemini-2.5-pro", 999_000);

    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            google: {
              models: [{ id: "gemini-2.5-pro", contextWindow: 2_000_000 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "openrouter/google/gemini-2.5-pro",
      },
      sessionEntry: {
        sessionId: "sess-runtime-slash-id",
        updatedAt: 0,
        totalTokens: 1205,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        model: "google/gemini-2.5-pro",
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 1.2k/999k");
    expect(normalized).not.toContain("Context: 1.2k/2.0m");
  });

  it("keeps provider-aware lookup for legacy fallback runtime slash ids", () => {
    getContextWindowCaches().discoveredTokenCache.clear();

    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            "fake-minimax": {
              models: [{ id: "FakeMiniMax-M2.5", contextWindow: 777_000 }],
            },
            xiaomi: {
              models: [{ id: "mimo-v2-flash", contextWindow: 1_048_576 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "xiaomi/mimo-v2-flash",
      },
      sessionEntry: {
        sessionId: "sess-runtime-slash-id-fallback",
        updatedAt: 0,
        providerOverride: "xiaomi",
        modelOverride: "mimo-v2-flash",
        model: "fake-minimax/FakeMiniMax-M2.5",
        fallbackNotice: {
          kind: "active",
          selectedModel: "xiaomi/mimo-v2-flash",
          activeModel: "fake-minimax/FakeMiniMax-M2.5",
          reason: "model not allowed",
        },
        totalTokens: 49_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      activeModelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: fake-minimax/FakeMiniMax-M2.5");
    expect(normalized).toContain("Context: 49k/777k");
    expect(normalized).not.toContain("Context: 49k/200k");
  });

  it("keeps provider-aware lookup for non-fallback runtime slash ids", () => {
    getContextWindowCaches().discoveredTokenCache.clear();

    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            openai: {
              models: [{ id: "gpt-4o", contextWindow: 777_000 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "openai/gpt-4o",
      },
      sessionEntry: {
        sessionId: "sess-runtime-slash-id-direct",
        updatedAt: 0,
        model: "openai/gpt-4o",
        totalTokens: 49_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      activeModelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 49k/777k");
    expect(normalized).not.toContain("Context: 49k/200k");
  });

  it("keeps provider-aware lookup for bare transcript model ids", async () => {
    await withTempHome(
      async (dir) => {
        getContextWindowCaches().discoveredTokenCache.set("gemini-2.5-pro", 128_000);
        getContextWindowCaches().discoveredTokenCache.set(
          providerContextTokenCacheKey("google-gemini-cli", "gemini-2.5-pro"),
          1_000_000,
        );

        const sessionId = "sess-google-bare-model";
        writeTranscriptUsageLog({
          dir,
          agentId: "main",
          sessionId,
          model: "gemini-2.5-pro",
          usage: {
            input: 2,
            output: 3,
            cacheRead: 1200,
            cacheWrite: 0,
            totalTokens: 1205,
          },
        });

        const text = buildStatusMessage({
          agent: {
            model: "google-gemini-cli/gemini-2.5-pro",
          },
          sessionEntry: {
            sessionId,
            updatedAt: 0,
            totalTokens: 5,
          },
          sessionKey: "agent:main:main",
          sessionScope: "per-sender",
          queue: { mode: "collect", depth: 0 },
          includeTranscriptUsage: true,
          modelAuth: "api-key",
        });

        const normalized = normalizeTestText(text);
        expect(normalized).toContain("Context: 1.2k/1.0m");
        expect(normalized).not.toContain("Context: 1.2k/128k");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("prefers provider-qualified context windows for fresh bare model ids", () => {
    getContextWindowCaches().discoveredTokenCache.set("claude-opus-4-6", 200_000);
    getContextWindowCaches().discoveredTokenCache.set(
      providerContextTokenCacheKey("anthropic", "claude-opus-4-6"),
      1_000_000,
    );

    const text = buildStatusMessage({
      agent: {
        model: "anthropic/claude-opus-4-6",
      },
      sessionEntry: {
        sessionId: "sess-anthropic-qualified-context",
        updatedAt: 0,
        totalTokens: 25_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 25k/1.0m");
    expect(normalized).not.toContain("Context: 25k/200k");
  });

  it("uses model discovery without inflating status above the model window", () => {
    getContextWindowCaches().discoveredTokenCache.set(
      providerContextTokenCacheKey("openai", "gpt-5.5"),
      272_000,
    );

    const text = buildStatusMessage({
      agent: {
        model: "openai/gpt-5.5",
      },
      sessionEntry: {
        sessionId: "sess-openai-chatgpt-cap-context",
        updatedAt: 0,
        totalTokens: 25_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "oauth",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 25k/272k");
    expect(normalized).not.toContain("Context: 25k/1.0m");
  });

  it("uses runtime context tokens to cap status when the sync cache is cold", () => {
    const text = buildStatusMessage({
      agent: {
        model: "openai/gpt-5.5",
      },
      runtimeContextTokens: 272_000,
      sessionEntry: {
        sessionId: "sess-openai-chatgpt-runtime-cap-context",
        updatedAt: 0,
        totalTokens: 25_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "oauth",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 25k/272k");
    expect(normalized).not.toContain("Context: 25k/1.0m");
  });
});

describe("buildCommandsMessage", () => {
  it("lists commands with aliases and hints", () => {
    const text = buildCommandsMessage({
      commands: { config: false, debug: false },
    } as unknown as OpenClawConfig);
    expect(text).toContain("ℹ️ Slash commands");
    expect(text).toContain("Status");
    expect(text).toContain("/commands - List all slash commands.");
    expect(text).toContain("/skill - Run a skill by name.");
    expect(text).toContain("/think (/thinking, /t) - Set thinking level.");
    expect(text).toContain("/compact - Compact the session context.");
    expect(text).toContain("/models - List model providers/models.");
    expect(text).not.toContain("/config");
    expect(text).not.toContain("/debug");
  });

  it("includes skill commands when provided", () => {
    const text = buildCommandsMessage(
      {
        commands: { config: false, debug: false },
      } as unknown as OpenClawConfig,
      [
        {
          name: "demo_skill",
          skillName: "demo-skill",
          description: "Demo skill",
        },
      ],
    );
    expect(text).toContain("/demo_skill - Demo skill");
  });
});

describe("buildHelpMessage", () => {
  it("hides config/debug when disabled", () => {
    const text = buildHelpMessage({
      commands: { config: false, debug: false },
    } as unknown as OpenClawConfig);
    expect(text).toContain("Skills");
    expect(text).toContain("/skill <name> [input]");
    expect(text).not.toContain("/config");
    expect(text).not.toContain("/debug");
  });

  it("includes /fast in help output", () => {
    expect(buildHelpMessage()).toContain("/fast status|auto|on|off|default");
  });

  it("includes raw trace mode in help output", () => {
    expect(buildHelpMessage()).toContain("/trace on|off|raw");
  });
});

describe("buildCommandsMessagePaginated", () => {
  it("formats telegram output with pages", () => {
    const result = buildCommandsMessagePaginated(
      {
        commands: { config: false, debug: false },
      } as unknown as OpenClawConfig,
      undefined,
      { surface: "telegram", page: 1, forcePaginatedList: true },
    );
    expect(result.text).toContain("ℹ️ Commands (1/");
    expect(result.text).toContain("Session");
    expect(result.text).toContain("/stop - Stop the current run.");
  });

  it("includes plugin commands in the paginated list", async () => {
    const pluginCommands = [
      { name: "plugin_cmd", description: "Plugin command", pluginId: "demo-plugin" },
    ];
    listPluginCommands.mockImplementation(() => pluginCommands);
    expect(listPluginCommands()).toEqual(pluginCommands);
    const firstPage = buildCommandsMessagePaginated(
      {
        commands: { config: false, debug: false },
      } as unknown as OpenClawConfig,
      undefined,
      { surface: "telegram", page: 1, forcePaginatedList: true },
    );
    const pages = Array.from({ length: firstPage.totalPages }, (_, index) =>
      buildCommandsMessagePaginated(
        {
          commands: { config: false, debug: false },
        } as unknown as OpenClawConfig,
        undefined,
        { surface: "telegram", page: index + 1, forcePaginatedList: true },
      ),
    );
    const pluginPage = pages.find((page) => page.text.includes("/plugin_cmd (demo-plugin)"));
    if (!pluginPage) {
      throw new Error("expected plugin command page");
    }
    expect(pluginPage.text).toContain("Plugins");
    expect(pluginPage.text).toContain("/plugin_cmd (demo-plugin) - Plugin command");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
