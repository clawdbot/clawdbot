import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskAuditFinding } from "../tasks/task-registry.audit.js";
import type { TaskRegistrySummary } from "../tasks/task-registry.types.js";

const statusSummaryMocks = vi.hoisted(() => ({
  hasConfiguredChannelsForReadOnlyScope: vi.fn(() => true),
  buildChannelSummary: vi.fn(async () => ["ok"]),
  readSessionStoreReadOnly: vi.fn(() => ({})),
  configureTaskRegistryMaintenance: vi.fn(),
  taskRegistrySummary: {
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
  } as TaskRegistrySummary,
  getInspectableTaskRegistrySummary: vi.fn(() => statusSummaryMocks.taskRegistrySummary),
  taskAuditFindings: [
    {
      severity: "warn",
      code: "delivery_failed",
      detail: "terminal update delivery failed",
      task: {
        taskId: "task-delivery",
        runtime: "subagent",
        ownerKey: "agent:main:main",
        requesterSessionKey: "agent:main:main",
        scopeKind: "session",
        task: "Deliver update",
        status: "failed",
        deliveryStatus: "failed",
        notifyPolicy: "done_only",
        createdAt: 1,
      },
    },
  ] as TaskAuditFinding[],
  getInspectableTaskAuditFindings: vi.fn(() => statusSummaryMocks.taskAuditFindings),
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
    resolveSessionRuntimeLabel: vi.fn(() => "OpenClaw Default"),
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
  configureTaskRegistryMaintenance: statusSummaryMocks.configureTaskRegistryMaintenance,
  getInspectableTaskRegistrySummary: statusSummaryMocks.getInspectableTaskRegistrySummary,
  getInspectableTaskAuditFindings: statusSummaryMocks.getInspectableTaskAuditFindings,
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
    statusSummaryMocks.taskRegistrySummary = {
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
    };
    statusSummaryMocks.taskAuditFindings = [
      {
        severity: "warn",
        code: "delivery_failed",
        detail: "terminal update delivery failed",
        task: {
          taskId: "task-delivery",
          runtime: "subagent",
          ownerKey: "agent:main:main",
          requesterSessionKey: "agent:main:main",
          scopeKind: "session",
          task: "Deliver update",
          status: "failed",
          deliveryStatus: "failed",
          notifyPolicy: "done_only",
          createdAt: 1,
        },
      },
    ];
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

  it("keeps retained lost tasks out of default status audit counts", async () => {
    const cleanupAfter = Date.now() + 60_000;
    statusSummaryMocks.taskRegistrySummary = {
      ...statusSummaryMocks.taskRegistrySummary,
      total: 1,
      terminal: 1,
      failures: 1,
      byStatus: {
        ...statusSummaryMocks.taskRegistrySummary.byStatus,
        lost: 1,
      },
    };
    statusSummaryMocks.taskAuditFindings = [
      {
        severity: "warn",
        code: "lost",
        detail: "task lost its backing session and is retained until cleanupAfter",
        task: {
          taskId: "task-lost-retained",
          runtime: "subagent",
          ownerKey: "agent:main:main",
          requesterSessionKey: "agent:main:main",
          scopeKind: "session",
          task: "Retained lost",
          status: "lost",
          deliveryStatus: "pending",
          notifyPolicy: "done_only",
          createdAt: cleanupAfter - 60_000,
          endedAt: cleanupAfter - 60_000,
          cleanupAfter,
        },
      },
    ];

    const summary = await getStatusSummary();

    expect(summary.tasks.failures).toBe(0);
    expect(summary.tasks.byStatus.lost).toBe(1);
    expect(summary.taskAudit).toEqual({
      total: 0,
      warnings: 0,
      errors: 0,
      byCode: {
        stale_queued: 0,
        stale_running: 0,
        lost: 0,
        delivery_failed: 0,
        missing_cleanup: 0,
        inconsistent_timestamps: 0,
      },
    });
    expect(summary.taskAuditRetainedLost).toEqual({
      count: 1,
      nextCleanupAfter: cleanupAfter,
    });
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

  it("hydrates only recent session rows while preserving total counts", async () => {
    const store = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => {
        const number = index + 1;
        return [
          `agent:main:session-${number}`,
          {
            sessionId: `session-${number}`,
            updatedAt: number,
          },
        ];
      }),
    );
    statusSummaryMocks.readSessionStoreReadOnly.mockReturnValue(store);

    const summary = await getStatusSummary();

    expect(summary.sessions.count).toBe(12);
    expect(summary.sessions.byAgent[0]?.count).toBe(12);
    expect(summary.sessions.recent.map((session) => session.key)).toEqual([
      "agent:main:session-12",
      "agent:main:session-11",
      "agent:main:session-10",
      "agent:main:session-9",
      "agent:main:session-8",
      "agent:main:session-7",
      "agent:main:session-6",
      "agent:main:session-5",
      "agent:main:session-4",
      "agent:main:session-3",
    ]);
    expect(summary.sessions.byAgent[0]?.recent.map((session) => session.key)).toEqual(
      summary.sessions.recent.map((session) => session.key),
    );

    const hydratedKeys = vi
      .mocked(statusSummaryRuntime.resolveSessionRuntimeLabel)
      .mock.calls.map(([params]) => params.sessionKey);
    expect(hydratedKeys).not.toContain("agent:main:session-1");
    expect(hydratedKeys).not.toContain("agent:main:session-2");
  });

  it("includes configured and selected model labels for pinned sessions", async () => {
    vi.mocked(statusSummaryRuntime.resolveConfiguredStatusModelRef).mockReturnValue({
      provider: "zhipu",
      model: "glm-4.5-air",
    });
    vi.mocked(statusSummaryRuntime.resolveSessionModelRef).mockReturnValue({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    statusSummaryMocks.readSessionStoreReadOnly.mockReturnValue({
      "agent:main:main": {
        sessionId: "session-1",
        updatedAt: Date.now(),
        providerOverride: "deepseek",
        modelOverride: "deepseek-v4-flash",
        modelOverrideSource: "user",
      },
    });

    const summary = await getStatusSummary();

    expect(summary.sessions.recent[0]?.configuredModel).toBe("zhipu/glm-4.5-air");
    expect(summary.sessions.recent[0]?.selectedModel).toBe("deepseek/deepseek-v4-flash");
    expect(summary.sessions.recent[0]?.modelSelectionReason).toBe("session override");
  });

  it("does not mark runtime-only model snapshots as pinned session selections", async () => {
    vi.mocked(statusSummaryRuntime.resolveConfiguredStatusModelRef).mockReturnValue({
      provider: "zhipu",
      model: "glm-4.5-air",
    });
    vi.mocked(statusSummaryRuntime.resolveSessionModelRef).mockReturnValue({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    statusSummaryMocks.readSessionStoreReadOnly.mockReturnValue({
      "agent:main:main": {
        sessionId: "session-1",
        updatedAt: Date.now(),
        modelProvider: "deepseek",
        model: "deepseek-v4-flash",
      },
    });

    const summary = await getStatusSummary();

    expect(summary.sessions.recent[0]?.configuredModel).toBe("zhipu/glm-4.5-air");
    expect(summary.sessions.recent[0]?.selectedModel).toBe("deepseek/deepseek-v4-flash");
    expect(summary.sessions.recent[0]?.modelSelectionReason).toBeNull();
  });

  it("does not mark auto fallback model overrides as pinned session selections", async () => {
    vi.mocked(statusSummaryRuntime.resolveConfiguredStatusModelRef).mockReturnValue({
      provider: "zhipu",
      model: "glm-4.5-air",
    });
    vi.mocked(statusSummaryRuntime.resolveSessionModelRef).mockReturnValue({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    statusSummaryMocks.readSessionStoreReadOnly.mockReturnValue({
      "agent:main:main": {
        sessionId: "session-1",
        updatedAt: Date.now(),
        providerOverride: "deepseek",
        modelOverride: "deepseek-v4-flash",
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "zhipu",
        modelOverrideFallbackOriginModel: "glm-4.5-air",
      },
    });

    const summary = await getStatusSummary();

    expect(summary.sessions.recent[0]?.configuredModel).toBe("zhipu/glm-4.5-air");
    expect(summary.sessions.recent[0]?.selectedModel).toBe("deepseek/deepseek-v4-flash");
    expect(summary.sessions.recent[0]?.modelSelectionReason).toBeNull();
  });

  it("does not mark runtime-equivalent provider aliases as pinned mismatches", async () => {
    vi.mocked(statusSummaryRuntime.resolveConfiguredStatusModelRef).mockReturnValue({
      provider: "openai",
      model: "gpt-5.5-codex",
    });
    vi.mocked(statusSummaryRuntime.resolveSessionModelRef).mockReturnValue({
      provider: "openai",
      model: "gpt-5.5-codex",
    });
    statusSummaryMocks.readSessionStoreReadOnly.mockReturnValue({
      "agent:main:main": {
        sessionId: "session-1",
        updatedAt: Date.now(),
        providerOverride: "openai",
        modelOverride: "gpt-5.5-codex",
        modelOverrideSource: "user",
      },
    });

    const summary = await getStatusSummary();

    expect(summary.sessions.recent[0]?.configuredModel).toBe("openai/gpt-5.5-codex");
    expect(summary.sessions.recent[0]?.selectedModel).toBe("openai/gpt-5.5-codex");
    expect(summary.sessions.recent[0]?.modelSelectionReason).toBeNull();
  });
});
