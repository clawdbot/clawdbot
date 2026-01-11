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
import { withProgress } from "../cli/progress.js";
import {
  type ClawdbotConfig,
  loadConfig,
  resolveGatewayPort,
} from "../config/config.js";
import {
  loadSessionStore,
  resolveMainSessionKey,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import { resolveGatewayService } from "../daemon/service.js";
import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import { normalizeControlUiBasePath } from "../gateway/control-ui.js";
import { probeGateway } from "../gateway/probe.js";
import { listAgentsForGateway } from "../gateway/session-utils.js";
import { info } from "../globals.js";
import { resolveClawdbotPackageRoot } from "../infra/clawdbot-root.js";
import { resolveOsSummary } from "../infra/os-summary.js";
import { buildProviderSummary } from "../infra/provider-summary.js";
import {
  formatUsageReportLines,
  loadProviderUsageSummary,
} from "../infra/provider-usage.js";
import { collectProvidersStatusIssues } from "../infra/providers-status-issues.js";
import { peekSystemEvents } from "../infra/system-events.js";
import { getTailnetHostname } from "../infra/tailscale.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
  type UpdateCheckResult,
} from "../infra/update-check.js";
import { runExec } from "../process/exec.js";
import { resolveProviderDefaultAccountId } from "../providers/plugins/helpers.js";
import { listProviderPlugins } from "../providers/plugins/index.js";
import type {
  ProviderAccountSnapshot,
  ProviderId,
  ProviderPlugin,
} from "../providers/plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { VERSION } from "../version.js";
import { resolveHeartbeatSeconds } from "../web/reconnect.js";
import { formatHealthProviderLines, type HealthSummary } from "./health.js";
import { resolveControlUiLinks } from "./onboard-helpers.js";
import { formatGatewayAuthUsed } from "./status-all/format.js";
import { buildProvidersTable } from "./status-all/providers.js";
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
  linkProvider?: {
    id: ProviderId;
    label: string;
    linked: boolean;
    authAgeMs: number | null;
  };
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

type LinkProviderContext = {
  linked: boolean;
  authAgeMs: number | null;
  account?: unknown;
  accountId?: string;
  plugin: ProviderPlugin;
};

async function resolveLinkProviderContext(
  cfg: ClawdbotConfig,
): Promise<LinkProviderContext | null> {
  for (const plugin of listProviderPlugins()) {
    const accountIds = plugin.config.listAccountIds(cfg);
    const defaultAccountId = resolveProviderDefaultAccountId({
      plugin,
      cfg,
      accountIds,
    });
    const account = plugin.config.resolveAccount(cfg, defaultAccountId);
    const enabled = plugin.config.isEnabled
      ? plugin.config.isEnabled(account, cfg)
      : true;
    const configured = plugin.config.isConfigured
      ? await plugin.config.isConfigured(account, cfg)
      : true;
    const snapshot = plugin.config.describeAccount
      ? plugin.config.describeAccount(account, cfg)
      : ({
          accountId: defaultAccountId,
          enabled,
          configured,
        } as ProviderAccountSnapshot);
    const summary = plugin.status?.buildProviderSummary
      ? await plugin.status.buildProviderSummary({
          account,
          cfg,
          defaultAccountId,
          snapshot,
        })
      : undefined;
    const summaryRecord = summary as Record<string, unknown> | undefined;
    const linked =
      summaryRecord && typeof summaryRecord.linked === "boolean"
        ? summaryRecord.linked
        : null;
    if (linked === null) continue;
    const authAgeMs =
      summaryRecord && typeof summaryRecord.authAgeMs === "number"
        ? summaryRecord.authAgeMs
        : null;
    return { linked, authAgeMs, account, accountId: defaultAccountId, plugin };
  }
  return null;
}

