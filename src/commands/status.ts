import fs from "node:fs/promises";
import path from "node:path";

import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { lookupContextTokens } from "../agents/context.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import { withProgress } from "../cli/progress.js";
import {
  loadConfig,
  readConfigFileSnapshot,
  resolveGatewayPort,
} from "../config/config.js";
import {
  loadSessionStore,
  resolveMainSessionKey,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import { readLastGatewayErrorLine } from "../daemon/diagnostics.js";
import { resolveGatewayService } from "../daemon/service.js";
import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import { probeGateway } from "../gateway/probe.js";
import { listAgentsForGateway } from "../gateway/session-utils.js";
import { info } from "../globals.js";
import { resolveClawdbotPackageRoot } from "../infra/clawdbot-root.js";
import { resolveOsSummary } from "../infra/os-summary.js";
import { formatPortDiagnostics, inspectPortUsage } from "../infra/ports.js";
import { buildProviderSummary } from "../infra/provider-summary.js";
import {
  formatUsageReportLines,
  loadProviderUsageSummary,
} from "../infra/provider-usage.js";
import { collectProvidersStatusIssues } from "../infra/providers-status-issues.js";
import {
  readRestartSentinel,
  summarizeRestartSentinel,
} from "../infra/restart-sentinel.js";
import { peekSystemEvents } from "../infra/system-events.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
  type UpdateCheckResult,
} from "../infra/update-check.js";
import type { RuntimeEnv } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { VERSION } from "../version.js";
import { resolveWhatsAppAccount } from "../web/accounts.js";
import { resolveHeartbeatSeconds } from "../web/reconnect.js";
import {
  getWebAuthAgeMs,
  logWebSelfId,
  webAuthExists,
} from "../web/session.js";
import type { HealthSummary } from "./health.js";
import { resolveControlUiLinks } from "./onboard-helpers.js";
import { statusAllCommand } from "./status-all.js";

export type SessionStatus = {
  key: string;
  kind: "direct" | "group" | "global" | "unknown";
  sessionId?: string;
  updatedAt: number | null;
  age: number | null;
  thinkingLevel?: string;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens: number | null;
  remainingTokens: number | null;
  percentUsed: number | null;
  model: string | null;
  contextTokens: number | null;
  flags: string[];
};

export type StatusSummary = {
  web: { linked: boolean; authAgeMs: number | null };
  heartbeatSeconds: number;
  providerSummary: string[];
  queuedSystemEvents: string[];
  sessions: {
    path: string;
    count: number;
    defaults: { model: string | null; contextTokens: number | null };
    recent: SessionStatus[];
  };
};

