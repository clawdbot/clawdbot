import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { appendSessionCostLine } from "./status-runtime-lines.js";
import { buildStatusReplyParts, buildStatusText } from "./status-text.js";

const mocks = vi.hoisted(() => ({
  loadSessionCostSummariesFromCache: vi.fn(),
  loadProviderUsageSummary: vi.fn(),
}));

vi.mock("../infra/session-cost-usage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/session-cost-usage.js")>();
  return {
    ...actual,
    loadSessionCostSummariesFromCache: mocks.loadSessionCostSummariesFromCache,
  };
});

vi.mock("../infra/provider-usage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/provider-usage.js")>();
  return {
    ...actual,
    loadProviderUsageSummary: mocks.loadProviderUsageSummary,
  };
});

type StatusTextParams = Parameters<typeof buildStatusText>[0];

async function renderTelegramStatus(params: {
  cfg: StatusTextParams["cfg"];
  sessionEntry: NonNullable<StatusTextParams["sessionEntry"]>;
  statusAccountId?: string;
  sessionKey?: string;
  agentId?: string;
}): Promise<string> {
  return await buildStatusText({
    cfg: params.cfg,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey ?? "agent:main:main",
    ...(params.agentId ? { agentId: params.agentId } : {}),
    statusChannel: "telegram",
    ...(params.statusAccountId ? { statusAccountId: params.statusAccountId } : {}),
    provider: "openai",
    model: "gpt-5.4-mini",
    resolvedHarness: "pi",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
    defaultGroupActivation: () => "mention",
    pluginHealthLineOverride: "Plugins: test",
    taskLineOverride: "",
    skipDefaultTaskLookup: true,
    primaryModelLabelOverride: "openai/gpt-5.4-mini",
    modelAuthOverride: "test",
    activeModelAuthOverride: "test",
    includeTranscriptUsage: false,
  });
}

describe("buildStatusText channel features", () => {
  it.each([
    { richMessages: undefined, expected: "Telegram rich messages: off" },
    { richMessages: false, expected: "Telegram rich messages: off" },
    { richMessages: true, expected: "Telegram rich messages: on" },
  ])("shows Telegram rich message state for %s", async ({ richMessages, expected }) => {
    const telegram = richMessages === undefined ? {} : { richMessages };
    const text = await renderTelegramStatus({
      cfg: { channels: { telegram } },
      sessionEntry: { sessionId: `telegram-rich-${String(richMessages)}`, updatedAt: 0 },
    });

    expect(text).toContain(expected);
    if (richMessages === true) {
      expect(text).toContain("sendRichMessage enabled");
    } else {
      expect(text).toContain("channels.telegram.richMessages=true");
    }
  });

  it("uses Telegram account rich message overrides", async () => {
    const text = await renderTelegramStatus({
      cfg: {
        channels: {
          telegram: {
            richMessages: true,
            accounts: { Work: { richMessages: false } },
          },
        },
      },
      sessionEntry: {
        sessionId: "telegram-rich-account",
        updatedAt: 0,
        delivery: normalizeSessionDeliveryState({
          context: { channel: "telegram", accountId: "work" },
        }),
      },
    });

    expect(text).toContain("Telegram rich messages: off");
    expect(text).toContain("enable richMessages for this Telegram account");
  });

  it("uses the current Telegram command account before the session records it", async () => {
    const text = await renderTelegramStatus({
      cfg: {
        channels: {
          telegram: {
            richMessages: true,
            accounts: { Work: { richMessages: false } },
          },
        },
      },
      sessionEntry: {
        sessionId: "telegram-rich-command-account",
        updatedAt: 0,
      },
      statusAccountId: "work",
    });

    expect(text).toContain("Telegram rich messages: off");
    expect(text).toContain("enable richMessages for this Telegram account");
  });
});

describe("buildStatusText global subagent scope", () => {
  beforeEach(() => resetSubagentRegistryForTests({ persist: false }));
  afterEach(() => resetSubagentRegistryForTests({ persist: false }));

  it.each(["research", "ops"])(
    "shows the selected global agent's children when the default is %s",
    async (defaultAgentId) => {
      for (const agentId of ["research", "ops"]) {
        addSubagentRunForTests({
          runId: `status-global-${agentId}`,
          childSessionKey: `agent:${agentId}:subagent:status-worker`,
          controllerSessionKey: "global",
          requesterSessionKey: "global",
          requesterAgentId: agentId,
          requesterDisplayKey: "global",
          task: `${agentId} status worker`,
          cleanup: "keep",
          createdAt: Date.now() - 1_000,
          startedAt: Date.now() - 1_000,
        });
      }

      const text = await renderTelegramStatus({
        cfg: {
          agents: {
            entries: {
              research: { default: defaultAgentId === "research" },
              ops: { default: defaultAgentId === "ops" },
            },
          },
          session: { scope: "global" },
        },
        sessionEntry: { sessionId: "global-status", updatedAt: 0 },
        sessionKey: "global",
        agentId: "research",
      });

      expect(text).toContain("🤖 Subagents: 1 active");
      expect(text).toContain("research status worker");
      expect(text).not.toContain("ops status worker");
    },
  );
});

