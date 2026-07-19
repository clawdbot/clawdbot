// Status summary tests cover aggregate status text for channels, sessions, tasks, and audit findings.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveDegradedPlugins } from "../plugins/runtime-degraded-state.js";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";
import type { TaskAuditFinding } from "../tasks/task-registry.audit.js";
import type { TaskRecord, TaskRegistrySummary } from "../tasks/task-registry.types.js";

const statusSummaryMocks = vi.hoisted(() => ({
  hasConfiguredChannelsForReadOnlyScope: vi.fn(() => true),
  buildChannelSummary: vi.fn(async () => ["ok"]),
  resolveProviderStaticModel: vi.fn(),
  listSessionEntries: vi.fn<
    (scope?: { agentId?: string; storePath?: string }) => Array<{
      sessionKey: string;
      entry: Record<string, unknown>;
    }>
  >(() => []),
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
  inspectableTasks: [] as TaskRecord[],
  reconcileInspectableTasks: vi.fn(() => statusSummaryMocks.inspectableTasks),
  getInspectableTaskRegistrySummary: vi.fn(
    (_tasks?: TaskRecord[]) => statusSummaryMocks.taskRegistrySummary,
  ),
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
  getInspectableTaskAuditFindings: vi.fn(
    (_tasks?: TaskRecord[]) => statusSummaryMocks.taskAuditFindings,
  ),
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
    resolveStatusModelLookupRef: vi.fn(({ provider, model }) =>
      typeof model === "string" && model.length > 0
        ? {
            provider: typeof provider === "string" && provider.length > 0 ? provider : "openai",
            model,
          }
        : null,
    ),
    resolveStatusModelComparisonLabel: vi.fn(({ provider, model }) =>
      typeof model === "string" && model.length > 0
        ? `${typeof provider === "string" && provider.length > 0 ? provider : "openai"}/${model}`
        : null,
    ),
    resolveContextTokensForModel: vi.fn(() => 200_000),
    waitForContextWindowCacheLoad: vi.fn(async () => "idle" as const),
  },
}));

vi.mock("../agents/defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 200_000,
  DEFAULT_MODEL: "gpt-5.5",
  DEFAULT_PROVIDER: "openai",
}));

vi.mock("../agents/embedded-agent-runner/model.static-catalog.js", () => ({
  createBundledStaticCatalogModelResolver: vi.fn(() =>
    vi.fn(({ provider, modelId }) =>
      provider === "openai" && modelId === "gpt-5.5"
        ? { contextWindow: 1_000_000, contextTokens: 272_000 }
        : undefined,
    ),
  ),
  createBundledProviderStaticCatalogModelResolver: vi.fn(
    () => statusSummaryMocks.resolveProviderStaticModel,
  ),
  createBundledProviderStaticCatalogContextResolver: vi.fn(
    () => statusSummaryMocks.resolveProviderStaticModel,
  ),
}));

vi.mock("../config/io.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: vi.fn(() => ({})),
  projectConfigOntoRuntimeSourceSnapshot: vi.fn((config) => config),
}));

vi.mock("../config/sessions/paths.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
}));

