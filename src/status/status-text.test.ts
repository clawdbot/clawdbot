import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { appendSessionCostLine } from "./status-runtime-lines.js";
import { buildStatusText } from "./status-text.js";

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
}): Promise<string> {
  return await buildStatusText({
    cfg: params.cfg,
    sessionEntry: params.sessionEntry,
    sessionKey: "agent:main:main",
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

    expect(text).toContain("Think: high");
    expect(text).not.toMatch(/Think:\s*off\b/);
  });
});
