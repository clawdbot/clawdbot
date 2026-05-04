import {
  buildPairingConnectRecoveryTitle,
  describePairingConnectRequirement,
  type ConnectPairingRequiredReason,
} from "../gateway/protocol/connect-error-details.js";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import type { Tone } from "../memory-host-sdk/status.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { TableColumn } from "../terminal/table.js";
import type { HealthSummary } from "./health.js";
import type { AgentLocalStatus } from "./status.agent-local.js";
import type { MemoryStatusSnapshot, MemoryPluginStatus } from "./status.scan.shared.js";
import type { SessionStatus, StatusSummary } from "./status.types.js";

type AgentStatusLike = {
  defaultId?: string | null;
  bootstrapPendingCount: number;
  totalSessions: number;
  agents: AgentLocalStatus[];
};

type SummaryLike = Pick<StatusSummary, "tasks" | "taskAudit" | "heartbeat" | "sessions">;
type MemoryLike = MemoryStatusSnapshot | null;
type MemoryPluginLike = MemoryPluginStatus;
type SessionsRecentLike = SessionStatus;
type EventLoopHealthLike = NonNullable<HealthSummary["eventLoop"]>;

export type StatusMemoryStateResolvers = {
  resolveMemoryVectorState: (value: NonNullable<MemoryStatusSnapshot["vector"]>) => {
    state: string;
    tone: Tone;
  };
  resolveMemoryFtsState: (value: NonNullable<MemoryStatusSnapshot["fts"]>) => {
    state: string;
    tone: Tone;
  };
  resolveMemoryCacheSummary: (value: NonNullable<MemoryStatusSnapshot["cache"]>) => {
    text: string;
    tone: Tone;
  };
};

type PluginCompatibilityNoticeLike = {
  severity?: "warn" | "info" | null;
};

type PairingRecoveryLike = {
  requestId?: string | null;
  reason?: ConnectPairingRequiredReason | null;
  remediationHint?: string | null;
};

export const statusHealthColumns: TableColumn[] = [
  { key: "Item", header: "Item", minWidth: 10 },
  { key: "Status", header: "Status", minWidth: 8 },
  { key: "Detail", header: "Detail", flex: true, minWidth: 28 },
];

export function buildStatusAgentsValue(params: {
  agentStatus: AgentStatusLike;
  formatTimeAgo: (ageMs: number) => string;
}) {
  const pending =
    params.agentStatus.bootstrapPendingCount > 0
      ? `${params.agentStatus.bootstrapPendingCount} bootstrap file${params.agentStatus.bootstrapPendingCount === 1 ? "" : "s"} present`
      : "no bootstrap files";
  const def = params.agentStatus.agents.find((a) => a.id === params.agentStatus.defaultId);
  const defActive =
    def?.lastActiveAgeMs != null ? params.formatTimeAgo(def.lastActiveAgeMs) : "unknown";
  const defSuffix = def ? ` · default ${def.id} active ${defActive}` : "";
  return `${params.agentStatus.agents.length} · ${pending} · sessions ${params.agentStatus.totalSessions}${defSuffix}`;
}

export function buildStatusTasksValue(params: {
  summary: Pick<SummaryLike, "tasks" | "taskAudit">;
  warn: (value: string) => string;
  muted: (value: string) => string;
}) {
  if (params.summary.tasks.total <= 0) {
    return params.muted("none");
  }
  return [
    `${params.summary.tasks.active} active`,
    `${params.summary.tasks.byStatus.queued} queued`,
    `${params.summary.tasks.byStatus.running} running`,
    params.summary.tasks.failures > 0
      ? params.warn(
          `${params.summary.tasks.failures} issue${params.summary.tasks.failures === 1 ? "" : "s"}`,
        )
      : params.muted("no issues"),
    params.summary.taskAudit.errors > 0
      ? params.warn(
          `audit ${params.summary.taskAudit.errors} error${params.summary.taskAudit.errors === 1 ? "" : "s"} · ${params.summary.taskAudit.warnings} warn`,
        )
      : params.summary.taskAudit.warnings > 0
        ? params.muted(`audit ${params.summary.taskAudit.warnings} warn`)
        : params.muted("audit clean"),
    `${params.summary.tasks.total} tracked`,
  ].join(" · ");
}

