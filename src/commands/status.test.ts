import type { Mock } from "vitest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import { createCompatibilityNotice } from "../plugins/status.test-helpers.js";
import { captureEnv } from "../test-utils/env.js";

let envSnapshot: ReturnType<typeof captureEnv>;

beforeAll(() => {
  envSnapshot = captureEnv(["OPENCLAW_PROFILE"]);
  process.env.OPENCLAW_PROFILE = "isolated";
});

afterAll(() => {
  envSnapshot.restore();
});

function createDefaultSessionStoreEntry() {
  return {
    updatedAt: Date.now() - 60_000,
    verboseLevel: "on",
    thinkingLevel: "low",
    inputTokens: 2_000,
    outputTokens: 3_000,
    cacheRead: 2_000,
    cacheWrite: 1_000,
    totalTokens: 5_000,
    totalTokensFresh: true as boolean,
    contextTokens: 10_000,
    model: "pi:opus",
    sessionId: "abc123",
    systemSent: true,
  };
}

function createUnknownUsageSessionStore() {
  return {
    "+1000": {
      updatedAt: Date.now() - 60_000,
      inputTokens: 2_000,
      outputTokens: 3_000,
      contextTokens: 10_000,
      model: "pi:opus",
    },
  };
}

function createChannelIssueCollector(channel: string) {
  return (accounts: Array<Record<string, unknown>>) =>
    accounts
      .filter((account) => typeof account.lastError === "string" && account.lastError)
      .map((account) => ({
        channel,
        accountId: typeof account.accountId === "string" ? account.accountId : "default",
        message: `Channel error: ${String(account.lastError)}`,
      }));
}

function createErrorChannelPlugin(params: { id: string; label: string; docsPath: string }) {
  return {
    id: params.id,
    meta: {
      id: params.id,
      label: params.label,
      selectionLabel: params.label,
      docsPath: params.docsPath,
      blurb: "mock",
    },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
    },
    status: {
      collectStatusIssues: createChannelIssueCollector(params.id),
    },
  };
}

async function withUnknownUsageStore(run: () => Promise<void>) {
  mocks.loadSessionStore.mockReturnValue(createUnknownUsageSessionStore());
  await run();
}

function getRuntimeLogs() {
  return runtimeLogMock.mock.calls.map((call: unknown[]) => String(call[0]));
}

function getJoinedRuntimeLogs() {
  return getRuntimeLogs().join("\n");
}

async function runStatusAndGetLogs(args: Parameters<typeof statusCommand>[0] = {}) {
  runtimeLogMock.mockClear();
  await statusCommand(args, runtime as never);
  return getRuntimeLogs();
}

async function runStatusAndGetJoinedLogs(args: Parameters<typeof statusCommand>[0] = {}) {
  await runStatusAndGetLogs(args);
  return getJoinedRuntimeLogs();
}

type ProbeGatewayResult = {
  ok: boolean;
  url: string;
  connectLatencyMs: number | null;
  error: string | null;
  close: { code: number; reason: string } | null;
  health: unknown;
  status: unknown;
  presence: unknown;
  configSnapshot: unknown;
};

function mockProbeGatewayResult(overrides: Partial<ProbeGatewayResult>) {
  mocks.probeGateway.mockReset();
  mocks.probeGateway.mockResolvedValue({
    ...createDefaultProbeGatewayResult(),
    ...overrides,
  });
}

function createDefaultProbeGatewayResult(): ProbeGatewayResult {
  return {
    ok: false,
    url: "ws://127.0.0.1:18789",
    connectLatencyMs: null,
    error: "timeout",
    close: null,
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
  };
}

function createDefaultSecurityAuditResult() {
  return {
    ts: 0,
    summary: { critical: 1, warn: 1, info: 2 },
    findings: [
      {
        checkId: "test.critical",
        severity: "critical",
        title: "Test critical finding",
        detail: "Something is very wrong\nbut on two lines",
        remediation: "Do the thing",
      },
      {
        checkId: "test.warn",
        severity: "warn",
        title: "Test warning finding",
        detail: "Something is maybe wrong",
      },
      {
        checkId: "test.info",
        severity: "info",
        title: "Test info finding",
        detail: "FYI only",
      },
      {
        checkId: "test.info2",
        severity: "info",
        title: "Another info finding",
        detail: "More FYI",
      },
    ],
  };
}

async function createStatusServiceSummary(
  service: ReturnType<(typeof mocks)["resolveGatewayService"]>,
) {
  const [loaded, runtime, command] = await Promise.all([
    service.isLoaded(),
    service.readRuntime(),
    service.readCommand(),
  ]);
  return {
    label: service.label,
    installed: Boolean(command) || runtime?.status === "running",
    loaded,
    managedByOpenClaw: Boolean(command),
    externallyManaged: !command && runtime?.status === "running",
    loadedText: service.loadedText,
    runtime,
    runtimeShort: runtime?.pid ? `pid ${runtime.pid}` : null,
  };
}

