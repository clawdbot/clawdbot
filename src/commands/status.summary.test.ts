// Status summary tests cover aggregate status text for channels, sessions, tasks, and audit findings.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_TOTAL_TOKENS_VERSION } from "../config/sessions/types.js";
import { setActiveDegradedPlugins } from "../plugins/runtime-degraded-state.js";
import {
  clearActiveCredentialDegradedOwner,
  setActiveCredentialDegradedOwner,
  setActiveDegradedSecretOwners,
} from "../secrets/runtime-degraded-state.js";
import type { TaskAuditFinding } from "../tasks/task-registry.audit.js";
import { createEmptyTaskRegistrySummary } from "../tasks/task-registry.summary.js";
import type { TaskRecord, TaskRegistrySummary } from "../tasks/task-registry.types.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { registerStatusSummarySessionRowCases } from "./status.summary.test-support.js";

const statusSummaryMocks = vi.hoisted(() => ({
  hasConfiguredChannelsForReadOnlyScope: vi.fn(() => true),
  buildChannelSummary: vi.fn(async () => ["ok"]),
  resolveProviderStaticModel: vi.fn(),
  listSessionEntriesCore: vi.fn<
    (scope?: { agentId?: string; storePath?: string }) => Array<{
      sessionKey: string;
      entry: Record<string, unknown>;
    }>
  >(() => []),
  loadExactSessionEntryReadOnly:
    vi.fn<typeof import("../config/sessions/session-accessor.js").loadExactSessionEntryReadOnly>(),
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
  taskRegistryReadOnlyState: "ready" as "ready" | "migration-required",
  inspectTasksReadOnly: vi.fn(() => ({
    state: statusSummaryMocks.taskRegistryReadOnlyState,
    tasks: statusSummaryMocks.inspectableTasks,
  })),
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

vi.mock("../status/summary.runtime.js", () => ({
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
    resolveSessionRuntime: vi.fn(() => ({ id: "openclaw", label: "OpenClaw Default" })),
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
    resolveAuthoredModelContextTokens: vi.fn(() => undefined),
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
  resolveSessionStorePathCore: vi.fn(() => "/tmp/sessions.json"),
}));

vi.mock("../config/sessions/session-accessor.js", () => ({
  loadExactSessionEntryReadOnly: statusSummaryMocks.loadExactSessionEntryReadOnly,
  readSessionStoreSummaryReadOnly: (
    scope: Parameters<
      typeof import("../config/sessions/session-accessor.js").readSessionStoreSummaryReadOnly
    >[0],
    options: Parameters<
      typeof import("../config/sessions/session-accessor.js").readSessionStoreSummaryReadOnly
    >[1],
  ) => {
    const entries = statusSummaryMocks
      .listSessionEntriesCore(scope)
      .filter(({ sessionKey }) => sessionKey.startsWith("agent:"))
      .map(({ sessionKey, entry }) => ({
        sessionKey,
        entry: { sessionId: sessionKey, updatedAt: 0, ...entry },
      }))
      .toSorted(
        (left, right) =>
          right.entry.updatedAt - left.entry.updatedAt ||
          (left.sessionKey < right.sessionKey ? -1 : left.sessionKey > right.sessionKey ? 1 : 0),
      );
    const summarize = (rows: typeof entries) => ({
      count: rows.length,
      recent: rows.slice(0, options.recentLimit),
    });
    return {
      ...summarize(entries),
      byAgent: new Map(
        options.agentIds.map((agentId) => [
          agentId,
          summarize(entries.filter(({ sessionKey }) => sessionKey.startsWith(`agent:${agentId}:`))),
        ]),
      ),
    };
  },
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

vi.mock("../infra/system-events.js", () => ({
  peekSystemEvents: vi.fn(() => []),
}));

vi.mock("../tasks/task-registry.maintenance.js", () => ({
  inspectTasksReadOnly: statusSummaryMocks.inspectTasksReadOnly,
  getInspectableTaskRegistrySummary: statusSummaryMocks.getInspectableTaskRegistrySummary,
  getInspectableTaskAuditFindings: statusSummaryMocks.getInspectableTaskAuditFindings,
}));

vi.mock("../routing/session-key.js", async () => {
  const actual = await vi.importActual<typeof import("../routing/session-key.js")>(
    "../routing/session-key.js",
  );
  return {
    ...actual,
    LEGACY_IMPLICIT_AGENT_ID: "main",
    normalizeAgentId: vi.fn((value: string) => value),
    normalizeMainKey: vi.fn((value?: string) => value ?? "main"),
    parseAgentSessionKey: vi.fn(actual.parseAgentSessionKey),
  };
});

vi.mock("../version.js", async () => {
  const actual = await vi.importActual<typeof import("../version.js")>("../version.js");
  return {
    ...actual,
    resolveRuntimeServiceVersion: vi.fn(() => "2026.3.8"),
  };
});

vi.mock("../status/link-channel.js", () => ({
  resolveLinkChannelContext: vi.fn(async () => undefined),
}));

const { buildChannelSummary } = await import("../infra/channel-summary.js");
const { resolveSessionStorePathCore } = await import("../config/sessions/paths.js");
const { listGatewayAgentsBasic } = await import("../gateway/agent-list.js");
const { resolveLinkChannelContext } = await import("../status/link-channel.js");
let getStatusSummary: typeof import("../status/summary.js").getStatusSummary;
let statusSummaryRuntime: typeof import("../status/summary.runtime.js").statusSummaryRuntime;

function toSessionEntrySummaries(store: Record<string, Record<string, unknown>>) {
  return Object.entries(store).map(([sessionKey, entry]) => ({ sessionKey, entry }));
}

describe("getStatusSummary", () => {
  beforeAll(async () => {
    ({ getStatusSummary } = await import("../status/summary.js"));
    ({ statusSummaryRuntime } = await import("../status/summary.runtime.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setActiveDegradedPlugins([]);
    clearActiveCredentialDegradedOwner("account", "telegram:work");
    setActiveDegradedSecretOwners([]);
    statusSummaryMocks.taskRegistrySummary = createEmptyTaskRegistrySummary();
    statusSummaryMocks.taskRegistryReadOnlyState = "ready";
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
    statusSummaryMocks.listSessionEntriesCore.mockReturnValue([]);
    statusSummaryMocks.loadExactSessionEntryReadOnly.mockImplementation(({ sessionKey }) => {
      const entry = statusSummaryMocks
        .listSessionEntriesCore()
        .find((candidate) => candidate.sessionKey === sessionKey)?.entry;
      return entry
        ? { sessionKey, entry: { sessionId: sessionKey, updatedAt: 0, ...entry } }
        : undefined;
    });
    vi.mocked(statusSummaryRuntime.resolveAuthoredModelContextTokens).mockReturnValue(undefined);
    vi.mocked(statusSummaryRuntime.resolveContextTokensForModel).mockReturnValue(200_000);
    vi.mocked(statusSummaryRuntime.resolveSessionRuntime).mockReturnValue({
      id: "openclaw",
      label: "OpenClaw Default",
    });
    vi.mocked(resolveSessionStorePathCore).mockReturnValue("/tmp/sessions.json");
    vi.mocked(listGatewayAgentsBasic).mockReturnValue({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }],
    });
  });

  registerStatusSummarySessionRowCases({
    getStatusSummary: () => getStatusSummary(),
    getStatusSummaryRuntime: () => statusSummaryRuntime,
    rejectProviderStaticModel: (error) =>
      statusSummaryMocks.resolveProviderStaticModel.mockRejectedValueOnce(error),
    setSessions: (store) =>
      statusSummaryMocks.listSessionEntriesCore.mockReturnValue(toSessionEntrySummaries(store)),
  });

  it.each([true, false])(
    "keeps public summary fields with includeSensitive=%s",
    async (includeSensitive) => {
      const summary = await getStatusSummary({ includeSensitive });

      expect(summary.runtimeVersion).toBe("2026.3.8");
      expect(summary.heartbeat.defaultAgentId).toBe("main");
      expect(summary.heartbeat.agents).toEqual([
        {
          agentId: "main",
          enabled: true,
          every: "30m",
          everyMs: 1_800_000,
          waitingForRoute: true,
        },
      ]);
      expect(summary.channelSummary).toEqual(["ok"]);
      expect(summary.tasks).toEqual(statusSummaryMocks.taskRegistrySummary);
      expect(summary.taskAudit.warnings).toBe(1);
    },
  );

  // waitingForRoute must follow the session the runner actually reads
  // (heartbeat.session when set), not always the agent main session.
  it.each([
    {
      name: "main routed, no configured session",
      routedKeys: ["agent:main:main"],
      emptyKeys: [],
      heartbeatSession: undefined,
      waitingForRoute: false,
    },
    {
      name: "configured session routed while main is empty",
      routedKeys: ["agent:main:telegram:alerts"],
      emptyKeys: ["agent:main:main"],
      heartbeatSession: "telegram:alerts",
      waitingForRoute: false,
    },
    {
      name: "configured session empty while main is routed",
      routedKeys: ["agent:main:main"],
      emptyKeys: ["agent:main:telegram:alerts"],
      heartbeatSession: "telegram:alerts",
      waitingForRoute: true,
    },
  ])("route wait: $name", async ({ routedKeys, emptyKeys, heartbeatSession, waitingForRoute }) => {
    statusSummaryMocks.listSessionEntriesCore.mockReturnValue([
      ...routedKeys.map((sessionKey) => ({
        sessionKey,
        entry: {
          delivery: normalizeSessionDeliveryState({
            context: { channel: "telegram", to: "123" },
          }),
        },
      })),
      ...emptyKeys.map((sessionKey) => ({ sessionKey, entry: {} })),
    ]);

    const config = {
      agents: { defaults: { heartbeat: { target: "last", session: heartbeatSession } } },
    };
    const summary = await getStatusSummary({ config });

    expect(summary.heartbeat.agents[0]?.waitingForRoute).toBe(waitingForRoute);
  });

  it.each([
    { target: "owner", every: "0m", enabled: false },
    { target: "none", every: "30m", enabled: true },
    { target: "telegram", every: "30m", enabled: true },
  ])(
    "does not read an unused heartbeat route for $target/$every",
    async ({ target, every, enabled }) => {
      const summary = await getStatusSummary({
        config: { agents: { defaults: { heartbeat: { target, every } } } },
        includeChannelSummary: false,
      });

      expect(summary.heartbeat.agents[0]).toMatchObject({ enabled, waitingForRoute: false });
      expect(statusSummaryMocks.loadExactSessionEntryReadOnly).not.toHaveBeenCalled();
    },
  );

  it("skips session model discovery and projection when sensitive output is disabled", async () => {
    statusSummaryMocks.listSessionEntriesCore.mockReturnValue([
      {
        sessionKey: "agent:main:main",
        entry: {
          sessionId: "session-1",
          updatedAt: 100,
          model: "gpt-5.5",
          modelProvider: "openai",
          totalTokens: 42,
        },
      },
    ]);

    const summary = await getStatusSummary({ includeSensitive: false });

    expect(statusSummaryRuntime.waitForContextWindowCacheLoad).not.toHaveBeenCalled();
    expect(statusSummaryRuntime.resolveConfiguredStatusModelRef).not.toHaveBeenCalled();
    expect(statusSummaryRuntime.resolveSessionRuntime).not.toHaveBeenCalled();
    expect(statusSummaryMocks.resolveProviderStaticModel).not.toHaveBeenCalled();
    expect(summary.sessions).toEqual({
      paths: [],
      count: 1,
      defaults: { model: null, contextTokens: null },
      recent: [],
      byAgent: [{ agentId: "main", path: "[redacted]", count: 1, recent: [] }],
    });
  });

  it("keeps resolved and source config roles distinct for channel summaries", async () => {
    const config = { channels: { discord: { enabled: true } } };
    const sourceConfig = { channels: { discord: { token: "source-secret" } } };

    await getStatusSummary({
      config: config as never,
      sourceConfig: sourceConfig as never,
    });

    expect(statusSummaryMocks.hasConfiguredChannelsForReadOnlyScope).toHaveBeenCalledWith({
      config,
      activationSourceConfig: sourceConfig,
    });
    expect(resolveLinkChannelContext).toHaveBeenCalledWith(config, { sourceConfig });
    expect(buildChannelSummary).toHaveBeenCalledWith(config, {
      colorize: true,
      includeAllowFrom: true,
      sourceConfig,
    });
  });

  it("reports stale snapshot and cold credential owners without exposing ref identifiers", async () => {
    setActiveDegradedSecretOwners([
      {
        ownerKind: "provider",
        ownerId: "openai",
        state: "unavailable",
        degradationState: "stale",
        paths: ["models.providers.openai.apiKey"],
        refKeys: ["env:default:PRIVATE_REF_ID"],
        reason: "provider SecretRef is unresolved (env:default:PRIVATE_REF_ID)",
      },
    ]);
    setActiveCredentialDegradedOwner({
      ownerKind: "account",
      ownerId: "telegram:work",
      state: "unavailable",
      paths: ["channels.telegram.accounts.work.tokenFile"],
      refKeys: [],
      reason: "credential failure includes PRIVATE_REF_ID",
    });

    const summary = await getStatusSummary();

    expect(summary.degradedSecretOwners).toEqual([
      {
        ownerKind: "provider",
        ownerId: "openai",
        state: "unavailable",
        degradationState: "stale",
        paths: ["models.providers.openai.apiKey"],
        reason: "secret resolution failed",
      },
      {
        ownerKind: "account",
        ownerId: "telegram:work",
        state: "unavailable",
        degradationState: "cold",
        paths: ["channels.telegram.accounts.work.tokenFile"],
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

    expect(statusSummaryMocks.inspectTasksReadOnly).toHaveBeenCalledTimes(1);
    expect(statusSummaryMocks.getInspectableTaskRegistrySummary).toHaveBeenCalledWith(
      inspectableTasks,
    );
    expect(statusSummaryMocks.getInspectableTaskAuditFindings).toHaveBeenCalledWith(
      inspectableTasks,
    );
  });

  it("reports task schema migration state without failing status", async () => {
    statusSummaryMocks.taskRegistryReadOnlyState = "migration-required";

    const summary = await getStatusSummary();

    expect(summary.tasks.total).toBe(0);
    expect(summary.tasks.warning).toBe(
      "Task history is unavailable until Gateway startup or openclaw doctor --fix repairs the state database.",
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

  it.each([
    {
      name: "fresh v1",
      checkpoint: {
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      },
      expected: {
        totalTokensFresh: true,
        remainingTokens: 150_000,
        percentUsed: 25,
      },
    },
    {
      name: "stale v1",
      checkpoint: {
        totalTokensFresh: false,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      },
      expected: {
        totalTokensFresh: false,
        remainingTokens: null,
        percentUsed: null,
      },
    },
    {
      name: "fresh unversioned",
      checkpoint: {
        totalTokensFresh: true,
      },
      expected: {
        totalTokensFresh: false,
        remainingTokens: null,
        percentUsed: null,
      },
    },
    {
      name: "wrong-version",
      checkpoint: {
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION + 1,
      },
      expected: {
        totalTokensFresh: false,
        remainingTokens: null,
        percentUsed: null,
      },
    },
  ])("handles $name checkpoint usage provenance", async ({ checkpoint, expected }) => {
    statusSummaryMocks.listSessionEntriesCore.mockReturnValue(
      toSessionEntrySummaries({
        "agent:main:main": {
          sessionId: "checkpoint-total",
          updatedAt: Date.now(),
          totalTokens: 50_000,
          ...checkpoint,
        },
      }),
    );

    const summary = await getStatusSummary();

    expect(summary.sessions.recent[0]).toMatchObject({
      totalTokens: 50_000,
      ...expected,
    });
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

  it("passes agent scope when listing configured agent session stores", async () => {
    vi.mocked(listGatewayAgentsBasic).mockReturnValue({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }, { id: "ops" }],
    });
    vi.mocked(resolveSessionStorePathCore).mockImplementation((_store, opts) => {
      return `/tmp/${opts?.agentId ?? "main"}/sessions.json`;
    });
    statusSummaryMocks.listSessionEntriesCore.mockImplementation((scope) =>
      scope?.agentId === "ops"
        ? toSessionEntrySummaries({
            "agent:ops:main": { sessionId: "ops-session", updatedAt: 2 },
          })
        : toSessionEntrySummaries({
            "agent:main:main": { sessionId: "main-session", updatedAt: 1 },
          }),
    );

    const summary = await getStatusSummary({ includeChannelSummary: false });

    expect(statusSummaryMocks.listSessionEntriesCore).toHaveBeenCalledWith({
      agentId: "main",
      storePath: "/tmp/main/sessions.json",
    });
    expect(statusSummaryMocks.listSessionEntriesCore).toHaveBeenCalledWith({
      agentId: "ops",
      storePath: "/tmp/ops/sessions.json",
    });
    expect(summary.sessions.count).toBe(2);
    expect(summary.sessions.byAgent.map((agent) => [agent.agentId, agent.count])).toEqual([
      ["main", 1],
      ["ops", 1],
    ]);
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
    statusSummaryMocks.listSessionEntriesCore.mockReturnValue(
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
    statusSummaryMocks.listSessionEntriesCore.mockReturnValue(
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
    statusSummaryMocks.listSessionEntriesCore.mockReturnValue(
      toSessionEntrySummaries({
        "agent:main:main": {
          sessionId: "session-1",
          updatedAt: Date.now(),
          providerOverride: "deepseek",
          modelOverride: "deepseek-v4-flash",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "zhipu",
          modelOverrideFallbackOriginModel: "glm-4.5-air",
          modelProvider: "deepseek",
          model: "deepseek-v4-flash",
          agentHarnessId: "openclaw",
          contextTokens: 128_000,
          contextTokensSource: "runtime",
        },
      }),
    );

    const summary = await getStatusSummary();

    expect(summary.sessions.recent[0]?.configuredModel).toBe("zhipu/glm-4.5-air");
    expect(summary.sessions.recent[0]?.selectedModel).toBe("deepseek/deepseek-v4-flash");
    expect(summary.sessions.recent[0]?.modelSelectionReason).toBe("fallback selected");
    expect(summary.sessions.recent[0]?.contextTokens).toBe(128_000);
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
    statusSummaryMocks.listSessionEntriesCore.mockReturnValue(
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
    statusSummaryMocks.listSessionEntriesCore.mockReturnValue(
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
    statusSummaryMocks.listSessionEntriesCore.mockReturnValue(
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
    expect(statusSummaryRuntime.resolveSessionRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-opus-4-8",
      }),
    );
  });

  it("resolves aggregate selected models from each row's agent", async () => {
    const models: Record<string, string> = { ops: "ops", research: "research" };
    vi.mocked(statusSummaryRuntime.resolveSessionModelRef).mockImplementation(
      (_cfg, _entry, id) => ({ provider: "openai", model: models[id ?? ""] ?? "global" }),
    );
    statusSummaryMocks.listSessionEntriesCore.mockReturnValue(
      toSessionEntrySummaries({
        "agent:ops:main": { sessionId: "ops-session", updatedAt: 3 },
        "agent:research:main": { sessionId: "research-session", updatedAt: 2 },
        "agent:main:main": { sessionId: "global-session", updatedAt: 1 },
      }),
    );

    const summary = await getStatusSummary();
    const selected = summary.sessions.recent.map(({ selectedModel }) => selectedModel);

    expect(selected).toEqual(["openai/ops", "openai/research", "openai/global"]);
    expect(summary.sessions.count).toBe(3);
    expect(summary.sessions.byAgent[0]?.count).toBe(1);
    expect(summary.sessions.byAgent[0]?.recent.map(({ key }) => key)).toEqual(["agent:main:main"]);
  });
});