describe("Codex usage after runtime fallback", () => {
  beforeEach(() => {
    mocks.loadProviderUsageSummary.mockReset();
    mocks.loadProviderUsageSummary.mockImplementation(async (params) => ({
      updatedAt: Date.now(),
      providers: params.auth
        ? [
            {
              provider: "openai",
              displayName: "Codex",
              windows: [{ label: "5h", usedPercent: 25 }],
            },
          ]
        : [],
    }));
  });

  async function renderFallbackStatus(agentHarnessId: "codex" | "openclaw"): Promise<string> {
    return await buildStatusText({
      cfg: {},
      sessionEntry: {
        sessionId: `fallback-${agentHarnessId}`,
        updatedAt: 0,
        agentRuntimeOverride: "openclaw",
        agentHarnessId,
      },
      sessionKey: "agent:main:main",
      statusChannel: "mobilechat",
      provider: "openai",
      model: "gpt-5.4-mini",
      resolvedHarness: "openclaw",
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      pluginHealthLineOverride: "Plugins: test",
      taskLineOverride: "",
      skipDefaultTaskLookup: true,
      primaryModelLabelOverride: "openai/gpt-5.4-mini",
      modelAuthOverride: "oauth",
      activeModelAuthOverride: "oauth",
      includeTranscriptUsage: false,
    });
  }

  it("shows Codex rate-limit usage for a Codex-bound session on OpenClaw Default", async () => {
    const text = await renderFallbackStatus("codex");

    expect(text).toContain("📊 Usage: 5h 75% left");
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: ["openai"],
        auth: [expect.objectContaining({ provider: "openai", hookProvider: "codex" })],
      }),
    );
  });

  it("omits Codex rate-limit usage for a never-Codex session", async () => {
    const text = await renderFallbackStatus("openclaw");

    expect(text).not.toContain("📊 Usage:");
    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.not.objectContaining({ auth: expect.anything() }),
    );
  });
});

describe("session status cost line", () => {
  const sessionEntry = {
    sessionId: "cost-session",
    updatedAt: 0,
    sessionFile: formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId: "cost-session",
      storePath: "/tmp/openclaw-status-cost/sessions.json",
    }),
  };

  beforeEach(() => {
    mocks.loadSessionCostSummariesFromCache.mockReset();
  });

  it("shows cached current-session cost and tokens", async () => {
    mocks.loadSessionCostSummariesFromCache.mockResolvedValue({
      cacheStatus: {
        status: "fresh" as const,
        cachedFiles: 1,
        pendingFiles: 0,
        staleFiles: 0,
      },
      summaries: [
        {
          input: 400_000,
          output: 56_000,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 456_000,
          totalCost: 1.23,
          inputCost: 1,
          outputCost: 0.23,
          cacheReadCost: 0,
          cacheWriteCost: 0,
          missingCostEntries: 0,
        },
      ],
    });

    await expect(appendSessionCostLine(null, {}, "main", sessionEntry)).resolves.toBe(
      "💵 $1.23 · 456k tok (today)",
    );
  });

  it("omits a cold cost cache", async () => {
    mocks.loadSessionCostSummariesFromCache.mockResolvedValue({
      cacheStatus: {
        status: "partial",
        cachedFiles: 0,
        pendingFiles: 1,
        staleFiles: 0,
      },
      summaries: [null],
    });

    await expect(appendSessionCostLine(null, {}, "main", sessionEntry)).resolves.toBeNull();
  });

  it("omits a stale cached summary", async () => {
    mocks.loadSessionCostSummariesFromCache.mockResolvedValue({
      cacheStatus: {
        status: "stale",
        cachedFiles: 0,
        pendingFiles: 1,
        staleFiles: 1,
      },
      summaries: [
        {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          totalCost: 1,
          inputCost: 1,
          outputCost: 0,
          cacheReadCost: 0,
          cacheWriteCost: 0,
          missingCostEntries: 0,
        },
      ],
    });

    await expect(appendSessionCostLine(null, {}, "main", sessionEntry)).resolves.toBeNull();
  });

  it("marks incomplete pricing", async () => {
    mocks.loadSessionCostSummariesFromCache.mockResolvedValue({
      cacheStatus: {
        status: "fresh",
        cachedFiles: 1,
        pendingFiles: 0,
        staleFiles: 0,
      },
      summaries: [
        {
          input: 400_000,
          output: 56_000,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 456_000,
          totalCost: 1.23,
          inputCost: 1,
          outputCost: 0.23,
          cacheReadCost: 0,
          cacheWriteCost: 0,
          missingCostEntries: 12,
          missingCostByModel: {
            "openai/gpt-5.6-sol": 10,
            "openai-codex/gpt-5.5": 2,
          },
        },
      ],
    });

    await expect(appendSessionCostLine(null, {}, "main", sessionEntry)).resolves.toBe(
      "💵 missing cost: 12 (openai/gpt-5.6-sol 10, openai-codex/gpt-5.5 2) · 456k tok (today)",
    );
  });
});

