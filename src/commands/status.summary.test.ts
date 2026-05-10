import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const statusSummaryMocks = vi.hoisted(() => ({
  hasConfiguredChannelsForReadOnlyScope: vi.fn(() => true),
  buildChannelSummary: vi.fn(async () => ["ok"]),
  readSessionStoreReadOnly: vi.fn(() => ({})),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  hasConfiguredChannelsForReadOnlyScope: statusSummaryMocks.hasConfiguredChannelsForReadOnlyScope,
}));

vi.mock("./status.summary.runtime.js", () => ({
  statusSummaryRuntime: {
    classifySessionKey: vi.fn(() => "direct"),
    resolveConfiguredStatusModelRef: vi.fn(() => ({
      provider: "openai",
      model: "gpt-5.5",
    })),
    resolveSessionModelRef: vi.fn(() => ({
      provider: "openai",
      model: "gpt-5.5",
    })),
    resolveSessionRuntimeLabel: vi.fn(() => "OpenClaw Pi Default"),
    resolveContextTokensForModel: vi.fn(() => 200_000),
  },
}));

vi.mock("../agents/defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 200_000,
  DEFAULT_MODEL: "gpt-5.5",
  DEFAULT_PROVIDER: "openai",
}));

vi.mock("../config/io.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
}));

vi.mock("../config/sessions/paths.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
}));

vi.mock("../config/sessions/store-read.js", () => ({
  readSessionStoreReadOnly: statusSummaryMocks.readSessionStoreReadOnly,
}));

vi.mock("../gateway/agent-list.js", () => ({
  listGatewayAgentsBasic: vi.fn(() => ({
    defaultId: "main",
    agents: [{ id: "main" }],
  })),
}));

vi.mock("../infra/channel-summary.js", () => ({
  buildChannelSummary: statusSummaryMocks.buildChannelSummary,
}));

vi.mock("../infra/heartbeat-summary.js", () => ({
  resolveHeartbeatSummaryForAgent: vi.fn(() => ({
    enabled: true,
    every: "5m",
    everyMs: 300_000,
  })),
}));

vi.mock("../infra/system-events.js", () => ({
  peekSystemEvents: vi.fn(() => []),
}));

vi.mock("../tasks/task-registry.maintenance.js", () => ({
  configureTaskRegistryMaintenance: vi.fn(),
  getInspectableTaskRegistrySummary: vi.fn(() => ({
    total: 0,
    active: 0,
    terminal: 0,
    failures: 0,
    byStatus: {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      timed_out: 0,
      cancelled: 0,
      lost: 0,
    },
    byRuntime: {
      subagent: 0,
      acp: 0,
      cli: 0,
      cron: 0,
    },
  })),
  getInspectableTaskAuditSummary: vi.fn(() => ({
    total: 1,
    warnings: 1,
    errors: 0,
    byCode: {
      stale_queued: 0,
      stale_running: 0,
      lost: 0,
      delivery_failed: 1,
      missing_cleanup: 0,
      inconsistent_timestamps: 0,
    },
  })),
}));

vi.mock("../routing/session-key.js", () => ({
  normalizeAgentId: vi.fn((value: string) => value),
  normalizeMainKey: vi.fn((value?: string) => value ?? "main"),
  parseAgentSessionKey: vi.fn(() => null),
}));

vi.mock("../version.js", async () => {
  const actual = await vi.importActual<typeof import("../version.js")>("../version.js");
  return {
    ...actual,
    resolveRuntimeServiceVersion: vi.fn(() => "2026.3.8"),
  };
});

vi.mock("./status.link-channel.js", () => ({
  resolveLinkChannelContext: vi.fn(async () => undefined),
}));

const { buildChannelSummary } = await import("../infra/channel-summary.js");
const { resolveLinkChannelContext } = await import("./status.link-channel.js");
let getStatusSummary: typeof import("./status.summary.js").getStatusSummary;
let statusSummaryRuntime: typeof import("./status.summary.runtime.js").statusSummaryRuntime;

describe("getStatusSummary", () => {
  beforeAll(async () => {
    ({ getStatusSummary } = await import("./status.summary.js"));
    ({ statusSummaryRuntime } = await import("./status.summary.runtime.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    statusSummaryMocks.hasConfiguredChannelsForReadOnlyScope.mockReturnValue(true);
    statusSummaryMocks.buildChannelSummary.mockResolvedValue(["ok"]);
    statusSummaryMocks.readSessionStoreReadOnly.mockReturnValue({});
  });

  it("includes runtimeVersion in the status payload", async () => {
    const summary = await getStatusSummary();

    expect(summary.runtimeVersion).toBe("2026.3.8");
    expect(summary.heartbeat.defaultAgentId).toBe("main");
    expect(summary.channelSummary).toEqual(["ok"]);
    expect(summary.tasks.active).toBe(0);
    expect(summary.taskAudit.warnings).toBe(1);
  });

  it("skips channel summary imports when no channels are configured", async () => {
    statusSummaryMocks.hasConfiguredChannelsForReadOnlyScope.mockReturnValue(false);

    const summary = await getStatusSummary();

    expect(summary.channelSummary).toStrictEqual([]);
    expect(summary.linkChannel).toBeUndefined();
    expect(statusSummaryMocks.hasConfiguredChannelsForReadOnlyScope).toHaveBeenCalledWith({
      config: {},
    });
    expect(buildChannelSummary).not.toHaveBeenCalled();
    expect(resolveLinkChannelContext).not.toHaveBeenCalled();
  });

  it("skips channel summary imports when explicitly disabled", async () => {
    const summary = await getStatusSummary({ includeChannelSummary: false });

    expect(summary.channelSummary).toStrictEqual([]);
    expect(summary.linkChannel).toBeUndefined();
    expect(statusSummaryMocks.hasConfiguredChannelsForReadOnlyScope).not.toHaveBeenCalled();
    expect(buildChannelSummary).not.toHaveBeenCalled();
    expect(resolveLinkChannelContext).not.toHaveBeenCalled();
  });

  it("does not trigger async context warmup while building status summaries", async () => {
    await getStatusSummary();

    const contextCall = vi.mocked(statusSummaryRuntime.resolveContextTokensForModel).mock
      .calls[0]?.[0];
    expect(contextCall?.allowAsyncLoad).toBe(false);
  });

  it("includes the selected agent runtime on recent sessions", async () => {
    vi.mocked(statusSummaryRuntime.resolveSessionRuntimeLabel).mockReturnValue("OpenAI Codex");
    statusSummaryMocks.readSessionStoreReadOnly.mockReturnValue({
      "agent:main:main": {
        sessionId: "session-1",
        updatedAt: Date.now(),
      },
    });

    const summary = await getStatusSummary();

    expect(summary.sessions.recent[0]?.runtime).toBe("OpenAI Codex");
  });
});