export async function getStatusSummary(): Promise<StatusSummary> {
  const cfg = loadConfig();
  const linkContext = await resolveLinkProviderContext(cfg);
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
    linkProvider: linkContext
      ? {
          id: linkContext.plugin.id,
          label: linkContext.plugin.meta.label ?? "Provider",
          linked: linkContext.linked,
          authAgeMs: linkContext.authAgeMs,
        }
      : undefined,
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

const shortenText = (value: string, maxLen: number) => {
  const chars = Array.from(value);
  if (chars.length <= maxLen) return value;
  return `${chars.slice(0, Math.max(0, maxLen - 1)).join("")}…`;
};

const formatTokensCompact = (
  sess: Pick<SessionStatus, "totalTokens" | "contextTokens" | "percentUsed">,
) => {
  const used = sess.totalTokens ?? 0;
  const ctx = sess.contextTokens;
  if (!ctx) return `${formatKTokens(used)} used`;
  const pctLabel = sess.percentUsed != null ? `${sess.percentUsed}%` : "?%";
  return `${formatKTokens(used)}/${formatKTokens(ctx)} (${pctLabel})`;
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
  missingUnit?: boolean;
}) => {
  if (!runtime) return null;
  const status = runtime.status ?? "unknown";
  const details: string[] = [];
  if (runtime.pid) details.push(`pid ${runtime.pid}`);
  if (runtime.state && runtime.state.toLowerCase() !== status) {
    details.push(`state ${runtime.state}`);
  }
  const detail = runtime.detail?.replace(/\s+/g, " ").trim() || "";
  const noisyLaunchctlDetail =
    runtime.missingUnit === true &&
    detail.toLowerCase().includes("could not find service");
  if (detail && !noisyLaunchctlDetail) details.push(detail);
  return details.length > 0 ? `${status} (${details.join(", ")})` : status;
};