vi.mock("../config/sessions/session-accessor.js", () => ({
  listSessionEntries: statusSummaryMocks.listSessionEntries,
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
  reconcileInspectableTasks: statusSummaryMocks.reconcileInspectableTasks,
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
const { resolveStorePath } = await import("../config/sessions/paths.js");
const { listGatewayAgentsBasic } = await import("../gateway/agent-list.js");
const { resolveLinkChannelContext } = await import("./status.link-channel.js");
let getStatusSummary: typeof import("./status.summary.js").getStatusSummary;
let statusSummaryRuntime: typeof import("./status.summary.runtime.js").statusSummaryRuntime;

function toSessionEntrySummaries(store: Record<string, Record<string, unknown>>) {
  return Object.entries(store).map(([sessionKey, entry]) => ({ sessionKey, entry }));
}

describe("getStatusSummary", () => {
  beforeAll(async () => {
    ({ getStatusSummary } = await import("./status.summary.js"));
    ({ statusSummaryRuntime } = await import("./status.summary.runtime.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setActiveDegradedPlugins([]);
    setActiveDegradedSecretOwners([]);
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
    statusSummaryMocks.inspectableTasks = [];
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
    statusSummaryMocks.resolveProviderStaticModel.mockReset();
    statusSummaryMocks.resolveProviderStaticModel.mockImplementation(
      async ({ provider, modelId }) =>
        provider === "google" && modelId === "gemini-3.1-pro-preview"
          ? { contextWindow: 1_048_576 }
          : undefined,
    );
    statusSummaryMocks.listSessionEntries.mockReturnValue([]);
    vi.mocked(resolveStorePath).mockReturnValue("/tmp/sessions.json");
    vi.mocked(listGatewayAgentsBasic).mockReturnValue({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }],
    });
  });

  it("includes runtimeVersion in the status payload", async () => {
    const summary = await getStatusSummary();

    expect(summary.runtimeVersion).toBe("2026.3.8");
    expect(summary.heartbeat.defaultAgentId).toBe("main");
    expect(summary.channelSummary).toEqual(["ok"]);
    expect(summary.tasks.active).toBe(0);
    expect(summary.taskAudit.warnings).toBe(1);
  });

  it("reports degraded SecretRef owners without exposing ref identifiers", async () => {
    setActiveDegradedSecretOwners([
      {
        ownerKind: "account",
        ownerId: "discord:ops",
        state: "unavailable",
        degradationState: "cold",
        paths: ["channels.discord.accounts.ops.token"],
        refKeys: ["env:default:PRIVATE_REF_ID"],
        reason: "provider SecretRef is unresolved (env:default:PRIVATE_REF_ID)",
      },
    ]);

    const summary = await getStatusSummary();

    expect(summary.degradedSecretOwners).toEqual([
      {
        ownerKind: "account",
        ownerId: "discord:ops",
        state: "unavailable",
        degradationState: "cold",
        paths: ["channels.discord.accounts.ops.token"],
        reason: "secret resolution failed",
      },
    ]);
    expect(JSON.stringify(summary.degradedSecretOwners)).not.toContain("PRIVATE_REF_ID");
  });

  it("reports every plugin configured unavailable by startup verification", async () => {
    setActiveDegradedPlugins([
      {
        pluginId: "discord",
        state: "configured-unavailable",
        diagnostic: {
          kind: "plugin-verification",
          reason: "unreadable-package-json",
          detail: "Could not read /private/plugins/discord/package.json: permission denied",
          installPath: "/private/plugins/discord",
        },
      },
      {
        pluginId: "matrix",
        state: "configured-unavailable",
        diagnostic: {
          kind: "plugin-verification",
          reason: "missing-main-entry",
          detail: "dist/index.js is missing",
        },
      },
      {
        pluginId: "peer-plugin",
        state: "configured-unavailable",
        diagnostic: {
          kind: "plugin-verification",
          reason: "missing-openclaw-peer-link",
          detail:
            "/private/plugins/peer-plugin/node_modules/openclaw points to /private/other/openclaw instead of /private/host/openclaw",
          installPath: "/private/plugins/peer-plugin",
        },
      },
    ]);

    const summary = await getStatusSummary();

    expect(summary.degradedPlugins).toEqual([
      {
        pluginId: "discord",
        state: "configured-unavailable",
        diagnostic: {
          kind: "plugin-verification",
          reason: "unreadable-package-json",
          detail: "Could not read <plugin-install>/package.json: permission denied",
        },
      },
      {
        pluginId: "matrix",
        state: "configured-unavailable",
        diagnostic: {
          kind: "plugin-verification",
          reason: "missing-main-entry",
          detail: "dist/index.js is missing",
        },
      },
      {
        pluginId: "peer-plugin",
        state: "configured-unavailable",
        diagnostic: {
          kind: "plugin-verification",
          reason: "missing-openclaw-peer-link",
          detail:
            'Plugin declares peerDependency "openclaw", but its host peer link is missing or invalid.',
        },
      },
    ]);
    expect(JSON.stringify(summary.degradedPlugins)).not.toContain("/private/plugins");
    expect(JSON.stringify(summary.degradedPlugins)).not.toContain("/private/host");
  });

  it("reuses one reconciled task snapshot for task summaries and audit findings", async () => {
    const inspectableTasks: TaskRecord[] = [];
    statusSummaryMocks.inspectableTasks = inspectableTasks;

    await getStatusSummary();

    expect(statusSummaryMocks.reconcileInspectableTasks).toHaveBeenCalledTimes(1);
    expect(statusSummaryMocks.getInspectableTaskRegistrySummary).toHaveBeenCalledWith(
      inspectableTasks,
    );
    expect(statusSummaryMocks.getInspectableTaskAuditFindings).toHaveBeenCalledWith(
      inspectableTasks,
    );
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

    expect(statusSummaryRuntime.waitForContextWindowCacheLoad).toHaveBeenCalledTimes(1);
    const contextCall = vi.mocked(statusSummaryRuntime.resolveContextTokensForModel).mock
      .calls[0]?.[0];
    expect(contextCall?.allowAsyncLoad).toBe(false);
    expect(contextCall).toMatchObject({
      modelContextWindow: 1_000_000,
      modelContextTokens: 272_000,
    });
  });

  it("does not pass stale session contextTokens as status row overrides", async () => {
    statusSummaryMocks.listSessionEntries.mockReturnValue(
      toSessionEntrySummaries({
        "agent:main:main": {
          sessionId: "stale-context",
          updatedAt: Date.now(),
          modelProvider: "openai",
          model: "gpt-5.4",
          contextTokens: 1_000_000,
        },
      }),
    );

    await getStatusSummary();

    expect(
      vi
        .mocked(statusSummaryRuntime.resolveContextTokensForModel)
        .mock.calls.some((call) => call[0]?.contextTokensOverride === 1_000_000),
    ).toBe(false);
  });

  it("uses bundled provider static catalogs for cold status context", async () => {
    vi.mocked(statusSummaryRuntime.resolveConfiguredStatusModelRef).mockReturnValue({
      provider: "google",
      model: "gemini-3.1-pro-preview",
    });

    await getStatusSummary();

    expect(
      vi.mocked(statusSummaryRuntime.resolveContextTokensForModel).mock.calls[0]?.[0],
    ).toMatchObject({
      provider: "google",
      model: "gemini-3.1-pro-preview",
      modelContextWindow: 1_048_576,
      allowAsyncLoad: false,
    });
  });

  it("uses context-only static metadata for nested provider-owned model refs", async () => {
    vi.mocked(statusSummaryRuntime.resolveConfiguredStatusModelRef).mockReturnValue({
      provider: "google-gemini-cli",
      model: "google/gemini-3.1-pro-preview",
    });
    statusSummaryMocks.resolveProviderStaticModel.mockResolvedValueOnce({
      contextWindow: 1_048_576,
    });

    await getStatusSummary();

    expect(statusSummaryMocks.resolveProviderStaticModel).toHaveBeenCalledWith({
      provider: "google-gemini-cli",
      modelId: "google/gemini-3.1-pro-preview",
    });
    expect(
      vi.mocked(statusSummaryRuntime.resolveContextTokensForModel).mock.calls[0]?.[0],
    ).toMatchObject({
      provider: "google-gemini-cli",
      model: "google/gemini-3.1-pro-preview",
      modelContextWindow: 1_048_576,
      allowAsyncLoad: false,
    });
  });

  it("keeps status available when static catalog lookup fails", async () => {
    vi.mocked(statusSummaryRuntime.resolveConfiguredStatusModelRef).mockReturnValue({
      provider: "broken-provider",
      model: "broken-model",
    });
    statusSummaryMocks.resolveProviderStaticModel.mockRejectedValueOnce(
      new Error("static catalog unavailable"),
    );

    await expect(getStatusSummary()).resolves.toMatchObject({
      sessions: {
        defaults: {
          model: "broken-model",
          contextTokens: 200_000,
        },
      },
    });
  });

  it("includes the selected agent runtime on recent sessions", async () => {
    vi.mocked(statusSummaryRuntime.resolveSessionRuntimeLabel).mockReturnValue("OpenAI Codex");
    statusSummaryMocks.listSessionEntries.mockReturnValue(
      toSessionEntrySummaries({
        "agent:main:main": {
          sessionId: "session-1",
          updatedAt: Date.now(),
        },
      }),
    );

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
    statusSummaryMocks.listSessionEntries.mockReturnValue(toSessionEntrySummaries(store));

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

  it("preserves store order for tied recent session timestamps", async () => {
    const store = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => {
        const number = index + 1;
        return [
          `agent:main:session-${number}`,
          {
            sessionId: `session-${number}`,
            updatedAt: 1,
          },
        ];
      }),
    );
    statusSummaryMocks.listSessionEntries.mockReturnValue(toSessionEntrySummaries(store));

    const summary = await getStatusSummary();

    expect(summary.sessions.recent.map((session) => session.key)).toEqual([
      "agent:main:session-1",
      "agent:main:session-2",
      "agent:main:session-3",
      "agent:main:session-4",
      "agent:main:session-5",
      "agent:main:session-6",
      "agent:main:session-7",
      "agent:main:session-8",
      "agent:main:session-9",
      "agent:main:session-10",
    ]);
    expect(summary.sessions.byAgent[0]?.recent.map((session) => session.key)).toEqual(
      summary.sessions.recent.map((session) => session.key),
    );
  });

  it("passes agent scope when listing configured agent session stores", async () => {
    vi.mocked(listGatewayAgentsBasic).mockReturnValue({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }, { id: "ops" }],
    });
    vi.mocked(resolveStorePath).mockImplementation((_store, opts) => {
      return `/tmp/${opts?.agentId ?? "main"}/sessions.json`;
    });
    statusSummaryMocks.listSessionEntries.mockImplementation((scope) =>
      scope?.agentId === "ops"
        ? toSessionEntrySummaries({
            main: { sessionId: "ops-session", updatedAt: 2 },
          })
        : toSessionEntrySummaries({
            main: { sessionId: "main-session", updatedAt: 1 },
          }),
    );

    const summary = await getStatusSummary({ includeChannelSummary: false });

    expect(statusSummaryMocks.listSessionEntries).toHaveBeenCalledWith({
      agentId: "main",
      storePath: "/tmp/main/sessions.json",
    });
    expect(statusSummaryMocks.listSessionEntries).toHaveBeenCalledWith({
      agentId: "ops",
      storePath: "/tmp/ops/sessions.json",
    });
    expect(summary.sessions.count).toBe(2);
    expect(summary.sessions.byAgent.map((agent) => [agent.agentId, agent.count])).toEqual([
      ["main", 1],
      ["ops", 1],
    ]);
  });

  it("aggregates shared file session stores only once", async () => {
    vi.mocked(listGatewayAgentsBasic).mockReturnValue({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }, { id: "ops" }],
    });
    vi.mocked(resolveStorePath).mockReturnValue("/tmp/shared-sessions.json");
    statusSummaryMocks.listSessionEntries.mockReturnValue(
      toSessionEntrySummaries({
        main: { sessionId: "shared-session", updatedAt: 1 },
      }),
    );

    const summary = await getStatusSummary({ includeChannelSummary: false });

    expect(summary.sessions.count).toBe(1);
    expect(summary.sessions.byAgent.map((agent) => [agent.agentId, agent.count])).toEqual([
      ["main", 1],
      ["ops", 1],
    ]);
    expect(statusSummaryMocks.listSessionEntries).toHaveBeenCalledWith({
      storePath: "/tmp/shared-sessions.json",
    });
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
    statusSummaryMocks.listSessionEntries.mockReturnValue(
      toSessionEntrySummaries({
        "agent:main:main": {
          sessionId: "session-1",
          updatedAt: Date.now(),
          providerOverride: "deepseek",
          modelOverride: "deepseek-v4-flash",
          modelOverrideSource: "user",
        },
      }),
    );

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
    statusSummaryMocks.listSessionEntries.mockReturnValue(
      toSessionEntrySummaries({
        "agent:main:main": {
          sessionId: "session-1",
          updatedAt: Date.now(),
          modelProvider: "deepseek",
          model: "deepseek-v4-flash",
        },
      }),
    );

    const summary = await getStatusSummary();

    expect(summary.sessions.recent[0]?.configuredModel).toBe("zhipu/glm-4.5-air");
    expect(summary.sessions.recent[0]?.selectedModel).toBe("deepseek/deepseek-v4-flash");
    expect(summary.sessions.recent[0]?.modelSelectionReason).toBeNull();
  });

  it("marks auto fallback model overrides with a fallback reason label", async () => {
    vi.mocked(statusSummaryRuntime.resolveConfiguredStatusModelRef).mockReturnValue({
      provider: "zhipu",
      model: "glm-4.5-air",
    });
    vi.mocked(statusSummaryRuntime.resolveSessionModelRef).mockReturnValue({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    statusSummaryMocks.listSessionEntries.mockReturnValue(
      toSessionEntrySummaries({
        "agent:main:main": {
          sessionId: "session-1",
          updatedAt: Date.now(),
          providerOverride: "deepseek",
          modelOverride: "deepseek-v4-flash",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "zhipu",
          modelOverrideFallbackOriginModel: "glm-4.5-air",
        },
      }),
    );

    const summary = await getStatusSummary();

    expect(summary.sessions.recent[0]?.configuredModel).toBe("zhipu/glm-4.5-air");
    expect(summary.sessions.recent[0]?.selectedModel).toBe("deepseek/deepseek-v4-flash");
    expect(summary.sessions.recent[0]?.modelSelectionReason).toBe("fallback selected");
  });

  it("does not mark configured subagent models as auto fallback", async () => {
    vi.mocked(statusSummaryRuntime.resolveConfiguredStatusModelRef).mockReturnValue({
      provider: "zhipu",
      model: "glm-4.5-air",
    });
    vi.mocked(statusSummaryRuntime.resolveSessionModelRef).mockReturnValue({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    statusSummaryMocks.listSessionEntries.mockReturnValue(
      toSessionEntrySummaries({
        "agent:worker:subagent:configured": {
          sessionId: "configured-subagent",
          updatedAt: Date.now(),
          providerOverride: "deepseek",
          modelOverride: "deepseek-v4-flash",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "deepseek",
          modelOverrideFallbackOriginModel: "deepseek-v4-flash",
        },
      }),
    );

    const summary = await getStatusSummary();

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
    statusSummaryMocks.listSessionEntries.mockReturnValue(
      toSessionEntrySummaries({
        "agent:main:main": {
          sessionId: "session-1",
          updatedAt: Date.now(),
          providerOverride: "openai",
          modelOverride: "gpt-5.5-codex",
          modelOverrideSource: "user",
        },
      }),
    );

    const summary = await getStatusSummary();

    expect(summary.sessions.recent[0]?.configuredModel).toBe("openai/gpt-5.5-codex");
    expect(summary.sessions.recent[0]?.selectedModel).toBe("openai/gpt-5.5-codex");
    expect(summary.sessions.recent[0]?.modelSelectionReason).toBeNull();
  });

  it("does not mark provider-local model aliases as pinned mismatches", async () => {
    vi.mocked(statusSummaryRuntime.resolveConfiguredStatusModelRef).mockReturnValue({
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
    vi.mocked(statusSummaryRuntime.resolveSessionModelRef).mockReturnValue({
      provider: "anthropic",
      model: "opus",
    });
    vi.mocked(statusSummaryRuntime.resolveStatusModelComparisonLabel).mockImplementation(
      ({ provider, model }) => {
        if (provider === "anthropic" && model === "opus") {
          return "anthropic/claude-opus-4-8";
        }
        return typeof model === "string" && model.length > 0
          ? `${typeof provider === "string" && provider.length > 0 ? provider : "openai"}/${model}`
          : null;
      },
    );
    vi.mocked(statusSummaryRuntime.resolveStatusModelLookupRef).mockImplementation(
      ({ provider, model }) => {
        if (provider === "anthropic" && model === "opus") {
          return { provider: "anthropic", model: "claude-opus-4-8" };
        }
        return typeof model === "string" && model.length > 0
          ? {
              provider: typeof provider === "string" && provider.length > 0 ? provider : "openai",
              model,
            }
          : null;
      },
    );
    statusSummaryMocks.listSessionEntries.mockReturnValue(
      toSessionEntrySummaries({
        "agent:main:main": {
          sessionId: "session-1",
          updatedAt: Date.now(),
          modelOverride: "opus",
          modelOverrideSource: "user",
        },
      }),
    );

    const summary = await getStatusSummary();

    expect(summary.sessions.recent[0]?.configuredModel).toBe("anthropic/claude-opus-4-8");
    expect(summary.sessions.recent[0]?.selectedModel).toBe("anthropic/opus");
    expect(summary.sessions.recent[0]?.modelSelectionReason).toBeNull();
    expect(statusSummaryRuntime.resolveSessionRuntimeLabel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-opus-4-8",
      }),
    );
  });
});
