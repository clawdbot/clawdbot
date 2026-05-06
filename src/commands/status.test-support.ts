import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import { isBetaTag } from "../infra/update-channels.js";
import type { Tone } from "../memory-host-sdk/status.js";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import { VERSION } from "../version.js";
import type { buildStatusCommandOverviewRows } from "./status-overview-rows.ts";
import type { StatusOverviewSurface } from "./status-overview-surface.ts";
import type { AgentLocalStatus } from "./status.agent-local.js";
import type { buildStatusCommandReportData } from "./status.command-report-data.ts";
import type { MemoryPluginStatus, MemoryStatusSnapshot } from "./status.scan.shared.js";
import type { StatusSummary } from "./status.types.js";

type StatusCommandOverviewRowsParams = Parameters<typeof buildStatusCommandOverviewRows>[0];
type StatusCommandReportDataParams = Parameters<typeof buildStatusCommandReportData>[0];

export const baseStatusCfg = {
  update: { channel: "stable" },
  gateway: { bind: "loopback" },
} as const;

export const baseStatusUpdate = {
  installKind: "git",
  git: {
    branch: "main",
    tag: "v1.2.3",
    upstream: "origin/main",
    behind: 2,
    ahead: 0,
    dirty: false,
    fetchOk: true,
  },
  registry: { latestVersion: "2026.4.10" },
} as never;

export const baseStatusExpectedUpdateChannelInfo = isBetaTag(VERSION)
  ? {
      channel: "beta",
      source: "installed-version",
      label: "beta (installed version)",
    }
  : {
      channel: "stable",
      source: "config",
      label: "stable (config)",
    };

export const baseStatusExpectedUpdateChannelLabel = baseStatusExpectedUpdateChannelInfo.label;

export const baseStatusGatewaySnapshot = {
  gatewayMode: "remote",
  remoteUrlMissing: false,
  gatewayConnection: {
    url: "wss://gateway.example.com",
    urlSource: "config",
    message: "Gateway target: wss://gateway.example.com",
  },
  gatewayReachable: true,
  gatewayProbe: { connectLatencyMs: 42, error: null } as never,
  gatewayProbeAuth: { token: "tok" },
  gatewayProbeAuthWarning: "warn-text",
  gatewaySelf: { host: "gateway", version: "1.2.3" },
} as const;

export const baseStatusOverviewScanFields = {
  cfg: baseStatusCfg,
  update: baseStatusUpdate,
  tailscaleMode: "serve",
  tailscaleDns: "box.tail.ts.net",
  tailscaleHttpsUrl: "https://box.tail.ts.net",
  ...baseStatusGatewaySnapshot,
};

const baseStatusGatewayService = {
  label: "LaunchAgent",
  installed: true,
  managedByOpenClaw: true,
  loadedText: "loaded",
  runtimeShort: "running",
};

const baseStatusNodeService = {
  label: "node",
  installed: true,
  loadedText: "loaded",
  runtime: { status: "running", pid: 42 },
};

export const baseStatusServices = {
  gatewayService: baseStatusGatewayService,
  nodeService: baseStatusNodeService,
  nodeOnlyGateway: null,
};

export const baseStatusOverviewSurface = {
  ...baseStatusOverviewScanFields,
  ...baseStatusServices,
} as unknown as StatusOverviewSurface;

const baseStatusSummary = {
  tasks: { total: 3, active: 1, failures: 0, byStatus: { queued: 1, running: 1 } },
  taskAudit: { errors: 1, warnings: 0 },
  heartbeat: {
    defaultAgentId: "main",
    agents: [{ agentId: "main", enabled: true, everyMs: 60_000, every: "1m" }],
  },
  channelSummary: [],
  queuedSystemEvents: ["one", "two"],
  sessions: {
    count: 2,
    paths: ["store.json"],
    defaults: { model: "gpt-5.5", contextTokens: 12_000 },
    recent: [
      {
        key: "session-key",
        kind: "direct",
        updatedAt: 1,
        age: 5_000,
        model: "gpt-5.5",
        runtime: "OpenClaw Pi Default",
        totalTokens: 12_000,
        totalTokensFresh: true,
        remainingTokens: 4_000,
        percentUsed: 75,
        contextTokens: 16_000,
        flags: [],
      },
    ],
    byAgent: [],
  },
} as unknown as StatusSummary;

const baseStatusAgentStatus = {
  defaultId: "main",
  bootstrapPendingCount: 1,
  totalSessions: 2,
  agents: [{ id: "main", lastActiveAgeMs: 60_000 }] as AgentLocalStatus[],
};

const baseStatusMemory = {
  agentId: "main",
  files: 1,
  chunks: 2,
  vector: {},
  fts: {},
  cache: {},
} as unknown as MemoryStatusSnapshot;