function createSessionStatusRows() {
  const agents = (mocks.listGatewayAgentsBasic().agents ?? [
    { id: "main", name: "Main" },
  ]) as Array<{
    id: string;
  }>;
  const byAgent = agents.map((agent: { id: string }) => {
    const path = mocks.resolveStorePath("sessions", { agentId: agent.id });
    const store = mocks.loadSessionStore(path) as Record<
      string,
      ReturnType<typeof createDefaultSessionStoreEntry>
    >;
    const recent = Object.entries(store).map(([key, entry]) => {
      const contextTokens = typeof entry.contextTokens === "number" ? entry.contextTokens : null;
      const total = typeof entry.totalTokens === "number" ? entry.totalTokens : null;
      return {
        agentId: agent.id,
        key,
        kind: key.startsWith("+") ? ("direct" as const) : ("unknown" as const),
        sessionId: entry.sessionId,
        updatedAt: entry.updatedAt ?? null,
        age: typeof entry.updatedAt === "number" ? Math.max(0, Date.now() - entry.updatedAt) : null,
        thinkingLevel: entry.thinkingLevel,
        verboseLevel: entry.verboseLevel,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        totalTokens: total,
        totalTokensFresh: typeof entry.totalTokens === "number" ? entry.totalTokensFresh : false,
        cacheRead: entry.cacheRead,
        cacheWrite: entry.cacheWrite,
        remainingTokens:
          total !== null && contextTokens !== null ? Math.max(0, contextTokens - total) : null,
        percentUsed:
          total !== null && contextTokens ? Math.round((total / contextTokens) * 100) : null,
        model: typeof entry.model === "string" ? entry.model : null,
        contextTokens,
        flags: [
          ...(entry.verboseLevel ? [`verbose:${entry.verboseLevel}`] : []),
          ...(entry.thinkingLevel ? [`think:${entry.thinkingLevel}`] : []),
        ],
      };
    });
    return { agentId: agent.id, path, count: recent.length, recent };
  });
  const recent = byAgent.flatMap((entry) => entry.recent);
  return {
    paths: byAgent.map((entry) => entry.path),
    count: recent.length,
    defaults: {
      model: recent[0]?.model ?? "pi:opus",
      contextTokens: recent[0]?.contextTokens ?? 10_000,
    },
    recent,
    byAgent,
  };
}

async function createMockStatusScanResult(params: { includePluginCompatibility?: boolean } = {}) {
  const cfg = mocks.loadConfig();
  const gatewayProbe = await mocks.probeGateway();
  const gatewayReachable = gatewayProbe.ok === true;
  const gatewayAuthWarning =
    cfg.gateway?.auth?.token && typeof cfg.gateway.auth.token === "object"
      ? "gateway.auth.token unavailable"
      : undefined;
  const agentStatus = {
    ...mocks.listGatewayAgentsBasic(),
    bootstrapPendingCount: 0,
    totalSessions: 1,
    agents: mocks
      .listGatewayAgentsBasic()
      .agents.map((agent: { id: string; name?: string }) =>
        Object.assign({}, agent, { bootstrapPending: false, activeSessions: 1 }),
      ),
  };
  const sessions = createSessionStatusRows();
  const channelIssues = gatewayReachable
    ? [
        {
          channel: "signal",
          accountId: "default",
          message: "gateway: signal-cli unreachable",
        },
        {
          channel: "imessage",
          accountId: "default",
          message: "gateway: imessage permission denied",
        },
      ]
    : [
        {
          channel: "signal",
          accountId: "default",
          message: "Channel error: signal-cli unreachable",
        },
        {
          channel: "imessage",
          accountId: "default",
          message: "Channel error: imessage permission denied",
        },
      ];
  const pluginCompatibility =
    params.includePluginCompatibility === false ? [] : mocks.buildPluginCompatibilityNotices();
  return {
    cfg,
    sourceConfig: cfg,
    secretDiagnostics: gatewayAuthWarning ? ["gateway.auth.token unavailable"] : [],
    osSummary: {
      platform: "darwin",
      arch: "arm64",
      release: "23.0.0",
      label: "macos 14.0 (arm64)",
    },
    tailscaleMode: "off",
    tailscaleDns: null,
    tailscaleHttpsUrl: null,
    update: {
      root: "/tmp/openclaw",
      installKind: "git",
      packageManager: "pnpm",
      git: {
        root: "/tmp/openclaw",
        branch: "main",
        upstream: "origin/main",
        dirty: false,
        ahead: 0,
        behind: 0,
        fetchOk: true,
      },
      deps: {
        manager: "pnpm",
        status: "ok",
        lockfilePath: "/tmp/openclaw/pnpm-lock.yaml",
        markerPath: "/tmp/openclaw/node_modules/.modules.yaml",
      },
      registry: { latestVersion: "0.0.0" },
    },
    gatewayConnection: { url: "ws://127.0.0.1:18789" },
    remoteUrlMissing: false,
    gatewayMode: "local" as const,
    gatewayProbeAuth: process.env.OPENCLAW_GATEWAY_TOKEN
      ? { token: process.env.OPENCLAW_GATEWAY_TOKEN }
      : {},
    gatewayProbeAuthWarning: gatewayAuthWarning,
    gatewayProbe,
    gatewayReachable,
    gatewaySelf: gatewayProbe.presence ? { host: "gateway", ip: "127.0.0.1" } : null,
    channelIssues,
    agentStatus,
    channels: {
      rows: [
        { id: "whatsapp", label: "WhatsApp", enabled: true, state: "ok", detail: "linked" },
        { id: "signal", label: "Signal", enabled: true, state: "warn", detail: "gateway warning" },
        {
          id: "imessage",
          label: "iMessage",
          enabled: true,
          state: "warn",
          detail: "gateway warning",
        },
      ],
      details: [],
    },
    summary: {
      runtimeVersion: null,
      heartbeat: { defaultAgentId: "main", agents: [] },
      channelSummary: [],
      queuedSystemEvents: [],
      tasks: mocks.getInspectableTaskRegistrySummary(),
      taskAudit: mocks.getInspectableTaskAuditSummary(),
      sessions,
    },
    memory: null,
    memoryPlugin: { enabled: true, slot: "memory-core" },
    pluginCompatibility,
  };
}