export async function getStatusSummary(): Promise<StatusSummary> {
  const cfg = loadConfig();
  const account = resolveWhatsAppAccount({ cfg });
  const linked = await webAuthExists(account.authDir);
  const authAgeMs = getWebAuthAgeMs(account.authDir);
  const heartbeatSeconds = resolveHeartbeatSeconds(cfg, undefined);
  const providerSummary = await buildProviderSummary(cfg, {
    colorize: true,
    includeAllowFrom: true,
  });
  const mainSessionKey = resolveMainSessionKey(cfg);
  const queuedSystemEvents = peekSystemEvents(mainSessionKey);

  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const configModel = resolved.model ?? DEFAULT_MODEL;
  const configContextTokens =
    cfg.agents?.defaults?.contextTokens ??
    lookupContextTokens(configModel) ??
    DEFAULT_CONTEXT_TOKENS;

  const storePath = resolveStorePath(cfg.session?.store);
  const store = loadSessionStore(storePath);
  const now = Date.now();
  const sessions = Object.entries(store)
    .filter(([key]) => key !== "global" && key !== "unknown")
    .map(([key, entry]) => {
      const updatedAt = entry?.updatedAt ?? null;
      const age = updatedAt ? now - updatedAt : null;
      const model = entry?.model ?? configModel ?? null;
      const contextTokens =
        entry?.contextTokens ??
        lookupContextTokens(model) ??
        configContextTokens ??
        null;
      const input = entry?.inputTokens ?? 0;
      const output = entry?.outputTokens ?? 0;
      const total = entry?.totalTokens ?? input + output;
      const remaining =
        contextTokens != null ? Math.max(0, contextTokens - total) : null;
      const pct =
        contextTokens && contextTokens > 0
          ? Math.min(999, Math.round((total / contextTokens) * 100))
          : null;

      return {
        key,
        kind: classifyKey(key, entry),
        sessionId: entry?.sessionId,
        updatedAt,
        age,
        thinkingLevel: entry?.thinkingLevel,
        verboseLevel: entry?.verboseLevel,
        reasoningLevel: entry?.reasoningLevel,
        elevatedLevel: entry?.elevatedLevel,
        systemSent: entry?.systemSent,
        abortedLastRun: entry?.abortedLastRun,
        inputTokens: entry?.inputTokens,
        outputTokens: entry?.outputTokens,
        totalTokens: total ?? null,
        remainingTokens: remaining,
        percentUsed: pct,
        model,
        contextTokens,
        flags: buildFlags(entry),
      } satisfies SessionStatus;
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const recent = sessions.slice(0, 5);

  return {
    web: { linked, authAgeMs },
    heartbeatSeconds,
    providerSummary,
    queuedSystemEvents,
    sessions: {
      path: storePath,
      count: sessions.length,
      defaults: {
        model: configModel ?? null,
        contextTokens: configContextTokens ?? null,
      },
      recent,
    },
  };
}

const formatKTokens = (value: number) =>
  `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;

const formatAge = (ms: number | null | undefined) => {
  if (!ms || ms < 0) return "unknown";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
};

const formatDuration = (ms: number | null | undefined) => {
  if (ms == null || !Number.isFinite(ms)) return "unknown";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const formatContextUsage = (
  total: number | null | undefined,
  contextTokens: number | null | undefined,
  remaining: number | null | undefined,
  pct: number | null | undefined,
) => {
  const used = total ?? 0;
  if (!contextTokens) {
    return `tokens: ${formatKTokens(used)} used (ctx unknown)`;
  }
  const left = remaining ?? Math.max(0, contextTokens - used);
  const pctLabel = pct != null ? `${pct}%` : "?%";
  return `tokens: ${formatKTokens(used)} used, ${formatKTokens(left)} left of ${formatKTokens(contextTokens)} (${pctLabel})`;
};

const classifyKey = (
  key: string,
  entry?: SessionEntry,
): SessionStatus["kind"] => {
  if (key === "global") return "global";
  if (key === "unknown") return "unknown";
  if (entry?.chatType === "group" || entry?.chatType === "room") return "group";
  if (
    key.startsWith("group:") ||
    key.includes(":group:") ||
    key.includes(":channel:")
  ) {
    return "group";
  }
  return "direct";
};

const formatDaemonRuntimeShort = (runtime?: {
  status?: string;
  pid?: number;
  state?: string;
  detail?: string;
}) => {
  if (!runtime) return null;
  const status = runtime.status ?? "unknown";
  const details: string[] = [];
  if (runtime.pid) details.push(`pid ${runtime.pid}`);
  if (runtime.state && runtime.state.toLowerCase() !== status) {
    details.push(`state ${runtime.state}`);
  }
  if (runtime.detail) details.push(runtime.detail);
  return details.length > 0 ? `${status} (${details.join(", ")})` : status;
};

async function getDaemonShortLine(): Promise<string | null> {
  try {
    const service = resolveGatewayService();
    const [loaded, runtime] = await Promise.all([
      service.isLoaded({ env: process.env }).catch(() => false),
      service.readRuntime(process.env).catch(() => undefined),
    ]);
    const loadedText = loaded ? service.loadedText : service.notLoadedText;
    const runtimeShort = formatDaemonRuntimeShort(runtime);
    return `Daemon: ${service.label} ${loadedText}${runtimeShort ? `, ${runtimeShort}` : ""}. Details: clawdbot daemon status`;
  } catch {
    return "Daemon: unknown. Details: clawdbot daemon status";
  }
}

type AgentLocalStatus = {
  id: string;
  name?: string;
  workspaceDir: string | null;
  bootstrapPending: boolean | null;
  sessionsPath: string;
  sessionsCount: number;
  lastUpdatedAt: number | null;
  lastActiveAgeMs: number | null;
};

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function getAgentLocalStatuses(): Promise<{
  defaultId: string;
  agents: AgentLocalStatus[];
  totalSessions: number;
  bootstrapPendingCount: number;
}> {
  const cfg = loadConfig();
  const agentList = listAgentsForGateway(cfg);
  const now = Date.now();

  const statuses: AgentLocalStatus[] = [];
  for (const agent of agentList.agents) {
    const agentId = agent.id;
    const workspaceDir = (() => {
      try {
        return resolveAgentWorkspaceDir(cfg, agentId);
      } catch {
        return null;
      }
    })();

    const bootstrapPath =
      workspaceDir != null ? path.join(workspaceDir, "BOOTSTRAP.md") : null;
    const bootstrapPending =
      bootstrapPath != null ? await fileExists(bootstrapPath) : null;

    const sessionsPath = resolveStorePath(cfg.session?.store, { agentId });
    const store = (() => {
      try {
        return loadSessionStore(sessionsPath);
      } catch {
        return {};
      }
    })();
    const sessions = Object.entries(store)
      .filter(([key]) => key !== "global" && key !== "unknown")
      .map(([, entry]) => entry);
    const sessionsCount = sessions.length;
    const lastUpdatedAt = sessions.reduce(
      (max, e) => Math.max(max, e?.updatedAt ?? 0),
      0,
    );
    const resolvedLastUpdatedAt = lastUpdatedAt > 0 ? lastUpdatedAt : null;
    const lastActiveAgeMs = resolvedLastUpdatedAt
      ? now - resolvedLastUpdatedAt
      : null;

    statuses.push({
      id: agentId,
      name: agent.name,
      workspaceDir,
      bootstrapPending,
      sessionsPath,
      sessionsCount,
      lastUpdatedAt: resolvedLastUpdatedAt,
      lastActiveAgeMs,
    });
  }

  const totalSessions = statuses.reduce((sum, s) => sum + s.sessionsCount, 0);
  const bootstrapPendingCount = statuses.reduce(
    (sum, s) => sum + (s.bootstrapPending ? 1 : 0),
    0,
  );
  return {
    defaultId: agentList.defaultId,
    agents: statuses,
    totalSessions,
    bootstrapPendingCount,
  };
}

function resolveGatewayProbeAuth(cfg: ReturnType<typeof loadConfig>): {
  token?: string;
  password?: string;
} {
  const isRemoteMode = cfg.gateway?.mode === "remote";
  const remote = isRemoteMode ? cfg.gateway?.remote : undefined;
  const authToken = cfg.gateway?.auth?.token;
  const authPassword = cfg.gateway?.auth?.password;
  const token = isRemoteMode
    ? typeof remote?.token === "string" && remote.token.trim().length > 0
      ? remote.token.trim()
      : undefined
    : process.env.CLAWDBOT_GATEWAY_TOKEN?.trim() ||
      (typeof authToken === "string" && authToken.trim().length > 0
        ? authToken.trim()
        : undefined);
  const password =
    process.env.CLAWDBOT_GATEWAY_PASSWORD?.trim() ||
    (isRemoteMode
      ? typeof remote?.password === "string" &&
        remote.password.trim().length > 0
        ? remote.password.trim()
        : undefined
      : typeof authPassword === "string" && authPassword.trim().length > 0
        ? authPassword.trim()
        : undefined);
  return { token, password };
}

function pickGatewaySelfPresence(presence: unknown): {
  host?: string;
  ip?: string;
  version?: string;
  platform?: string;
} | null {
  if (!Array.isArray(presence)) return null;
  const entries = presence as Array<Record<string, unknown>>;
  const self =
    entries.find((e) => e.mode === "gateway" && e.reason === "self") ?? null;
  if (!self) return null;
  return {
    host: typeof self.host === "string" ? self.host : undefined,
    ip: typeof self.ip === "string" ? self.ip : undefined,
    version: typeof self.version === "string" ? self.version : undefined,
    platform: typeof self.platform === "string" ? self.platform : undefined,
  };
}

async function getUpdateCheckResult(params: {
  timeoutMs: number;
  fetchGit: boolean;
  includeRegistry: boolean;
}): Promise<UpdateCheckResult> {
  const root = await resolveClawdbotPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  return await checkUpdateStatus({
    root,
    timeoutMs: params.timeoutMs,
    fetchGit: params.fetchGit,
    includeRegistry: params.includeRegistry,
  });
}

function formatUpdateOneLiner(update: UpdateCheckResult): string {
  const parts: string[] = [];
  if (update.installKind === "git" && update.git) {
    const branch = update.git.branch ? `git ${update.git.branch}` : "git";
    parts.push(branch);
    if (update.git.upstream) parts.push(`↔ ${update.git.upstream}`);
    if (update.git.dirty === true) parts.push("dirty");
    if (update.git.behind != null && update.git.ahead != null) {
      if (update.git.behind === 0 && update.git.ahead === 0) {
        parts.push("up to date");
      } else if (update.git.behind > 0 && update.git.ahead === 0) {
        parts.push(`behind ${update.git.behind}`);
      } else if (update.git.behind === 0 && update.git.ahead > 0) {
        parts.push(`ahead ${update.git.ahead}`);
      } else if (update.git.behind > 0 && update.git.ahead > 0) {
        parts.push(
          `diverged (ahead ${update.git.ahead}, behind ${update.git.behind})`,
        );
      }
    }
    if (update.git.fetchOk === false) parts.push("fetch failed");
  } else {
    parts.push(
      update.packageManager !== "unknown" ? update.packageManager : "pkg",
    );
    if (update.registry?.latestVersion) {
      const cmp = compareSemverStrings(VERSION, update.registry.latestVersion);
      if (cmp === 0) parts.push(`latest ${update.registry.latestVersion}`);
      else if (cmp != null && cmp < 0) {
        parts.push(`update available ${update.registry.latestVersion}`);
      } else {
        parts.push(`latest ${update.registry.latestVersion}`);
      }
    } else if (update.registry?.error) {
      parts.push("latest unknown");
    }
  }

  if (update.deps) {
    if (update.deps.status === "ok") parts.push("deps ok");
    if (update.deps.status === "missing") parts.push("deps missing");
    if (update.deps.status === "stale") parts.push("deps stale");
  }
  return `Update: ${parts.join(" · ")}`;
}

function formatCheckLine(params: {
  ok: boolean;
  label: string;
  detail?: string | null;
  warn?: boolean;
}) {
  const symbol = params.ok
    ? theme.success("\u2713")
    : params.warn
      ? theme.warn("!")
      : theme.error("\u2717");
  const label = params.ok
    ? theme.success(params.label)
    : params.warn
      ? theme.warn(params.label)
      : theme.error(params.label);
  const detail = params.detail?.trim() ? ` ${theme.muted(params.detail)}` : "";
  return `${symbol} ${label}${detail}`;
}

const buildFlags = (entry: SessionEntry): string[] => {
  const flags: string[] = [];
  const think = entry?.thinkingLevel;
  if (typeof think === "string" && think.length > 0)
    flags.push(`think:${think}`);
  const verbose = entry?.verboseLevel;
  if (typeof verbose === "string" && verbose.length > 0)
    flags.push(`verbose:${verbose}`);
  const reasoning = entry?.reasoningLevel;
  if (typeof reasoning === "string" && reasoning.length > 0)
    flags.push(`reasoning:${reasoning}`);
  const elevated = entry?.elevatedLevel;
  if (typeof elevated === "string" && elevated.length > 0)
    flags.push(`elevated:${elevated}`);
  if (entry?.systemSent) flags.push("system");
  if (entry?.abortedLastRun) flags.push("aborted");
  const sessionId = entry?.sessionId as unknown;
  if (typeof sessionId === "string" && sessionId.length > 0)
    flags.push(`id:${sessionId}`);
  return flags;
};

export async function statusCommand(
  opts: {
    json?: boolean;
    deep?: boolean;
    usage?: boolean;
    timeoutMs?: number;
    verbose?: boolean;
    all?: boolean;
  },
  runtime: RuntimeEnv,
) {
  if (opts.all && !opts.json) {
    await statusAllCommand(runtime, { timeoutMs: opts.timeoutMs });
    return;
  }

  const scan = await withProgress(
    {
      label: "Scanning status…",
      total: 6,
      enabled: opts.json !== true,
    },
    async (progress) => {
      progress.setLabel("Loading config…");
      const cfg = loadConfig();
      const osSummary = resolveOsSummary();
      progress.tick();

      progress.setLabel("Checking for updates…");
      const updateTimeoutMs = opts.all ? 6500 : 2500;
      const update = await getUpdateCheckResult({
        timeoutMs: updateTimeoutMs,
        fetchGit: true,
        includeRegistry: true,
      });
      progress.tick();

      progress.setLabel("Resolving agents…");
      const agentStatus = await getAgentLocalStatuses();
      progress.tick();

      progress.setLabel("Probing gateway…");
      const gatewayConnection = buildGatewayConnectionDetails();
      const isRemoteMode = cfg.gateway?.mode === "remote";
      const remoteUrlRaw =
        typeof cfg.gateway?.remote?.url === "string"
          ? cfg.gateway.remote.url
          : "";
      const remoteUrlMissing = isRemoteMode && !remoteUrlRaw.trim();
      const gatewayMode = isRemoteMode ? "remote" : "local";
      const gatewayProbe = remoteUrlMissing
        ? null
        : await probeGateway({
            url: gatewayConnection.url,
            auth: resolveGatewayProbeAuth(cfg),
            timeoutMs: Math.min(
              opts.all ? 5000 : 2500,
              opts.timeoutMs ?? 10_000,
            ),
          }).catch(() => null);
      const gatewayReachable = gatewayProbe?.ok === true;
      const gatewaySelf = gatewayProbe?.presence
        ? pickGatewaySelfPresence(gatewayProbe.presence)
        : null;
      progress.tick();

      progress.setLabel("Reading sessions…");
      const summary = await getStatusSummary();
      progress.tick();

      progress.setLabel("Rendering…");
      progress.tick();

      return {
        cfg,
        osSummary,
        update,
        gatewayConnection,
        remoteUrlMissing,
        gatewayMode,
        gatewayProbe,
        gatewayReachable,
        gatewaySelf,
        agentStatus,
        summary,
      };
    },
  );

  const {
    cfg,
    osSummary,
    update,
    gatewayConnection,
    remoteUrlMissing,
    gatewayMode,
    gatewayProbe,
    gatewayReachable,
    gatewaySelf,
    agentStatus,
    summary,
  } = scan;
  const usage = opts.usage
    ? await withProgress(
        {
          label: "Fetching usage snapshot…",
          indeterminate: true,
          enabled: opts.json !== true,
        },
        async () =>
          await loadProviderUsageSummary({ timeoutMs: opts.timeoutMs }),
      )
    : undefined;
  const health: HealthSummary | undefined = opts.deep
    ? await withProgress(
        {
          label: "Checking gateway health…",
          indeterminate: true,
          enabled: opts.json !== true,
        },
        async () =>
          await callGateway<HealthSummary>({
            method: "health",
            timeoutMs: opts.timeoutMs,
          }),
      )
    : undefined;

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          ...summary,
          os: osSummary,
          update,
          gateway: {
            mode: gatewayMode,
            url: gatewayConnection.url,
            urlSource: gatewayConnection.urlSource,
            misconfigured: remoteUrlMissing,
            reachable: gatewayReachable,
            connectLatencyMs: gatewayProbe?.connectLatencyMs ?? null,
            self: gatewaySelf,
            error: gatewayProbe?.error ?? null,
          },
          agents: agentStatus,
          ...(health || usage ? { health, usage } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (opts.verbose || opts.all) {
    const details = buildGatewayConnectionDetails();
    runtime.log(info("Gateway connection:"));
    for (const line of details.message.split("\n")) {
      runtime.log(`  ${line}`);
    }
  }

  const controlUiEnabled = cfg.gateway?.controlUi?.enabled ?? true;
  if (!controlUiEnabled) {
    runtime.log(info("Dashboard: disabled"));
  } else {
    const links = resolveControlUiLinks({
      port: resolveGatewayPort(cfg),
      bind: cfg.gateway?.bind,
      basePath: cfg.gateway?.controlUi?.basePath,
    });
    runtime.log(info(`Dashboard: ${links.httpUrl}`));
  }

  runtime.log(info(`OS: ${osSummary.label} · node ${process.versions.node}`));
  runtime.log(info(formatUpdateOneLiner(update)));

  const gatewayLine = (() => {
    const target = remoteUrlMissing
      ? "(missing gateway.remote.url)"
      : gatewayConnection.url;
    const reach = remoteUrlMissing
      ? "misconfigured (missing gateway.remote.url)"
      : gatewayReachable
        ? `reachable (${formatDuration(gatewayProbe?.connectLatencyMs)})`
        : gatewayProbe?.error
          ? `unreachable (${gatewayProbe.error})`
          : "unreachable";
    const self =
      gatewaySelf?.host || gatewaySelf?.version || gatewaySelf?.platform
        ? [
            gatewaySelf?.host ? gatewaySelf.host : null,
            gatewaySelf?.ip ? `(${gatewaySelf.ip})` : null,
            gatewaySelf?.version ? `app ${gatewaySelf.version}` : null,
            gatewaySelf?.platform ? gatewaySelf.platform : null,
          ]
            .filter(Boolean)
            .join(" ")
        : null;
    const suffix = self ? ` · ${self}` : "";
    return `Gateway: ${gatewayMode} · ${target} · ${reach}${suffix}`;
  })();
  runtime.log(info(gatewayLine));

  const agentLine = (() => {
    const pending =
      agentStatus.bootstrapPendingCount > 0
        ? `${agentStatus.bootstrapPendingCount} bootstrapping`
        : "no bootstraps";
    const def = agentStatus.agents.find((a) => a.id === agentStatus.defaultId);
    const defActive =
      def?.lastActiveAgeMs != null ? formatAge(def.lastActiveAgeMs) : "unknown";
    const defSuffix = def ? ` · default ${def.id} active ${defActive}` : "";
    return `Agents: ${agentStatus.agents.length} · ${pending} · sessions ${agentStatus.totalSessions}${defSuffix}`;
  })();
  runtime.log(info(agentLine));

  runtime.log(
    `Web session: ${summary.web.linked ? "linked" : "not linked"}${summary.web.linked ? ` (last refreshed ${formatAge(summary.web.authAgeMs)})` : ""}`,
  );
  if (summary.web.linked) {
    const account = resolveWhatsAppAccount({ cfg });
    logWebSelfId(account.authDir, runtime, true);
  }
  runtime.log("");
  runtime.log(info("System:"));
  for (const line of summary.providerSummary) {
    runtime.log(`  ${line}`);
  }
  const daemonLine = await getDaemonShortLine();
  if (daemonLine) {
    runtime.log(info(daemonLine));
  }

  if (opts.all) {
    runtime.log("");
    runtime.log(theme.heading("Diagnosis (read-only):"));

    const snap = await readConfigFileSnapshot().catch(() => null);
    if (snap) {
      runtime.log(
        formatCheckLine({
          ok: Boolean(snap.exists && snap.valid),
          warn: Boolean(snap.exists && !snap.valid),
          label: `Config: ${snap.path ?? "(unknown)"}`,
          detail: snap.exists
            ? snap.valid
              ? "valid"
              : `invalid (${snap.issues.length} issues)`
            : "missing",
        }),
      );
      const issues = [...(snap.legacyIssues ?? []), ...(snap.issues ?? [])];
      const uniqueIssues = issues.filter(
        (issue, index) =>
          issues.findIndex(
            (x) => x.path === issue.path && x.message === issue.message,
          ) === index,
      );
      for (const issue of uniqueIssues.slice(0, 12)) {
        runtime.log(`  - ${issue.path}: ${issue.message}`);
      }
      if (uniqueIssues.length > 12) {
        runtime.log(theme.muted(`  … +${uniqueIssues.length - 12} more`));
      }
    } else {
      runtime.log(
        formatCheckLine({
          ok: false,
          label: "Config: unknown",
          detail: "read failed",
        }),
      );
    }

    const sentinel = await readRestartSentinel().catch(() => null);
    if (sentinel?.payload) {
      runtime.log(
        formatCheckLine({
          ok: true,
          label: "Restart sentinel",
          detail: `${summarizeRestartSentinel(sentinel.payload)} · ${formatAge(Date.now() - sentinel.payload.ts)}`,
          warn: true,
        }),
      );
    } else {
      runtime.log(
        formatCheckLine({
          ok: true,
          label: "Restart sentinel",
          detail: "none",
        }),
      );
    }

    const lastErr = await readLastGatewayErrorLine(process.env).catch(
      () => null,
    );
    if (lastErr) {
      runtime.log(
        formatCheckLine({
          ok: true,
          warn: true,
          label: "Gateway last log line",
          detail: lastErr,
        }),
      );
    } else {
      runtime.log(
        formatCheckLine({
          ok: true,
          label: "Gateway last log line",
          detail: "none",
        }),
      );
    }

    const port = resolveGatewayPort(cfg);
    const portUsage = await inspectPortUsage(port).catch(() => null);
    if (portUsage) {
      const ok = portUsage.listeners.length === 0;
      runtime.log(
        formatCheckLine({
          ok,
          warn: !ok,
          label: `Port ${port}`,
          detail: ok ? "free" : "in use",
        }),
      );
      if (!ok) {
        for (const line of formatPortDiagnostics(portUsage)) {
          runtime.log(`  ${line}`);
        }
      }
    }

    const defaultWorkspace =
      agentStatus.agents.find((a) => a.id === agentStatus.defaultId)
        ?.workspaceDir ??
      agentStatus.agents[0]?.workspaceDir ??
      null;
    const skillStatus =
      defaultWorkspace != null
        ? (() => {
            try {
              return buildWorkspaceSkillStatus(defaultWorkspace, {
                config: cfg,
              });
            } catch {
              return null;
            }
          })()
        : null;
    if (skillStatus) {
      const eligible = skillStatus.skills.filter((s) => s.eligible).length;
      const missing = skillStatus.skills.filter(
        (s) => s.eligible && Object.values(s.missing).some((arr) => arr.length),
      ).length;
      runtime.log(
        formatCheckLine({
          ok: missing === 0,
          warn: missing > 0,
          label: "Skills",
          detail: `${eligible} eligible · ${missing} missing requirements · ${skillStatus.workspaceDir}`,
        }),
      );
    }

    runtime.log("");
    runtime.log(theme.heading("Agents:"));
    for (const agent of agentStatus.agents) {
      const name = agent.name ? ` (${agent.name})` : "";
      const bootstrap =
        agent.bootstrapPending === true
          ? theme.warn("BOOTSTRAP.md pending")
          : agent.bootstrapPending === false
            ? theme.success("bootstrapped")
            : theme.muted("bootstrap unknown");
      const active =
        agent.lastActiveAgeMs != null
          ? formatAge(agent.lastActiveAgeMs)
          : "unknown";
      runtime.log(
        `- ${theme.info(agent.id)}${name} · ${bootstrap} · sessions ${agent.sessionsCount} · active ${active}`,
      );
      if (agent.workspaceDir)
        runtime.log(theme.muted(`  workspace: ${agent.workspaceDir}`));
      runtime.log(theme.muted(`  sessions: ${agent.sessionsPath}`));
    }

    if (gatewayReachable) {
      const providersStatus = await callGateway<Record<string, unknown>>({
        method: "providers.status",
        params: { probe: false, timeoutMs: opts.timeoutMs ?? 10_000 },
        timeoutMs: Math.min(8000, opts.timeoutMs ?? 10_000),
      }).catch(() => null);
      if (providersStatus) {
        const issues = collectProvidersStatusIssues(providersStatus);
        runtime.log(
          formatCheckLine({
            ok: issues.length === 0,
            warn: issues.length > 0,
            label: "Provider config/runtime issues",
            detail: issues.length ? String(issues.length) : "none",
          }),
        );
        for (const issue of issues.slice(0, 8)) {
          runtime.log(
            `  - ${issue.provider}[${issue.accountId}] ${issue.kind}: ${issue.message}`,
          );
          if (issue.fix) runtime.log(theme.muted(`    fix: ${issue.fix}`));
        }
        if (issues.length > 8) {
          runtime.log(theme.muted(`  … +${issues.length - 8} more`));
        }
      } else {
        runtime.log(
          formatCheckLine({
            ok: false,
            warn: true,
            label: "Provider config/runtime issues",
            detail: "skipped (gateway query failed)",
          }),
        );
      }
    } else {
      runtime.log(
        formatCheckLine({
          ok: false,
          warn: true,
          label: "Provider config/runtime issues",
          detail: "skipped (gateway unreachable)",
        }),
      );
    }

    runtime.log("");
    runtime.log(
      theme.muted(
        "Tip: This output is safe to paste for debugging (no tokens).",
      ),
    );
  }

  runtime.log("");
  if (health) {
    runtime.log(info("Gateway health: reachable"));

    const tgLine = health.telegram.configured
      ? health.telegram.probe?.ok
        ? info(
            `Telegram: ok${health.telegram.probe.bot?.username ? ` (@${health.telegram.probe.bot.username})` : ""} (${health.telegram.probe.elapsedMs}ms)` +
              (health.telegram.probe.webhook?.url
                ? ` - webhook ${health.telegram.probe.webhook.url}`
                : ""),
          )
        : `Telegram: failed (${health.telegram.probe?.status ?? "unknown"})${health.telegram.probe?.error ? ` - ${health.telegram.probe.error}` : ""}`
      : info("Telegram: not configured");
    runtime.log(tgLine);

    const discordLine = health.discord.configured
      ? health.discord.probe?.ok
        ? info(
            `Discord: ok${health.discord.probe.bot?.username ? ` (@${health.discord.probe.bot.username})` : ""} (${health.discord.probe.elapsedMs}ms)`,
          )
        : `Discord: failed (${health.discord.probe?.status ?? "unknown"})${health.discord.probe?.error ? ` - ${health.discord.probe.error}` : ""}`
      : info("Discord: not configured");
    runtime.log(discordLine);
  } else {
    runtime.log(info("Provider probes: skipped (use --deep)"));
  }
  runtime.log("");
  if (summary.queuedSystemEvents.length > 0) {
    const preview = summary.queuedSystemEvents.slice(0, 3).join(" | ");
    runtime.log(
      info(
        `Queued system events (${summary.queuedSystemEvents.length}): ${preview}`,
      ),
    );
  }
  runtime.log(info(`Heartbeat: ${summary.heartbeatSeconds}s`));
  runtime.log(info(`Session store: ${summary.sessions.path}`));
  const defaults = summary.sessions.defaults;
  const defaultCtx = defaults.contextTokens
    ? ` (${formatKTokens(defaults.contextTokens)} ctx)`
    : "";
  runtime.log(
    info(`Default model: ${defaults.model ?? "unknown"}${defaultCtx}`),
  );
  runtime.log(info(`Active sessions: ${summary.sessions.count}`));
  if (summary.sessions.recent.length > 0) {
    runtime.log("Recent sessions:");
    for (const r of summary.sessions.recent) {
      runtime.log(
        `- ${r.key} [${r.kind}] | ${r.updatedAt ? formatAge(r.age) : "no activity"} | model ${r.model ?? "unknown"} | ${formatContextUsage(r.totalTokens, r.contextTokens, r.remainingTokens, r.percentUsed)}${r.flags.length ? ` | flags: ${r.flags.join(", ")}` : ""}`,
      );
    }
  } else {
    runtime.log("No session activity yet.");
  }
  runtime.log("");

  if (usage) {
    for (const line of formatUsageReportLines(usage)) {
      runtime.log(line);
    }
  }
  runtime.log("FAQ: https://docs.clawd.bot/faq");
  runtime.log("Troubleshooting: https://docs.clawd.bot/troubleshooting");
}