describe("buildStatusText thinking facts", () => {
  it("keeps the prepared thinking level for a discovered Ollama reasoning model", async () => {
    const text = await buildStatusText({
      cfg: {},
      sessionEntry: {
        sessionId: "wa-ollama-think",
        updatedAt: 0,
        thinkingLevel: "high",
        modelOverride: "glm-5.2:cloud",
        providerOverride: "ollama",
      },
      sessionKey: "agent:main:main",
      statusChannel: "whatsapp",
      provider: "ollama",
      model: "glm-5.2:cloud",
      thinkingCatalog: [
        {
          provider: "ollama",
          id: "glm-5.2:cloud",
          reasoning: true,
        },
      ],
      resolvedHarness: "openclaw",
      resolvedThinkLevel: "high",
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "on",
      resolveDefaultThinkingLevel: async () => "high",
      isGroup: false,
      defaultGroupActivation: () => "mention",
      pluginHealthLineOverride: "Plugins: test",
      taskLineOverride: "",
      skipDefaultTaskLookup: true,
      primaryModelLabelOverride: "ollama/glm-5.2:cloud",
      modelAuthOverride: "local",
      activeModelAuthOverride: "local",
      includeTranscriptUsage: false,
    });

    expect(text).toContain("think high");
    expect(text).not.toMatch(/think\s+off\b/);
  });
});