async function withEnvVar<T>(key: string, value: string, run: () => Promise<T>): Promise<T> {
  const prevValue = process.env[key];
  process.env[key] = value;
  try {
    return await run();
  } finally {
    if (prevValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prevValue;
    }
  }
}

const mocks = vi.hoisted(() => ({
  hasPotentialConfiguredChannels: vi.fn(() => true),
  loadConfig: vi.fn().mockReturnValue({ session: {} }),
  loadSessionStore: vi.fn().mockReturnValue({
    "+1000": createDefaultSessionStoreEntry(),
  }),
  resolveMainSessionKey: vi.fn().mockReturnValue("agent:main:main"),
  resolveStorePath: vi.fn().mockReturnValue("/tmp/sessions.json"),
  loadNodeHostConfig: vi.fn().mockResolvedValue(null),
  webAuthExists: vi.fn().mockResolvedValue(true),
  getWebAuthAgeMs: vi.fn().mockReturnValue(5000),
  readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
  logWebSelfId: vi.fn(),
  probeGateway: vi.fn().mockResolvedValue({
    ...createDefaultProbeGatewayResult(),
  }),
  callGateway: vi.fn().mockResolvedValue({}),
  listGatewayAgentsBasic: vi.fn().mockReturnValue({
    defaultId: "main",
    mainKey: "agent:main:main",
    scope: "per-sender",
    agents: [{ id: "main", name: "Main" }],
  }),
  runSecurityAudit: vi.fn().mockResolvedValue(createDefaultSecurityAuditResult()),
  buildPluginCompatibilityNotices: vi.fn((): PluginCompatibilityNotice[] => []),
  getInspectableTaskRegistrySummary: vi.fn().mockReturnValue({
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
  }),
  getInspectableTaskAuditSummary: vi.fn().mockReturnValue({
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
  }),
  resolveGatewayService: vi.fn().mockReturnValue({
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: async () => {},
    install: async () => {},
    uninstall: async () => {},
    stop: async () => {},
    restart: async () => ({ outcome: "completed" as const }),
    isLoaded: async () => true,
    readRuntime: async () => ({ status: "running", pid: 1234 }),
    readCommand: async () => ({
      programArguments: ["node", "dist/entry.js", "gateway"],
      sourcePath: "/tmp/Library/LaunchAgents/ai.openclaw.gateway.plist",
    }),
  }),
  resolveNodeService: vi.fn().mockReturnValue({
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: async () => {},
    install: async () => {},
    uninstall: async () => {},
    stop: async () => {},
    restart: async () => ({ outcome: "completed" as const }),
    isLoaded: async () => true,
    readRuntime: async () => ({ status: "running", pid: 4321 }),
    readCommand: async () => ({
      programArguments: ["node", "dist/entry.js", "node-host"],
      sourcePath: "/tmp/Library/LaunchAgents/ai.openclaw.node.plist",
    }),
  }),
}));

vi.mock("../channels/config-presence.js", () => ({
  hasPotentialConfiguredChannels: mocks.hasPotentialConfiguredChannels,
  hasMeaningfulChannelConfig: (entry: unknown) =>
    Boolean(
      entry && typeof entry === "object" && Object.keys(entry as Record<string, unknown>).length,
    ),
  listPotentialConfiguredChannelIds: (cfg: { channels?: Record<string, unknown> }) =>
    Object.keys(cfg.channels ?? {}).filter((key) => key !== "defaults" && key !== "modelByChannel"),
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManager: vi.fn(async ({ agentId }: { agentId: string }) => ({
    manager: {
      probeVectorAvailability: vi.fn(async () => true),
      status: () => ({
        files: 2,
        chunks: 3,
        dirty: false,
        workspaceDir: "/tmp/openclaw",
        dbPath: "/tmp/memory.sqlite",
        provider: "openai",
        model: "text-embedding-3-small",
        requestedProvider: "openai",
        sources: ["memory"],
        sourceCounts: [{ source: "memory", files: 2, chunks: 3 }],
        cache: { enabled: true, entries: 10, maxEntries: 500 },
        fts: { enabled: true, available: true },
        vector: {
          enabled: true,
          available: true,
          extensionPath: "/opt/vec0.dylib",
          dims: 1024,
        },
      }),
      close: vi.fn(async () => {}),
      __agentId: agentId,
    },
  })),
}));