export function buildStatusHeartbeatValue(params: { summary: Pick<SummaryLike, "heartbeat"> }) {
  const parts = params.summary.heartbeat.agents
    .map((agent) => {
      if (!agent.enabled || !agent.everyMs) {
        return `disabled (${agent.agentId})`;
      }
      return `${agent.every} (${agent.agentId})`;
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "disabled";
}

export function buildStatusLastHeartbeatValue(params: {
  deep?: boolean;
  gatewayReachable: boolean;
  lastHeartbeat: HeartbeatEventPayload | null;
  warn: (value: string) => string;
  muted: (value: string) => string;
  formatTimeAgo: (ageMs: number) => string;
}) {
  if (!params.deep) {
    return null;
  }
  if (!params.gatewayReachable) {
    return params.warn("unavailable");
  }
  if (!params.lastHeartbeat) {
    return params.muted("none");
  }
  const age = params.formatTimeAgo(Date.now() - params.lastHeartbeat.ts);
  const channel = params.lastHeartbeat.channel ?? "unknown";
  const accountLabel = params.lastHeartbeat.accountId
    ? `account ${params.lastHeartbeat.accountId}`
    : null;
  return [params.lastHeartbeat.status, `${age} ago`, channel, accountLabel]
    .filter(Boolean)
    .join(" · ");
}

export function buildStatusMemoryValue(
  params: {
    memory: MemoryLike;
    memoryPlugin: MemoryPluginLike;
    ok: (value: string) => string;
    warn: (value: string) => string;
    muted: (value: string) => string;
    memoryUnavailableLabel?: string;
  } & StatusMemoryStateResolvers,
) {
  if (!params.memoryPlugin.enabled) {
    const suffix = params.memoryPlugin.reason ? ` (${params.memoryPlugin.reason})` : "";
    return params.muted(`disabled${suffix}`);
  }
  if (!params.memory) {
    const slot = params.memoryPlugin.slot ? `plugin ${params.memoryPlugin.slot}` : "plugin";
    return params.muted(`enabled (${slot}) · ${params.memoryUnavailableLabel ?? "unavailable"}`);
  }
  const parts: string[] = [];
  const dirtySuffix = params.memory.dirty ? ` · ${params.warn("dirty")}` : "";
  parts.push(`${params.memory.files} files · ${params.memory.chunks} chunks${dirtySuffix}`);
  if (params.memory.sources?.length) {
    parts.push(`sources ${params.memory.sources.join(", ")}`);
  }
  if (params.memoryPlugin.slot) {
    parts.push(`plugin ${params.memoryPlugin.slot}`);
  }
  const colorByTone = (tone: Tone, text: string) =>
    tone === "ok" ? params.ok(text) : tone === "warn" ? params.warn(text) : params.muted(text);
  if (params.memory.vector) {
    const vector =
      params.memory.backend === "builtin" && params.memory.vector.storeAvailable !== undefined
        ? { ...params.memory.vector, available: params.memory.vector.storeAvailable }
        : params.memory.vector;
    const state = params.resolveMemoryVectorState(vector);
    const prefix = params.memory.backend === "builtin" ? "vector store" : "vector";
    const label = state.state === "disabled" ? `${prefix} off` : `${prefix} ${state.state}`;
    parts.push(colorByTone(state.tone, label));
  }
  if (params.memory.fts) {
    const state = params.resolveMemoryFtsState(params.memory.fts);
    const label = state.state === "disabled" ? "fts off" : `fts ${state.state}`;
    parts.push(colorByTone(state.tone, label));
  }
  if (params.memory.cache) {
    const summary = params.resolveMemoryCacheSummary(params.memory.cache);
    parts.push(colorByTone(summary.tone, summary.text));
  }
  return parts.join(" · ");
}

export function buildStatusSecurityAuditLines(params: {
  securityAudit: {
    summary: { critical: number; warn: number; info: number };
    findings: Array<{
      severity: "critical" | "warn" | "info";
      title: string;
      detail: string;
      remediation?: string | null;
    }>;
  };
  theme: {
    error: (value: string) => string;
    warn: (value: string) => string;
    muted: (value: string) => string;
  };
  shortenText: (value: string, maxLen: number) => string;
  formatCliCommand: (value: string) => string;
}) {
  const fmtSummary = (value: { critical: number; warn: number; info: number }) => {
    return [
      params.theme.error(`${value.critical} critical`),
      params.theme.warn(`${value.warn} warn`),
      params.theme.muted(`${value.info} info`),
    ].join(" · ");
  };
  const lines = [params.theme.muted(`Summary: ${fmtSummary(params.securityAudit.summary)}`)];
  const importantFindings = params.securityAudit.findings.filter(
    (f) => f.severity === "critical" || f.severity === "warn",
  );
  if (importantFindings.length === 0) {
    lines.push(params.theme.muted("No critical or warn findings detected."));
  } else {
    const severityLabel = (sev: "critical" | "warn" | "info") =>
      sev === "critical"
        ? params.theme.error("CRITICAL")
        : sev === "warn"
          ? params.theme.warn("WARN")
          : params.theme.muted("INFO");
    const sevRank = (sev: "critical" | "warn" | "info") =>
      sev === "critical" ? 0 : sev === "warn" ? 1 : 2;
    const shown = [...importantFindings]
      .toSorted((a, b) => sevRank(a.severity) - sevRank(b.severity))
      .slice(0, 6);
    for (const finding of shown) {
      lines.push(`  ${severityLabel(finding.severity)} ${finding.title}`);
      lines.push(`    ${params.shortenText(finding.detail.replaceAll("\n", " "), 160)}`);
      if (finding.remediation?.trim()) {
        lines.push(`    ${params.theme.muted(`Fix: ${finding.remediation.trim()}`)}`);
      }
    }
    if (importantFindings.length > shown.length) {
      lines.push(params.theme.muted(`… +${importantFindings.length - shown.length} more`));
    }
  }
  lines.push(
    params.theme.muted(`Full report: ${params.formatCliCommand("openclaw security audit")}`),
  );
  lines.push(
    params.theme.muted(`Deep probe: ${params.formatCliCommand("openclaw security audit --deep")}`),
  );
  return lines;
}

export function buildStatusHealthRows(params: {
  health: HealthSummary;
  formatHealthChannelLines: (summary: HealthSummary, opts: { accountMode: "all" }) => string[];
  ok: (value: string) => string;
  warn: (value: string) => string;
  muted: (value: string) => string;
}) {
  const rows: Array<Record<string, string>> = [
    {
      Item: "Gateway",
      Status: params.ok("reachable"),
      Detail: `${params.health.durationMs}ms`,
    },
  ];
  if (params.health.eventLoop) {
    rows.push({
      Item: "Event loop",
      Status: params.health.eventLoop.degraded ? params.warn("WARN") : params.ok("OK"),
      Detail: formatEventLoopHealthDetail(params.health.eventLoop),
    });
  }
  for (const line of params.formatHealthChannelLines(params.health, { accountMode: "all" })) {
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const item = line.slice(0, colon).trim();
    const detail = line.slice(colon + 1).trim();
    const normalized = normalizeLowercaseStringOrEmpty(detail);
    const status = normalized.startsWith("ok")
      ? params.ok("OK")
      : normalized.startsWith("failed")
        ? params.warn("WARN")
        : normalized.startsWith("not configured")
          ? params.muted("OFF")
          : normalized.startsWith("configured")
            ? params.ok("OK")
            : normalized.startsWith("linked")
              ? params.ok("LINKED")
              : normalized.startsWith("not linked")
                ? params.warn("UNLINKED")
                : params.warn("WARN");
    rows.push({ Item: item, Status: status, Detail: detail });
  }
  return rows;
}

export function formatEventLoopHealthDetail(eventLoop: EventLoopHealthLike): string {
  const parts = [
    eventLoop.reasons.length > 0 ? `reasons ${eventLoop.reasons.join(",")}` : "healthy",
    `max ${Math.round(eventLoop.delayMaxMs)}ms`,
    `p99 ${Math.round(eventLoop.delayP99Ms)}ms`,
    `util ${eventLoop.utilization}`,
    `cpu ${eventLoop.cpuCoreRatio}`,
  ];
  return parts.join(" · ");
}

export function buildStatusSessionsRows(params: {
  recent: SessionsRecentLike[];
  verbose?: boolean;
  shortenText: (value: string, maxLen: number) => string;
  formatTimeAgo: (ageMs: number) => string;
  formatTokensCompact: (value: SessionsRecentLike) => string;
  formatPromptCacheCompact: (value: SessionsRecentLike) => string | null;
  muted: (value: string) => string;
}) {
  if (params.recent.length === 0) {
    return [
      {
        Key: params.muted("no sessions yet"),
        Kind: "",
        Age: "",
        Model: "",
        Tokens: "",
        ...(params.verbose ? { Cache: "" } : {}),
      },
    ];
  }
  return params.recent.map((sess) => ({
    Key: params.shortenText(sess.key, 32),
    Kind: sess.kind,
    Age: sess.updatedAt && sess.age != null ? params.formatTimeAgo(sess.age) : "no activity",
    Model: sess.model ?? "unknown",
    Tokens: params.formatTokensCompact(sess),
    ...(params.verbose
      ? { Cache: params.formatPromptCacheCompact(sess) || params.muted("—") }
      : {}),
  }));
}

export function buildStatusFooterLines(params: {
  updateHint: string | null;
  warn: (value: string) => string;
  formatCliCommand: (value: string) => string;
  nodeOnlyGateway: unknown;
  gatewayReachable: boolean;
}) {
  return [
    "FAQ: https://docs.openclaw.ai/faq",
    "Troubleshooting: https://docs.openclaw.ai/troubleshooting",
    ...(params.updateHint ? ["", params.warn(params.updateHint)] : []),
    "Next steps:",
    `  Need to share?      ${params.formatCliCommand("openclaw status --all")}`,
    `  Need to debug live? ${params.formatCliCommand("openclaw logs --follow")}`,
    params.nodeOnlyGateway
      ? `  Need node service?  ${params.formatCliCommand("openclaw node status")}`
      : params.gatewayReachable
        ? `  Need to test channels? ${params.formatCliCommand("openclaw status --deep")}`
        : `  Fix reachability first: ${params.formatCliCommand("openclaw gateway probe")}`,
  ];
}

export function buildStatusPluginCompatibilityLines<
  TNotice extends PluginCompatibilityNoticeLike,
>(params: {
  notices: TNotice[];
  limit?: number;
  formatNotice: (notice: TNotice) => string;
  warn: (value: string) => string;
  muted: (value: string) => string;
}) {
  if (params.notices.length === 0) {
    return [];
  }
  const limit = params.limit ?? 8;
  return [
    ...params.notices.slice(0, limit).map((notice) => {
      const label = notice.severity === "warn" ? params.warn("WARN") : params.muted("INFO");
      return `  ${label} ${params.formatNotice(notice)}`;
    }),
    ...(params.notices.length > limit
      ? [params.muted(`  … +${params.notices.length - limit} more`)]
      : []),
  ];
}

export function buildStatusPairingRecoveryLines(params: {
  pairingRecovery: PairingRecoveryLike | null;
  warn: (value: string) => string;
  muted: (value: string) => string;
  formatCliCommand: (value: string) => string;
}) {
  if (!params.pairingRecovery) {
    return [];
  }
  return [
    params.warn(buildPairingConnectRecoveryTitle(params.pairingRecovery.reason ?? undefined)),
    ...(params.pairingRecovery.reason
      ? [
          params.muted(
            `Reason: ${describePairingConnectRequirement(params.pairingRecovery.reason)}.`,
          ),
        ]
      : []),
    ...(params.pairingRecovery.remediationHint
      ? [params.muted(`Hint: ${params.pairingRecovery.remediationHint}`)]
      : []),
    ...(params.pairingRecovery.requestId
      ? [
          params.muted(
            `Recovery: ${params.formatCliCommand(`openclaw devices approve ${params.pairingRecovery.requestId}`)}`,
          ),
        ]
      : []),
    params.muted(`Fallback: ${params.formatCliCommand("openclaw devices approve --latest")}`),
    params.muted(`Inspect: ${params.formatCliCommand("openclaw devices list")}`),
  ];
}

export function buildStatusSystemEventsRows(params: {
  queuedSystemEvents: string[];
  limit?: number;
}) {
  const limit = params.limit ?? 5;
  if (params.queuedSystemEvents.length === 0) {
    return undefined;
  }
  return params.queuedSystemEvents.slice(0, limit).map((event) => ({ Event: event }));
}

export function buildStatusSystemEventsTrailer(params: {
  queuedSystemEvents: string[];
  limit?: number;
  muted: (value: string) => string;
}) {
  const limit = params.limit ?? 5;
  return params.queuedSystemEvents.length > limit
    ? params.muted(`… +${params.queuedSystemEvents.length - limit} more`)
    : null;
}
