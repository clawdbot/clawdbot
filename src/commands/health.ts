import { withProgress } from "../cli/progress.js";
import { loadConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import { info } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  getProviderPlugin,
  listProviderPlugins,
} from "../providers/plugins/index.js";
import type { ProviderAccountSnapshot } from "../providers/plugins/types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveHeartbeatSeconds } from "../web/reconnect.js";

export type ProviderHealthSummary = {
  configured?: boolean;
  linked?: boolean;
  authAgeMs?: number | null;
  probe?: unknown;
  lastProbeAt?: number | null;
  [key: string]: unknown;
};

export type HealthSummary = {
  /**
   * Convenience top-level flag for UIs (e.g. WebChat) that only need a binary
   * "can talk to the gateway" signal. If this payload exists, the gateway RPC
   * succeeded, so this is always `true`.
   */
  ok: true;
  ts: number;
  durationMs: number;
  providers: Record<string, ProviderHealthSummary>;
  providerOrder: string[];
  providerLabels: Record<string, string>;
  heartbeatSeconds: number;
  sessions: {
    path: string;
    count: number;
    recent: Array<{
      key: string;
      updatedAt: number | null;
      age: number | null;
    }>;
  };
};

const DEFAULT_TIMEOUT_MS = 10_000;

const isAccountEnabled = (account: unknown): boolean => {
  if (!account || typeof account !== "object") return true;
  const enabled = (account as { enabled?: boolean }).enabled;
  return enabled !== false;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

const formatProbeLine = (probe: unknown): string | null => {
  const record = asRecord(probe);
  if (!record) return null;
  const ok = typeof record.ok === "boolean" ? record.ok : undefined;
  if (ok === undefined) return null;
  const elapsedMs =
    typeof record.elapsedMs === "number" ? record.elapsedMs : null;
  const status = typeof record.status === "number" ? record.status : null;
  const error = typeof record.error === "string" ? record.error : null;
  const bot = asRecord(record.bot);
  const botUsername =
    bot && typeof bot.username === "string" ? bot.username : null;
  const webhook = asRecord(record.webhook);
  const webhookUrl =
    webhook && typeof webhook.url === "string" ? webhook.url : null;

  if (ok) {
    let label = "ok";
    if (botUsername) label += ` (@${botUsername})`;
    if (elapsedMs != null) label += ` (${elapsedMs}ms)`;
    if (webhookUrl) label += ` - webhook ${webhookUrl}`;
    return label;
  }
  let label = `failed (${status ?? "unknown"})`;
  if (error) label += ` - ${error}`;
  return label;
};

export const formatHealthProviderLines = (summary: HealthSummary): string[] => {
  const providers = summary.providers ?? {};
  const providerOrder =
    summary.providerOrder?.length > 0
      ? summary.providerOrder
      : Object.keys(providers);

  const lines: string[] = [];
  for (const providerId of providerOrder) {
    const providerSummary = providers[providerId];
    if (!providerSummary) continue;
    const plugin = getProviderPlugin(providerId as never);
    const label =
      summary.providerLabels?.[providerId] ?? plugin?.meta.label ?? providerId;
    const linked =
      typeof providerSummary.linked === "boolean"
        ? providerSummary.linked
        : null;
    if (linked !== null) {
      if (linked) {
        const authAgeMs =
          typeof providerSummary.authAgeMs === "number"
            ? providerSummary.authAgeMs
            : null;
        const authLabel =
          authAgeMs != null
            ? ` (auth age ${Math.round(authAgeMs / 60000)}m)`
            : "";
        lines.push(`${label}: linked${authLabel}`);
      } else {
        lines.push(`${label}: not linked`);
      }
      continue;
    }

    const configured =
      typeof providerSummary.configured === "boolean"
        ? providerSummary.configured
        : null;
    if (configured === false) {
      lines.push(`${label}: not configured`);
      continue;
    }

    const probeLine = formatProbeLine(providerSummary.probe);
    if (probeLine) {
      lines.push(`${label}: ${probeLine}`);
      continue;
    }

    if (configured === true) {
      lines.push(`${label}: configured`);
      continue;
    }
    lines.push(`${label}: unknown`);
  }
  return lines;
};

export async function getHealthSnapshot(params?: {
  timeoutMs?: number;
  probe?: boolean;
}): Promise<HealthSummary> {
  const timeoutMs = params?.timeoutMs;
  const cfg = loadConfig();
  const heartbeatSeconds = resolveHeartbeatSeconds(cfg, undefined);
  const storePath = resolveStorePath(cfg.session?.store);
  const store = loadSessionStore(storePath);
  const sessions = Object.entries(store)
    .filter(([key]) => key !== "global" && key !== "unknown")
    .map(([key, entry]) => ({ key, updatedAt: entry?.updatedAt ?? 0 }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const recent = sessions.slice(0, 5).map((s) => ({
    key: s.key,
    updatedAt: s.updatedAt || null,
    age: s.updatedAt ? Date.now() - s.updatedAt : null,
  }));

  const start = Date.now();
  const cappedTimeout = Math.max(1000, timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const doProbe = params?.probe !== false;
  const providers: Record<string, ProviderHealthSummary> = {};
  const providerOrder = listProviderPlugins().map((plugin) => plugin.id);
  const providerLabels: Record<string, string> = {};

  for (const plugin of listProviderPlugins()) {
    providerLabels[plugin.id] = plugin.meta.label ?? plugin.id;
    const accountIds = plugin.config.listAccountIds(cfg);
    const defaultAccountId =
      plugin.config.defaultAccountId?.(cfg) ??
      accountIds[0] ??
      DEFAULT_ACCOUNT_ID;
    const account = plugin.config.resolveAccount(cfg, defaultAccountId);
    const enabled = plugin.config.isEnabled
      ? plugin.config.isEnabled(account, cfg)
      : isAccountEnabled(account);
    const configured = plugin.config.isConfigured
      ? await plugin.config.isConfigured(account, cfg)
      : true;

    let probe: unknown;
    let lastProbeAt: number | null = null;
    if (enabled && configured && doProbe && plugin.status?.probeAccount) {
      try {
        probe = await plugin.status.probeAccount({
          account,
          timeoutMs: cappedTimeout,
          cfg,
        });
        lastProbeAt = Date.now();
      } catch (err) {
        probe = { ok: false, error: formatErrorMessage(err) };
        lastProbeAt = Date.now();
      }
    }

    const snapshot: ProviderAccountSnapshot = {
      accountId: defaultAccountId,
      enabled,
      configured,
    };
    if (probe !== undefined) snapshot.probe = probe;
    if (lastProbeAt) snapshot.lastProbeAt = lastProbeAt;

    const summary = plugin.status?.buildProviderSummary
      ? await plugin.status.buildProviderSummary({
          account,
          cfg,
          defaultAccountId,
          snapshot,
        })
      : undefined;
    const record =
      summary && typeof summary === "object"
        ? (summary as ProviderHealthSummary)
        : ({
            configured,
            probe,
            lastProbeAt,
          } satisfies ProviderHealthSummary);
    if (record.configured === undefined) record.configured = configured;
    if (record.lastProbeAt === undefined && lastProbeAt) {
      record.lastProbeAt = lastProbeAt;
    }
    providers[plugin.id] = record;
  }

  const summary: HealthSummary = {
    ok: true,
    ts: Date.now(),
    durationMs: Date.now() - start,
    providers,
    providerOrder,
    providerLabels,
    heartbeatSeconds,
    sessions: {
      path: storePath,
      count: sessions.length,
      recent,
    },
  };

  return summary;
}

export async function healthCommand(
  opts: { json?: boolean; timeoutMs?: number; verbose?: boolean },
  runtime: RuntimeEnv,
) {
  // Always query the running gateway; do not open a direct Baileys socket here.
  const summary = await withProgress(
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
  );
  // Gateway reachability defines success; provider issues are reported but not fatal here.
  const fatal = false;

  if (opts.json) {
    runtime.log(JSON.stringify(summary, null, 2));
  } else {
    if (opts.verbose) {
      const details = buildGatewayConnectionDetails();
      runtime.log(info("Gateway connection:"));
      for (const line of details.message.split("\n")) {
        runtime.log(`  ${line}`);
      }
    }
    for (const line of formatHealthProviderLines(summary)) {
      runtime.log(line);
    }
    const cfg = loadConfig();
    for (const plugin of listProviderPlugins()) {
      const providerSummary = summary.providers?.[plugin.id];
      if (!providerSummary || providerSummary.linked !== true) continue;
      if (!plugin.status?.logSelfId) continue;
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId =
        plugin.config.defaultAccountId?.(cfg) ??
        accountIds[0] ??
        DEFAULT_ACCOUNT_ID;
      const account = plugin.config.resolveAccount(cfg, defaultAccountId);
      plugin.status.logSelfId({
        account,
        cfg,
        runtime,
        includeProviderPrefix: true,
      });
    }

    runtime.log(info(`Heartbeat interval: ${summary.heartbeatSeconds}s`));
    runtime.log(
      info(
        `Session store: ${summary.sessions.path} (${summary.sessions.count} entries)`,
      ),
    );
    if (summary.sessions.recent.length > 0) {
      runtime.log("Recent sessions:");
      for (const r of summary.sessions.recent) {
        runtime.log(
          `- ${r.key} (${r.updatedAt ? `${Math.round((Date.now() - r.updatedAt) / 60000)}m ago` : "no activity"})`,
        );
      }
    }
  }

  if (fatal) {
    runtime.exit(1);
  }
}