vi.mock("../config/sessions/main-session.js", () => ({
  resolveMainSessionKey: mocks.resolveMainSessionKey,
}));
vi.mock("../config/sessions/paths.js", () => ({
  resolveStorePath: mocks.resolveStorePath,
}));
vi.mock("../config/sessions/store-read.js", () => ({
  readSessionStoreReadOnly: mocks.loadSessionStore,
}));
vi.mock("../config/sessions/types.js", () => ({
  resolveSessionTotalTokens: vi.fn((entry?: { totalTokens?: number }) =>
    typeof entry?.totalTokens === "number" ? entry.totalTokens : undefined,
  ),
  resolveFreshSessionTotalTokens: vi.fn(
    (entry?: { totalTokens?: number; totalTokensFresh?: boolean }) =>
      typeof entry?.totalTokens === "number" && entry?.totalTokensFresh !== false
        ? entry.totalTokens
        : undefined,
  ),
}));
vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => {
    const plugins = [
      {
        id: "whatsapp",
        meta: {
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
          docsPath: "/platforms/whatsapp",
          blurb: "mock",
        },
        config: {
          hasPersistentAuth: () => true,
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
        status: {
          buildChannelSummary: async () => ({ linked: true, authAgeMs: 5000 }),
        },
      },
      {
        ...createErrorChannelPlugin({
          id: "signal",
          label: "Signal",
          docsPath: "/platforms/signal",
        }),
      },
      {
        ...createErrorChannelPlugin({
          id: "imessage",
          label: "iMessage",
          docsPath: "/platforms/mac",
        }),
      },
    ] as const;
    return plugins as unknown;
  },
  getChannelPlugin: (channelId: string) =>
    [
      {
        id: "whatsapp",
        meta: {
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
          docsPath: "/platforms/whatsapp",
          blurb: "mock",
        },
        config: {
          hasPersistentAuth: () => true,
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
        },
        status: {
          buildChannelSummary: async () => ({ linked: true, authAgeMs: 5000 }),
        },
      },
      {
        ...createErrorChannelPlugin({
          id: "signal",
          label: "Signal",
          docsPath: "/platforms/signal",
        }),
      },
      {
        ...createErrorChannelPlugin({
          id: "imessage",
          label: "iMessage",
          docsPath: "/platforms/mac",
        }),
      },
    ].find((plugin) => plugin.id === channelId) as unknown,
}));
vi.mock("../plugins/runtime/runtime-web-channel-plugin.js", () => ({
  webAuthExists: mocks.webAuthExists,
  getWebAuthAgeMs: mocks.getWebAuthAgeMs,
  readWebSelfId: mocks.readWebSelfId,
  logWebSelfId: mocks.logWebSelfId,
}));
vi.mock("../gateway/probe.js", () => ({
  probeGateway: mocks.probeGateway,
}));
vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
  buildGatewayConnectionDetails: vi.fn(() => ({
    message: "Gateway mode: local\nGateway target: ws://127.0.0.1:18789",
  })),
  resolveGatewayCredentialsWithSecretInputs: vi.fn(
    async (params: {
      config?: {
        gateway?: {
          auth?: {
            token?: unknown;
          };
        };
      };
    }) => {
      const token = params.config?.gateway?.auth?.token;
      if (token && typeof token === "object" && "source" in token) {
        throw Object.assign(new Error("gateway.auth.token unavailable"), {
          name: "GatewaySecretRefUnavailableError",
          path: "gateway.auth.token",
        });
      }
      const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
      return envToken ? { token: envToken } : {};
    },
  ),
}));
vi.mock("../gateway/agent-list.js", () => ({
  listGatewayAgentsBasic: mocks.listGatewayAgentsBasic,
}));
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn().mockResolvedValue("/tmp/openclaw"),
  resolveOpenClawPackageRootSync: vi.fn(() => "/tmp/openclaw"),
}));
vi.mock("../infra/os-summary.js", () => ({
  resolveOsSummary: () => ({
    platform: "darwin",
    arch: "arm64",
    release: "23.0.0",
    label: "macos 14.0 (arm64)",
  }),
}));
vi.mock("../infra/update-check.js", () => ({
  checkUpdateStatus: vi.fn().mockResolvedValue({
    root: "/tmp/openclaw",
    installKind: "git",
    packageManager: "pnpm",
    git: {
      root: "/tmp/openclaw",
      branch: "main",
      upstream: "origin/main",
      dirty: false,
      ahead: 0,
      behind: 0,
      fetchOk: true,
    },
    deps: {
      manager: "pnpm",
      status: "ok",
      lockfilePath: "/tmp/openclaw/pnpm-lock.yaml",
      markerPath: "/tmp/openclaw/node_modules/.modules.yaml",
    },
    registry: { latestVersion: "0.0.0" },
  }),
  formatGitInstallLabel: vi.fn(() => "main · @ deadbeef"),
  compareSemverStrings: vi.fn(() => 0),
}));
vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  readBestEffortConfig: vi.fn(async () => mocks.loadConfig()),
  resolveGatewayPort: vi.fn(() => 18789),
}));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: mocks.resolveGatewayService,
}));
vi.mock("../daemon/node-service.js", () => ({
  resolveNodeService: mocks.resolveNodeService,
}));
vi.mock("../node-host/config.js", () => ({
  loadNodeHostConfig: mocks.loadNodeHostConfig,
}));
vi.mock("../tasks/task-registry.maintenance.js", () => ({
  getInspectableTaskRegistrySummary: mocks.getInspectableTaskRegistrySummary,
  getInspectableTaskAuditSummary: mocks.getInspectableTaskAuditSummary,
}));
vi.mock("../security/audit.js", () => ({
  runSecurityAudit: mocks.runSecurityAudit,
}));
vi.mock("../plugins/status.js", () => ({
  buildPluginCompatibilityNotices: mocks.buildPluginCompatibilityNotices,
  summarizePluginCompatibility: (warnings: PluginCompatibilityNotice[]) => ({
    noticeCount: warnings.length,
    pluginCount: new Set(warnings.map((warning) => warning.pluginId)).size,
  }),
  formatPluginCompatibilityNotice: (notice: PluginCompatibilityNotice) =>
    `${notice.pluginId} ${notice.message}`,
}));