describe("buildStatusText prepared context windows", () => {
  const catalog = [
    {
      provider: "deepseek",
      id: "deepseek-v4-flash",
      contextWindow: 1_000_000,
      contextTokens: 1_000_000,
    },
    {
      provider: "fallback",
      id: "small-model",
      contextWindow: 128_000,
      contextTokens: 128_000,
    },
    {
      provider: "openrouter",
      id: "deepseek/deepseek-v4-flash",
      contextWindow: 1_000_000,
      contextTokens: 1_000_000,
    },
  ];

  async function renderPreparedStatus(
    overrides: Partial<Parameters<typeof buildStatusReplyParts>[0]> = {},
  ) {
    return await buildStatusReplyParts({
      cfg: {},
      sessionEntry: {
        sessionId: "prepared-context",
        updatedAt: 0,
        totalTokens: 45_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
      sessionKey: "agent:main:main",
      statusChannel: "mobilechat",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinkingCatalog: catalog,
      resolvedHarness: "openclaw",
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      pluginHealthLineOverride: "Plugins: test",
      taskLineOverride: "",
      skipDefaultTaskLookup: true,
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
      includeTranscriptUsage: false,
      ...overrides,
    });
  }

  it("renders a cold-cache prepared window in plain and rich status", async () => {
    const parts = await renderPreparedStatus();
    const table = parts.presentation.blocks.find((block) => block.type === "table");

    expect(parts.text).toContain("Context: 45k/1.0m");
    expect(parts.text).not.toContain("Context: 45k/200k");
    expect(table?.type === "table" ? table.rows : []).toContainEqual([
      "📚 Context",
      expect.stringContaining("45k/1.0m"),
    ]);
  });

  it("keeps the selected prepared window over stale active model state", async () => {
    const parts = await renderPreparedStatus({
      sessionEntry: {
        sessionId: "selected-prepared-context",
        updatedAt: 0,
        providerOverride: "deepseek",
        modelOverride: "deepseek-v4-flash",
        modelOverrideSource: "user",
        modelProvider: "fallback",
        model: "small-model",
        totalTokens: 45_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
    });

    expect(parts.text).toContain("Context: 45k/1.0m");
    expect(parts.text).not.toContain("Context: 45k/128k");
  });

  it("uses the active prepared window for an established fallback", async () => {
    const parts = await renderPreparedStatus({
      sessionEntry: {
        sessionId: "active-prepared-context",
        updatedAt: 0,
        providerOverride: "deepseek",
        modelOverride: "deepseek-v4-flash",
        modelProvider: "fallback",
        model: "small-model",
        fallbackNotice: {
          kind: "active",
          selectedModel: "deepseek/deepseek-v4-flash",
          activeModel: "fallback/small-model",
          reason: "provider unavailable",
        },
        totalTokens: 45_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
    });

    expect(parts.text).toContain("Context: 45k/128k");
    expect(parts.text).not.toContain("Context: 45k/1.0m");
  });

  it("keeps Anthropic authored caps below the prepared Claude CLI window", async () => {
    const parts = await renderPreparedStatus({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      resolvedHarness: "claude-cli",
      sessionEntry: {
        sessionId: "claude-cli-authored-cap",
        updatedAt: 0,
        modelProvider: "claude-cli",
        model: "claude-haiku-4-5",
        agentHarnessId: "claude-cli",
        contextTokens: 256_000,
        contextTokensSource: "resolved",
        totalTokens: 45_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
      thinkingCatalog: [
        {
          provider: "anthropic",
          id: "claude-haiku-4-5",
          contextWindow: 1_000_000,
          contextTokens: 1_000_000,
        },
      ],
      cfg: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.test",
              models: [
                {
                  id: "claude-haiku-4-5",
                  name: "Claude Haiku 4.5",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_000_000,
                  contextTokens: 256_000,
                  maxTokens: 128_000,
                },
              ],
            },
          },
        },
      },
    });

    expect(parts.text).toContain("Context: 45k/256k");
    expect(parts.text).not.toContain("Context: 45k/1.0m");
  });

  it("matches namespaced prepared model IDs without stripping them", async () => {
    const parts = await renderPreparedStatus({
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      thinkingCatalog: [
        ...catalog,
        {
          provider: "openrouter",
          id: "deepseek-v4-flash",
          reasoning: false,
          input: ["text"],
          contextWindow: 128_000,
          contextTokens: 128_000,
        },
      ],
    });

    expect(parts.text).toContain("Context: 45k/1.0m");
    expect(parts.text).not.toContain("Context: 45k/128k");
  });
});

describe("buildStatusText lazy loader retry", () => {
  afterEach(() => {
    vi.doUnmock("./status-plugin-health.runtime.js");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function retryStatusParams(sessionId: string): Parameters<typeof buildStatusText>[0] {
    return {
      cfg: {},
      sessionEntry: { sessionId, updatedAt: 0 },
      sessionKey: "agent:main:main",
      statusChannel: "mobilechat",
      provider: "openai",
      model: "gpt-5.4-mini",
      resolvedHarness: "openclaw",
      resolvedVerboseLevel: "off",
      resolvedReasoningLevel: "off",
      resolveDefaultThinkingLevel: async () => undefined,
      isGroup: false,
      defaultGroupActivation: () => "mention",
      taskLineOverride: "",
      skipDefaultTaskLookup: true,
      primaryModelLabelOverride: "openai/gpt-5.4-mini",
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
      includeTranscriptUsage: false,
    };
  }

  it("falls back on import failure and retries in the same module instance", async () => {
    vi.doMock("./status-plugin-health.runtime.js", async () => {
      throw new Error("Module load failure");
    });
    vi.resetModules();

    const { buildStatusText: firstLoadBuildStatusText } = await import("./status-text.js");
    const failed = await firstLoadBuildStatusText(retryStatusParams("retry-failure"));
    expect(failed).toContain("Plugins: health unavailable");

    vi.doMock("./status-plugin-health.runtime.js", () => ({
      collectRuntimePluginHealthSnapshot: () => ({
        plugins: [],
        diagnostics: [],
        contextEngineQuarantines: [],
        runtimeToolQuarantines: [],
        channelPluginFailures: [],
      }),
    }));

    const recovered = await firstLoadBuildStatusText(retryStatusParams("retry-recovery"));
    expect(recovered).not.toContain("Plugins: health unavailable");
  });
});