const baseStatusMemoryPlugin = {
  enabled: true,
  slot: "memory",
} as const satisfies MemoryPluginStatus;

const baseStatusPluginCompatibility = [
  { pluginId: "a", severity: "warn", message: "legacy" },
] as PluginCompatibilityNotice[];

function createStatusLastHeartbeat(): HeartbeatEventPayload {
  return {
    ts: Date.now() - 30_000,
    status: "ok-token",
    channel: "quietchat",
    accountId: "acct",
  };
}

function createStatusHealth() {
  return {
    ok: true as const,
    ts: Date.now(),
    durationMs: 42,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    heartbeatSeconds: 60,
    defaultAgentId: "main",
    agents: [],
    sessions: {
      path: "store.json",
      count: 2,
      recent: [{ key: "session-key", updatedAt: 1, age: 5_000 }],
    },
  };
}

const statusTestDecorators = {
  ok: (value: string) => `ok(${value})`,
  warn: (value: string) => `warn(${value})`,
  muted: (value: string) => `muted(${value})`,
  accentDim: (value: string) => `accent(${value})`,
};

const statusTestFormatting = {
  shortenText: (value: string) => value,
  formatCliCommand: (value: string) => `cmd:${value}`,
  formatTimeAgo: (value: number) => `${value}ms`,
  formatKTokens: (value: number) => `${Math.round(value / 1000)}k`,
  formatTokensCompact: () => "12k",
  formatPromptCacheCompact: () => "cache ok",
  formatHealthChannelLines: () => ["QuietChat: OK · ready"],
  formatPluginCompatibilityNotice: (notice: { message?: unknown }) => String(notice.message),
  formatUpdateAvailableHint: () => "update available",
};

const statusTestMemoryResolvers = {
  resolveMemoryVectorState: () => ({ state: "ready", tone: "ok" as Tone }),
  resolveMemoryFtsState: () => ({ state: "ready", tone: "warn" as Tone }),
  resolveMemoryCacheSummary: () => ({ text: "cache warm", tone: "muted" as Tone }),
};

const statusTestTheme = {
  heading: (value: string) => `# ${value}`,
  muted: (value: string) => `muted(${value})`,
  warn: (value: string) => `warn(${value})`,
  error: (value: string) => `error(${value})`,
};

export function createStatusCommandOverviewRowsParams(
  overrides: Partial<StatusCommandOverviewRowsParams> = {},
): StatusCommandOverviewRowsParams {
  return {
    opts: { deep: true },
    surface: baseStatusOverviewSurface,
    osLabel: "macOS",
    summary: baseStatusSummary,
    health: createStatusHealth(),
    lastHeartbeat: createStatusLastHeartbeat(),
    agentStatus: baseStatusAgentStatus,
    memory: baseStatusMemory,
    memoryPlugin: baseStatusMemoryPlugin,
    pluginCompatibility: baseStatusPluginCompatibility,
    ...statusTestDecorators,
    ...statusTestFormatting,
    ...statusTestMemoryResolvers,
    updateValue: "available · custom update",
    ...overrides,
  };
}

export function createStatusCommandReportDataParams(
  overrides: Partial<StatusCommandReportDataParams> = {},
): StatusCommandReportDataParams {
  return {
    opts: { deep: true, verbose: true },
    surface: baseStatusOverviewSurface,
    osSummary: { label: "macOS" } as never,
    summary: baseStatusSummary,
    securityAudit: {
      ts: Date.now(),
      summary: { critical: 0, warn: 1, info: 0 },
      findings: [
        {
          checkId: "warn-first",
          severity: "warn",
          title: "Warn first",
          detail: "warn detail",
        },
      ],
    },
    health: createStatusHealth(),
    usageLines: ["usage line"],
    lastHeartbeat: createStatusLastHeartbeat(),
    agentStatus: baseStatusAgentStatus,
    channels: {
      rows: [{ id: "quietchat", label: "QuietChat", enabled: true, state: "ok", detail: "ready" }],
    },
    channelIssues: [{ channel: "quietchat", message: "warn msg" }],
    memory: baseStatusMemory,
    memoryPlugin: baseStatusMemoryPlugin,
    pluginCompatibility: baseStatusPluginCompatibility,
    pairingRecovery: { requestId: "req-1", reason: null, remediationHint: null },
    tableWidth: 120,
    ...statusTestDecorators,
    ...statusTestFormatting,
    ...statusTestMemoryResolvers,
    theme: statusTestTheme,
    renderTable: ({ rows }: { rows: Array<Record<string, string>> }) => `table:${rows.length}`,
    updateValue: "available · custom update",
    ...overrides,
  };
}