vi.mock("./status.scan.fast-json.js", () => ({
  scanStatusJsonFast: vi.fn(async () =>
    createMockStatusScanResult({ includePluginCompatibility: false }),
  ),
}));

vi.mock("./status.scan.js", () => ({
  scanStatus: vi.fn(async () => createMockStatusScanResult()),
}));

vi.mock("./status-runtime-shared.ts", () => ({
  loadStatusProviderUsageModule: vi.fn(async () => ({
    formatUsageReportLines: vi.fn(() => []),
  })),
  resolveStatusGatewayHealth: vi.fn(async () => ({})),
  resolveStatusSecurityAudit: vi.fn(async (input: unknown) =>
    mocks.runSecurityAudit({
      ...(typeof input === "object" && input ? input : {}),
      deep: false,
      includeFilesystem: true,
      includeChannelSecurity: true,
    }),
  ),
  resolveStatusUsageSummary: vi.fn(async () => undefined),
  resolveStatusRuntimeSnapshot: vi.fn(
    async (params: {
      includeSecurityAudit?: boolean;
      resolveSecurityAudit?: (input: unknown) => Promise<unknown>;
      config: unknown;
      sourceConfig: unknown;
    }) => {
      const securityAudit = params.includeSecurityAudit
        ? await (
            params.resolveSecurityAudit ??
            (async (input) =>
              await mocks.runSecurityAudit({
                ...(typeof input === "object" && input ? input : {}),
                deep: false,
                includeFilesystem: true,
                includeChannelSecurity: true,
              }))
          )({
            config: params.config,
            sourceConfig: params.sourceConfig,
          })
        : undefined;
      return {
        securityAudit,
        usage: undefined,
        health: undefined,
        lastHeartbeat: null,
        gatewayService: await createStatusServiceSummary(mocks.resolveGatewayService()),
        nodeService: await createStatusServiceSummary(mocks.resolveNodeService()),
      };
    },
  ),
}));

import { resolvePairingRecoveryContext, statusCommand } from "./status.command.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const runtimeLogMock = runtime.log as Mock<(...args: unknown[]) => void>;

vi.mock("../channels/chat-meta.js", () => {
  const mockChatChannels = [
    "telegram",
    "whatsapp",
    "discord",
    "irc",
    "googlechat",
    "slack",
    "signal",
    "imessage",
    "line",
  ] as const;
  const entries = mockChatChannels.map((id) => ({
    id,
    label: id,
    selectionLabel: id,
    docsPath: `/channels/${id}`,
    blurb: "mock",
  }));
  const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
  return {
    CHAT_CHANNEL_ALIASES: {},
    listChatChannels: () => entries,
    listChatChannelAliases: () => [],
    getChatChannelMeta: (id: (typeof mockChatChannels)[number]) => byId[id],
    normalizeChatChannelId: (raw?: string | null) => {
      const value = raw?.trim().toLowerCase();
      return mockChatChannels.includes(value as (typeof mockChatChannels)[number])
        ? (value as (typeof mockChatChannels)[number])
        : null;
    },
  };
});
vi.mock("./status.daemon.js", () => ({
  getDaemonStatusSummary: vi.fn(async () => {
    const service = mocks.resolveGatewayService();
    const loaded = await service.isLoaded();
    const runtime = await service.readRuntime();
    const command = await service.readCommand();
    return {
      label: service.label,
      installed: Boolean(command) || runtime?.status === "running",
      loaded,
      managedByOpenClaw: Boolean(command),
      externallyManaged: !command && runtime?.status === "running",
      loadedText: loaded ? service.loadedText : service.notLoadedText,
      runtimeShort: runtime?.pid ? `pid ${runtime.pid}` : null,
    };
  }),
  getNodeDaemonStatusSummary: vi.fn(async () => {
    const service = mocks.resolveNodeService();
    const loaded = await service.isLoaded();
    const runtime = await service.readRuntime();
    const command = await service.readCommand();
    return {
      label: service.label,
      installed: Boolean(command) || runtime?.status === "running",
      loaded,
      managedByOpenClaw: Boolean(command),
      externallyManaged: !command && runtime?.status === "running",
      loadedText: loaded ? service.loadedText : service.notLoadedText,
      runtimeShort: runtime?.pid ? `pid ${runtime.pid}` : null,
    };
  }),
}));

