import { lookupContextTokens } from "../agents/context.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import { withProgress } from "../cli/progress.js";
import { loadConfig, resolveGatewayPort } from "../config/config.js";
import {
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import { resolveGatewayService } from "../daemon/service.js";
import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import { info } from "../globals.js";
import { buildProviderSummary } from "../infra/provider-summary.js";
import {
  formatUsageReportLines,
  loadProviderUsageSummary,
} from "../infra/provider-usage.js";
import { peekSystemEvents } from "../infra/system-events.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveWhatsAppAccount } from "../web/accounts.js";
import { resolveHeartbeatSeconds } from "../web/reconnect.js";
import {
  getWebAuthAgeMs,
  logWebSelfId,
  webAuthExists,
} from "../web/session.js";
import type { HealthSummary } from "./health.js";
import { resolveControlUiLinks } from "./onboard-helpers.js";

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
  const queuedSystemEvents = peekSystemEvents();

  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const configModel = resolved.model ?? DEFAULT_MODEL;
  const configContextTokens =
    cfg.agent?.contextTokens ??
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
  },
  runtime: RuntimeEnv,
) {
  const cfg = loadConfig();
  const summary = await getStatusSummary();
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
        health || usage ? { ...summary, health, usage } : summary,
        null,
        2,
      ),
    );
    return;
  }

  if (opts.verbose) {
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