async function getDaemonStatusSummary(): Promise<{
  label: string;
  installed: boolean | null;
  loadedText: string;
  runtimeShort: string | null;
}> {
  try {
    const service = resolveGatewayService();
    const [loaded, runtime, command] = await Promise.all([
      service
        .isLoaded({ profile: process.env.CLAWDBOT_PROFILE })
        .catch(() => false),
      service.readRuntime(process.env).catch(() => undefined),
      service.readCommand(process.env).catch(() => null),
    ]);
    const installed = command != null;
    const loadedText = loaded ? service.loadedText : service.notLoadedText;
    const runtimeShort = formatDaemonRuntimeShort(runtime);
    return { label: service.label, installed, loadedText, runtimeShort };
  } catch {
    return {
      label: "Daemon",
      installed: null,
      loadedText: "unknown",
      runtimeShort: null,
    };
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

    if (update.registry?.latestVersion) {
      const cmp = compareSemverStrings(VERSION, update.registry.latestVersion);
      if (cmp === 0) parts.push(`npm latest ${update.registry.latestVersion}`);
      else if (cmp != null && cmp < 0)
        parts.push(`npm update ${update.registry.latestVersion}`);
      else
        parts.push(`npm latest ${update.registry.latestVersion} (local newer)`);
    } else if (update.registry?.error) {
      parts.push("npm latest unknown");
    }
  } else {
    parts.push(
      update.packageManager !== "unknown" ? update.packageManager : "pkg",
    );
    if (update.registry?.latestVersion) {
      const cmp = compareSemverStrings(VERSION, update.registry.latestVersion);
      if (cmp === 0) parts.push(`npm latest ${update.registry.latestVersion}`);
      else if (cmp != null && cmp < 0) {
        parts.push(`npm update ${update.registry.latestVersion}`);
      } else {
        parts.push(`npm latest ${update.registry.latestVersion} (local newer)`);
      }
    } else if (update.registry?.error) {
      parts.push("npm latest unknown");
    }
  }

  if (update.deps) {
    if (update.deps.status === "ok") parts.push("deps ok");
    if (update.deps.status === "missing") parts.push("deps missing");
    if (update.deps.status === "stale") parts.push("deps stale");
  }
  return `Update: ${parts.join(" · ")}`;
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
      total: 9,
      enabled: opts.json !== true,
    },
    async (progress) => {
      progress.setLabel("Loading config…");
      const cfg = loadConfig();
      const osSummary = resolveOsSummary();
      progress.tick();

      progress.setLabel("Checking Tailscale…");
      const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
      const tailscaleDns =
        tailscaleMode === "off"
          ? null
          : await getTailnetHostname((cmd, args) =>
              runExec(cmd, args, { timeoutMs: 1200, maxBuffer: 200_000 }),
            ).catch(() => null);
      const tailscaleHttpsUrl =
        tailscaleMode !== "off" && tailscaleDns
          ? `https://${tailscaleDns}${normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath)}`
          : null;
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

      progress.setLabel("Querying provider status…");
      const providersStatus = gatewayReachable
        ? await callGateway<Record<string, unknown>>({
            method: "providers.status",
            params: {
              probe: false,
              timeoutMs: Math.min(8000, opts.timeoutMs ?? 10_000),
            },
            timeoutMs: Math.min(
              opts.all ? 5000 : 2500,
              opts.timeoutMs ?? 10_000,
            ),
          }).catch(() => null)
        : null;
      const providerIssues = providersStatus
        ? collectProvidersStatusIssues(providersStatus)
        : [];
      progress.tick();

      progress.setLabel("Summarizing providers…");
      const providers = await buildProvidersTable(cfg, {
        // Show token previews in regular status; keep `status --all` redacted.
        // Set `CLAWDBOT_SHOW_SECRETS=0` to force redaction.
        showSecrets: process.env.CLAWDBOT_SHOW_SECRETS?.trim() !== "0",
      });
      progress.tick();

      progress.setLabel("Reading sessions…");
      const summary = await getStatusSummary();
      progress.tick();

      progress.setLabel("Rendering…");
      progress.tick();

      return {
        cfg,
        osSummary,
        tailscaleMode,
        tailscaleDns,
        tailscaleHttpsUrl,
        update,
        gatewayConnection,
        remoteUrlMissing,
        gatewayMode,
        gatewayProbe,
        gatewayReachable,
        gatewaySelf,
        providerIssues,
        agentStatus,
        providers,
        summary,
      };
    },
  );

  const {
    cfg,
    osSummary,
    tailscaleMode,
    tailscaleDns,
    tailscaleHttpsUrl,
    update,
    gatewayConnection,
    remoteUrlMissing,
    gatewayMode,
    gatewayProbe,
    gatewayReachable,
    gatewaySelf,
    providerIssues,
    agentStatus,
    providers,
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

  const rich = true;
  const muted = (value: string) => (rich ? theme.muted(value) : value);
  const ok = (value: string) => (rich ? theme.success(value) : value);
  const warn = (value: string) => (rich ? theme.warn(value) : value);

  if (opts.verbose) {
    const details = buildGatewayConnectionDetails();
    runtime.log(info("Gateway connection:"));
    for (const line of details.message.split("\n")) runtime.log(`  ${line}`);
    runtime.log("");
  }

  const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);

  const dashboard = (() => {
    const controlUiEnabled = cfg.gateway?.controlUi?.enabled ?? true;
    if (!controlUiEnabled) return "disabled";
    const links = resolveControlUiLinks({
      port: resolveGatewayPort(cfg),
      bind: cfg.gateway?.bind,
      basePath: cfg.gateway?.controlUi?.basePath,
    });
    return links.httpUrl;
  })();

  const gatewayValue = (() => {
    const target = remoteUrlMissing
      ? `fallback ${gatewayConnection.url}`
      : `${gatewayConnection.url}${gatewayConnection.urlSource ? ` (${gatewayConnection.urlSource})` : ""}`;
    const reach = remoteUrlMissing
      ? warn("misconfigured (remote.url missing)")
      : gatewayReachable
        ? ok(`reachable ${formatDuration(gatewayProbe?.connectLatencyMs)}`)
        : warn(
            gatewayProbe?.error
              ? `unreachable (${gatewayProbe.error})`
              : "unreachable",
          );
    const auth =
      gatewayReachable && !remoteUrlMissing
        ? ` · auth ${formatGatewayAuthUsed(resolveGatewayProbeAuth(cfg))}`
        : "";
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
    return `${gatewayMode} · ${target} · ${reach}${auth}${suffix}`;
  })();

  const agentsValue = (() => {
    const pending =
      agentStatus.bootstrapPendingCount > 0
        ? `${agentStatus.bootstrapPendingCount} bootstrapping`
        : "no bootstraps";
    const def = agentStatus.agents.find((a) => a.id === agentStatus.defaultId);
    const defActive =
      def?.lastActiveAgeMs != null ? formatAge(def.lastActiveAgeMs) : "unknown";
    const defSuffix = def ? ` · default ${def.id} active ${defActive}` : "";
    return `${agentStatus.agents.length} · ${pending} · sessions ${agentStatus.totalSessions}${defSuffix}`;
  })();

  const daemon = await getDaemonStatusSummary();
  const daemonValue = (() => {
    if (daemon.installed === false) return `${daemon.label} not installed`;
    const installedPrefix = daemon.installed === true ? "installed · " : "";
    return `${daemon.label} ${installedPrefix}${daemon.loadedText}${daemon.runtimeShort ? ` · ${daemon.runtimeShort}` : ""}`;
  })();

  const defaults = summary.sessions.defaults;
  const defaultCtx = defaults.contextTokens
    ? ` (${formatKTokens(defaults.contextTokens)} ctx)`
    : "";
  const eventsValue =
    summary.queuedSystemEvents.length > 0
      ? `${summary.queuedSystemEvents.length} queued`
      : "none";

  const probesValue = health ? ok("enabled") : muted("skipped (use --deep)");

  const overviewRows = [
    { Item: "Dashboard", Value: dashboard },
    { Item: "OS", Value: `${osSummary.label} · node ${process.versions.node}` },
    {
      Item: "Tailscale",
      Value:
        tailscaleMode === "off"
          ? muted("off")
          : tailscaleDns && tailscaleHttpsUrl
            ? `${tailscaleMode} · ${tailscaleDns} · ${tailscaleHttpsUrl}`
            : warn(`${tailscaleMode} · magicdns unknown`),
    },
    {
      Item: "Update",
      Value: formatUpdateOneLiner(update).replace(/^Update:\s*/i, ""),
    },
    { Item: "Gateway", Value: gatewayValue },
    { Item: "Daemon", Value: daemonValue },
    { Item: "Agents", Value: agentsValue },
    { Item: "Probes", Value: probesValue },
    { Item: "Events", Value: eventsValue },
    { Item: "Heartbeat", Value: `${summary.heartbeatSeconds}s` },
    {
      Item: "Sessions",
      Value: `${summary.sessions.count} active · default ${defaults.model ?? "unknown"}${defaultCtx} · store ${summary.sessions.path}`,
    },
  ];

  runtime.log(theme.heading("Clawdbot status"));
  runtime.log("");
  runtime.log(theme.heading("Overview"));
  runtime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Item", header: "Item", minWidth: 12 },
        { key: "Value", header: "Value", flex: true, minWidth: 32 },
      ],
      rows: overviewRows,
    }).trimEnd(),
  );

  runtime.log("");
  runtime.log(theme.heading("Providers"));
  const providerIssuesByProvider = (() => {
    const map = new Map<string, typeof providerIssues>();
    for (const issue of providerIssues) {
      const key = issue.provider;
      const list = map.get(key);
      if (list) list.push(issue);
      else map.set(key, [issue]);
    }
    return map;
  })();
  runtime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Provider", header: "Provider", minWidth: 10 },
        { key: "Enabled", header: "Enabled", minWidth: 7 },
        { key: "State", header: "State", minWidth: 8 },
        { key: "Detail", header: "Detail", flex: true, minWidth: 24 },
      ],
      rows: providers.rows.map((row) => {
        const issues = providerIssuesByProvider.get(row.id) ?? [];
        const effectiveState =
          row.state === "off" ? "off" : issues.length > 0 ? "warn" : row.state;
        const issueSuffix =
          issues.length > 0
            ? ` · ${warn(`gateway: ${shortenText(issues[0]?.message ?? "issue", 84)}`)}`
            : "";
        return {
          Provider: row.provider,
          Enabled: row.enabled ? ok("ON") : muted("OFF"),
          State:
            effectiveState === "ok"
              ? ok("OK")
              : effectiveState === "warn"
                ? warn("WARN")
                : effectiveState === "off"
                  ? muted("OFF")
                  : theme.accentDim("SETUP"),
          Detail: `${row.detail}${issueSuffix}`,
        };
      }),
    }).trimEnd(),
  );

  runtime.log("");
  runtime.log(theme.heading("Sessions"));
  runtime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Key", header: "Key", minWidth: 20, flex: true },
        { key: "Kind", header: "Kind", minWidth: 6 },
        { key: "Age", header: "Age", minWidth: 9 },
        { key: "Model", header: "Model", minWidth: 14 },
        { key: "Tokens", header: "Tokens", minWidth: 16 },
      ],
      rows:
        summary.sessions.recent.length > 0
          ? summary.sessions.recent.map((sess) => ({
              Key: shortenText(sess.key, 32),
              Kind: sess.kind,
              Age: sess.updatedAt ? formatAge(sess.age) : "no activity",
              Model: sess.model ?? "unknown",
              Tokens: formatTokensCompact(sess),
            }))
          : [
              {
                Key: muted("no sessions yet"),
                Kind: "",
                Age: "",
                Model: "",
                Tokens: "",
              },
            ],
    }).trimEnd(),
  );

  if (summary.queuedSystemEvents.length > 0) {
    runtime.log("");
    runtime.log(theme.heading("System events"));
    runtime.log(
      renderTable({
        width: tableWidth,
        columns: [{ key: "Event", header: "Event", flex: true, minWidth: 24 }],
        rows: summary.queuedSystemEvents.slice(0, 5).map((event) => ({
          Event: event,
        })),
      }).trimEnd(),
    );
    if (summary.queuedSystemEvents.length > 5) {
      runtime.log(muted(`… +${summary.queuedSystemEvents.length - 5} more`));
    }
  }

  if (health) {
    runtime.log("");
    runtime.log(theme.heading("Health"));
    const rows: Array<Record<string, string>> = [];
    rows.push({
      Provider: "Gateway",
      Status: ok("reachable"),
      Detail: `${health.durationMs}ms`,
    });

    for (const line of formatHealthProviderLines(health)) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const provider = line.slice(0, colon).trim();
      const detail = line.slice(colon + 1).trim();
      const normalized = detail.toLowerCase();
      const status = (() => {
        if (normalized.startsWith("ok")) return ok("OK");
        if (normalized.startsWith("failed")) return warn("WARN");
        if (normalized.startsWith("not configured")) return muted("OFF");
        if (normalized.startsWith("configured")) return ok("OK");
        if (normalized.startsWith("linked")) return ok("LINKED");
        if (normalized.startsWith("not linked")) return warn("UNLINKED");
        return warn("WARN");
      })();
      rows.push({ Provider: provider, Status: status, Detail: detail });
    }

    runtime.log(
      renderTable({
        width: tableWidth,
        columns: [
          { key: "Provider", header: "Provider", minWidth: 10 },
          { key: "Status", header: "Status", minWidth: 8 },
          { key: "Detail", header: "Detail", flex: true, minWidth: 28 },
        ],
        rows,
      }).trimEnd(),
    );
  }

  if (usage) {
    runtime.log("");
    runtime.log(theme.heading("Usage"));
    for (const line of formatUsageReportLines(usage)) {
      runtime.log(line);
    }
  }

  runtime.log("");
  runtime.log("FAQ: https://docs.clawd.bot/faq");
  runtime.log("Troubleshooting: https://docs.clawd.bot/troubleshooting");
  runtime.log("");
  runtime.log("Next steps:");
  runtime.log("  Need to share?      clawdbot status --all");
  runtime.log("  Need to debug live? clawdbot logs --follow");
  if (gatewayReachable) {
    runtime.log("  Need to test providers? clawdbot status --deep");
  } else {
    runtime.log("  Fix reachability first: clawdbot gateway status");
  }
}