describe("statusCommand", () => {
  afterEach(() => {
    mocks.hasPotentialConfiguredChannels.mockReset();
    mocks.hasPotentialConfiguredChannels.mockReturnValue(true);
    mocks.loadConfig.mockReset();
    mocks.loadConfig.mockReturnValue({ session: {} });
    mocks.loadSessionStore.mockReset();
    mocks.loadSessionStore.mockReturnValue({
      "+1000": createDefaultSessionStoreEntry(),
    });
    mocks.resolveMainSessionKey.mockReset();
    mocks.resolveMainSessionKey.mockReturnValue("agent:main:main");
    mocks.resolveStorePath.mockReset();
    mocks.resolveStorePath.mockReturnValue("/tmp/sessions.json");
    mocks.loadNodeHostConfig.mockReset();
    mocks.loadNodeHostConfig.mockResolvedValue(null);
    mocks.probeGateway.mockReset();
    mocks.probeGateway.mockResolvedValue(createDefaultProbeGatewayResult());
    mocks.callGateway.mockReset();
    mocks.callGateway.mockResolvedValue({});
    mocks.listGatewayAgentsBasic.mockReset();
    mocks.listGatewayAgentsBasic.mockReturnValue({
      defaultId: "main",
      mainKey: "agent:main:main",
      scope: "per-sender",
      agents: [{ id: "main", name: "Main" }],
    });
    mocks.buildPluginCompatibilityNotices.mockReset();
    mocks.buildPluginCompatibilityNotices.mockReturnValue([]);
    mocks.getInspectableTaskRegistrySummary.mockReset();
    mocks.getInspectableTaskRegistrySummary.mockReturnValue({
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
    });
    mocks.getInspectableTaskAuditSummary.mockReset();
    mocks.getInspectableTaskAuditSummary.mockReturnValue({
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
    mocks.runSecurityAudit.mockReset();
    mocks.runSecurityAudit.mockResolvedValue(createDefaultSecurityAuditResult());
    mocks.resolveGatewayService.mockReset();
    mocks.resolveGatewayService.mockReturnValue({
      label: "LaunchAgent",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      stage: async () => {},
      install: async () => {},
      uninstall: async () => {},
      stop: async () => {},
      restart: async () => ({ outcome: "completed" as const }),
      isLoaded: async () => true,
      readRuntime: async () => ({ status: "running", pid: 1234 }),
      readCommand: async () => ({
        programArguments: ["node", "dist/entry.js", "gateway"],
        sourcePath: "/tmp/Library/LaunchAgents/ai.openclaw.gateway.plist",
      }),
    });
    mocks.resolveNodeService.mockReset();
    mocks.resolveNodeService.mockReturnValue({
      label: "LaunchAgent",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      stage: async () => {},
      install: async () => {},
      uninstall: async () => {},
      stop: async () => {},
      restart: async () => ({ outcome: "completed" as const }),
      isLoaded: async () => true,
      readRuntime: async () => ({ status: "running", pid: 4321 }),
      readCommand: async () => ({
        programArguments: ["node", "dist/entry.js", "node-host"],
        sourcePath: "/tmp/Library/LaunchAgents/ai.openclaw.node.plist",
      }),
    });
    runtimeLogMock.mockClear();
    (runtime.error as Mock<(...args: unknown[]) => void>).mockClear();
  });

  it("prints JSON and includes security audit only when all is requested", async () => {
    mocks.hasPotentialConfiguredChannels.mockReturnValue(false);
    mocks.buildPluginCompatibilityNotices.mockReturnValue([
      createCompatibilityNotice({ pluginId: "legacy-plugin", code: "legacy-before-agent-start" }),
    ]);
    await statusCommand({ json: true }, runtime as never);
    const payload = JSON.parse(String(runtimeLogMock.mock.calls[0]?.[0]));
    expect(payload.linkChannel).toBeUndefined();
    expect(payload.memory).toBeNull();
    expect(payload.memoryPlugin.enabled).toBe(true);
    expect(payload.memoryPlugin.slot).toBe("memory-core");
    expect(payload.sessions.count).toBe(1);
    expect(payload.sessions.paths).toContain("/tmp/sessions.json");
    expect(payload.sessions.defaults.model).toBeTruthy();
    expect(payload.sessions.defaults.contextTokens).toBeGreaterThan(0);
    expect(payload.sessions.recent[0].percentUsed).toBe(50);
    expect(payload.sessions.recent[0].cacheRead).toBe(2_000);
    expect(payload.sessions.recent[0].cacheWrite).toBe(1_000);
    expect(payload.sessions.recent[0].totalTokensFresh).toBe(true);
    expect(payload.sessions.recent[0].remainingTokens).toBe(5000);
    expect(payload.sessions.recent[0].flags).toContain("verbose:on");
    expect(payload.securityAudit).toBeUndefined();
    expect(payload.gatewayService.label).toBe("LaunchAgent");
    expect(payload.nodeService.label).toBe("LaunchAgent");
    expect(payload.pluginCompatibility).toEqual({
      count: 0,
      warnings: [],
    });
    expect(payload.tasks).toEqual(
      expect.objectContaining({
        total: 0,
        active: 0,
        byStatus: expect.objectContaining({ queued: 0, running: 0 }),
      }),
    );
    expect(mocks.runSecurityAudit).not.toHaveBeenCalled();

    runtimeLogMock.mockClear();
    await statusCommand({ json: true, all: true }, runtime as never);

    const allPayload = JSON.parse(String(runtimeLogMock.mock.calls[0]?.[0]));
    expect(allPayload.securityAudit.summary.critical).toBe(1);
    expect(allPayload.securityAudit.summary.warn).toBe(1);
    expect(mocks.runSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        includeFilesystem: true,
        includeChannelSecurity: true,
      }),
    );
  });

  it("surfaces unknown usage when totalTokens is missing", async () => {
    await withUnknownUsageStore(async () => {
      runtimeLogMock.mockClear();
      await statusCommand({ json: true }, runtime as never);
      const payload = JSON.parse(String(runtimeLogMock.mock.calls.at(-1)?.[0]));
      expect(payload.sessions.recent[0].totalTokens).toBeNull();
      expect(payload.sessions.recent[0].totalTokensFresh).toBe(false);
      expect(payload.sessions.recent[0].percentUsed).toBeNull();
      expect(payload.sessions.recent[0].remainingTokens).toBeNull();
    });
  });

  it("surfaces stale usage when totalTokens is preserved but not fresh", async () => {
    mocks.loadSessionStore.mockReturnValue({
      "+1000": {
        updatedAt: Date.now() - 60_000,
        totalTokens: 5_000,
        totalTokensFresh: false,
        contextTokens: 10_000,
        model: "pi:opus",
      },
    });
    runtimeLogMock.mockClear();
    await statusCommand({ json: true }, runtime as never);
    const payload = JSON.parse(String(runtimeLogMock.mock.calls.at(-1)?.[0]));
    expect(payload.sessions.recent[0].totalTokens).toBe(5000);
    expect(payload.sessions.recent[0].totalTokensFresh).toBe(false);
    expect(payload.sessions.recent[0].percentUsed).toBe(50);
    expect(payload.sessions.recent[0].remainingTokens).toBe(5000);
  });

  it("prints formatted lines with verbose cache details", async () => {
    mocks.buildPluginCompatibilityNotices.mockReturnValue([
      createCompatibilityNotice({ pluginId: "legacy-plugin", code: "legacy-before-agent-start" }),
    ]);
    const logs = await runStatusAndGetLogs({ verbose: true });
    for (const token of [
      "OpenClaw status",
      "Overview",
      "Security audit",
      "Summary:",
      "CRITICAL",
      "Dashboard",
      "macos 14.0 (arm64)",
      "Memory",
      "Plugin compatibility",
      "Channels",
      "WhatsApp",
      "bootstrap files",
      "Tasks",
      "Sessions",
      "+1000",
      "50%",
      "40% cached",
      "LaunchAgent",
      "FAQ:",
      "Troubleshooting:",
      "Next steps:",
    ]) {
      expect(logs.some((line) => line.includes(token))).toBe(true);
    }
    expect(
      logs.some((line) => line.includes("legacy-plugin still uses legacy before_agent_start")),
    ).toBe(true);
    expect(
      logs.some(
        (line) =>
          line.includes("openclaw status --all") ||
          line.includes("openclaw --profile isolated status --all"),
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes("Cache"))).toBe(true);
    expect(logs.some((line) => line.includes("40% hit"))).toBe(true);
    expect(logs.some((line) => line.includes("read 2.0k"))).toBe(true);
  });

  it("shows a maintenance hint when task audit errors are present", async () => {
    mocks.getInspectableTaskRegistrySummary.mockReturnValue({
      total: 1,
      active: 1,
      terminal: 0,
      failures: 1,
      byStatus: {
        queued: 0,
        running: 1,
        succeeded: 0,
        failed: 0,
        timed_out: 0,
        cancelled: 0,
        lost: 0,
      },
      byRuntime: {
        subagent: 0,
        acp: 1,
        cli: 0,
        cron: 0,
      },
    });
    mocks.getInspectableTaskAuditSummary.mockReturnValue({
      total: 1,
      warnings: 0,
      errors: 1,
      byCode: {
        stale_queued: 0,
        stale_running: 1,
        lost: 0,
        delivery_failed: 0,
        missing_cleanup: 0,
        inconsistent_timestamps: 0,
      },
    });

    const joined = await runStatusAndGetJoinedLogs();

    expect(joined).toContain("tasks maintenance --apply");
  });

  it("uses prompt-side denominator for cached percentages", async () => {
    mocks.loadSessionStore.mockReturnValue({
      "+1000": {
        ...createDefaultSessionStoreEntry(),
        inputTokens: undefined,
        cacheRead: 1_200,
        cacheWrite: 0,
        totalTokens: 1_000,
      },
    });
    const logs = await runStatusAndGetLogs();
    expect(logs.some((line) => line.includes("100% cached"))).toBe(true);
    expect(logs.some((line) => line.includes("120% cached"))).toBe(false);

    mocks.loadSessionStore.mockReturnValue({
      "+1000": {
        ...createDefaultSessionStoreEntry(),
        inputTokens: 500,
        cacheRead: 2_000,
        cacheWrite: 500,
        totalTokens: 5_000,
      },
    });
    const promptSideLogs = await runStatusAndGetLogs();
    expect(promptSideLogs.some((line) => line.includes("67% cached"))).toBe(true);
    expect(promptSideLogs.some((line) => line.includes("40% cached"))).toBe(false);
  });

  it("shows node-only gateway info when no local gateway service is installed", async () => {
    mocks.resolveGatewayService.mockReturnValueOnce({
      label: "LaunchAgent",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      stage: async () => {},
      install: async () => {},
      uninstall: async () => {},
      stop: async () => {},
      restart: async () => ({ outcome: "completed" as const }),
      isLoaded: async () => false,
      readRuntime: async () => undefined,
      readCommand: async () => null,
    });
    mocks.loadNodeHostConfig.mockResolvedValueOnce({
      version: 1,
      nodeId: "node-1",
      gateway: { host: "gateway.example.com", port: 19000 },
    });

    const joined = await runStatusAndGetJoinedLogs();
    expect(joined).toContain("node → gateway.example.com:19000 · no local gateway");
    expect(joined).not.toContain("Gateway: local · ws://127.0.0.1:18789");
    expect(joined).toContain("openclaw --profile isolated node status");
    expect(joined).not.toContain("Fix reachability first");
  });

  it("shows gateway auth when reachable", async () => {
    mocks.loadConfig.mockReturnValue({
      session: {},
      channels: { whatsapp: { allowFrom: ["*"] } },
    });
    await withEnvVar("OPENCLAW_GATEWAY_TOKEN", "abcd1234", async () => {
      mockProbeGatewayResult({
        ok: true,
        connectLatencyMs: 123,
        error: null,
        health: {},
        status: {},
        presence: [],
      });
      const logs = await runStatusAndGetLogs();
      expect(logs.some((l: string) => l.includes("auth token"))).toBe(true);
    });
  });

  it("warns instead of crashing when gateway auth SecretRef is unresolved for probe auth", async () => {
    mocks.loadConfig.mockReturnValue({
      session: {},
      channels: { whatsapp: { allowFrom: ["*"] } },
      gateway: {
        auth: {
          mode: "token",
          token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    });

    await statusCommand({ json: true }, runtime as never);
    const payload = JSON.parse(String(runtimeLogMock.mock.calls.at(-1)?.[0]));
    expect(payload.gateway.error ?? payload.gateway.authWarning ?? null).not.toBeNull();
    if (Array.isArray(payload.secretDiagnostics) && payload.secretDiagnostics.length > 0) {
      expect(
        payload.secretDiagnostics.some((entry: string) => entry.includes("gateway.auth.token")),
      ).toBe(true);
    }
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("surfaces channel runtime errors from the gateway", async () => {
    mocks.loadConfig.mockReturnValue({
      session: {},
      channels: { whatsapp: { allowFrom: ["*"] } },
    });
    mockProbeGatewayResult({
      ok: true,
      connectLatencyMs: 10,
      error: null,
      health: {},
      status: {},
      presence: [],
    });
    mocks.callGateway.mockResolvedValueOnce({
      channelAccounts: {
        signal: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: false,
            lastError: "signal-cli unreachable",
          },
        ],
        imessage: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            running: false,
            lastError: "imessage permission denied",
          },
        ],
      },
    });

    const joined = await runStatusAndGetJoinedLogs();
    expect(joined).toMatch(/Signal/i);
    expect(joined).toMatch(/iMessage/i);
    expect(joined).toMatch(/gateway:/i);
    expect(joined).toMatch(/WARN/);
  });

  it("prints safe gateway pairing recovery guidance", async () => {
    expect(
      resolvePairingRecoveryContext({
        error: "connect failed: pairing required (requestId: req-123)",
        closeReason: "pairing required (requestId: req-123)",
      }),
    ).toEqual({ requestId: "req-123" });
    expect(
      resolvePairingRecoveryContext({
        error: "connect failed: pairing required",
        closeReason: "connect failed",
      }),
    ).toEqual({ requestId: null });
    expect(
      resolvePairingRecoveryContext({
        error: "connect failed: pairing required (requestId: req-123;rm -rf /)",
        closeReason: "pairing required (requestId: req-123;rm -rf /)",
      }),
    ).toEqual({ requestId: null });
    expect(
      resolvePairingRecoveryContext({
        error: "connect failed: pairing required",
        closeReason: "pairing required (requestId: req-close-456)",
      }),
    ).toEqual({ requestId: "req-close-456" });

    mocks.loadConfig.mockReturnValue({
      session: {},
      channels: { whatsapp: { allowFrom: ["*"] } },
    });
    mockProbeGatewayResult({
      error: "connect failed: pairing required (requestId: req-123)",
      close: { code: 1008, reason: "pairing required (requestId: req-123)" },
    });
    const joined = await runStatusAndGetJoinedLogs();
    expect(joined).toContain("Gateway pairing approval required.");
    expect(joined).toContain("devices approve req-123");
    expect(joined).toContain("devices approve --latest");
    expect(joined).toContain("devices list");
  });

  it("includes sessions across agents in JSON output", async () => {
    const originalAgents = mocks.listGatewayAgentsBasic.getMockImplementation();
    const originalResolveStorePath = mocks.resolveStorePath.getMockImplementation();
    const originalLoadSessionStore = mocks.loadSessionStore.getMockImplementation();

    mocks.listGatewayAgentsBasic.mockReturnValue({
      defaultId: "main",
      mainKey: "agent:main:main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "Main" },
        { id: "ops", name: "Ops" },
      ],
    });
    mocks.resolveStorePath.mockImplementation((_store, opts) =>
      opts?.agentId === "ops" ? "/tmp/ops.json" : "/tmp/main.json",
    );
    mocks.loadSessionStore.mockImplementation((storePath) => {
      if (storePath === "/tmp/ops.json") {
        return {
          "agent:ops:main": {
            updatedAt: Date.now() - 120_000,
            inputTokens: 1_000,
            outputTokens: 1_000,
            totalTokens: 2_000,
            contextTokens: 10_000,
            model: "pi:opus",
          },
        };
      }
      return {
        "+1000": createDefaultSessionStoreEntry(),
      };
    });

    await statusCommand({ json: true }, runtime as never);
    const payload = JSON.parse(String(runtimeLogMock.mock.calls.at(-1)?.[0]));
    expect(payload.sessions.count).toBe(2);
    expect(payload.sessions.paths.length).toBe(2);
    expect(
      payload.sessions.recent.some((sess: { key?: string }) => sess.key === "agent:ops:main"),
    ).toBe(true);

    if (originalAgents) {
      mocks.listGatewayAgentsBasic.mockImplementation(originalAgents);
    }
    if (originalResolveStorePath) {
      mocks.resolveStorePath.mockImplementation(originalResolveStorePath);
    }
    if (originalLoadSessionStore) {
      mocks.loadSessionStore.mockImplementation(originalLoadSessionStore);
    }
  });
});
