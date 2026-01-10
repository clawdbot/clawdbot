import { withProgress } from "../../cli/progress.js";
import {
  type ClawdbotConfig,
  readConfigFileSnapshot,
} from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { formatAge } from "../../infra/provider-summary.js";
import { collectProvidersStatusIssues } from "../../infra/providers-status-issues.js";
import { listProviderPlugins } from "../../providers/plugins/index.js";
import { buildProviderAccountSnapshot } from "../../providers/plugins/status.js";
import type { ProviderAccountSnapshot } from "../../providers/plugins/types.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import {
  type ChatProvider,
  formatProviderAccountLabel,
  requireValidConfig,
} from "./shared.js";

export type ProvidersStatusOptions = {
  json?: boolean;
  probe?: boolean;
  timeout?: string;
};

export function formatGatewayProvidersStatusLines(
  payload: Record<string, unknown>,
): string[] {
  const lines: string[] = [];
  lines.push(theme.success("Gateway reachable."));
  const accountLines = (
    provider: ChatProvider,
    accounts: Array<Record<string, unknown>>,
  ) =>
    accounts.map((account) => {
      const bits: string[] = [];
      if (typeof account.enabled === "boolean") {
        bits.push(account.enabled ? "enabled" : "disabled");
      }
      if (typeof account.configured === "boolean") {
        bits.push(account.configured ? "configured" : "not configured");
      }
      if (typeof account.linked === "boolean") {
        bits.push(account.linked ? "linked" : "not linked");
      }
      if (typeof account.running === "boolean") {
        bits.push(account.running ? "running" : "stopped");
      }
      if (typeof account.connected === "boolean") {
        bits.push(account.connected ? "connected" : "disconnected");
      }
      const inboundAt =
        typeof account.lastInboundAt === "number" &&
        Number.isFinite(account.lastInboundAt)
          ? account.lastInboundAt
          : null;
      const outboundAt =
        typeof account.lastOutboundAt === "number" &&
        Number.isFinite(account.lastOutboundAt)
          ? account.lastOutboundAt
          : null;
      if (inboundAt) bits.push(`in:${formatAge(Date.now() - inboundAt)}`);
      if (outboundAt) bits.push(`out:${formatAge(Date.now() - outboundAt)}`);
      if (typeof account.mode === "string" && account.mode.length > 0) {
        bits.push(`mode:${account.mode}`);
      }
      if (typeof account.dmPolicy === "string" && account.dmPolicy.length > 0) {
        bits.push(`dm:${account.dmPolicy}`);
      }
      if (Array.isArray(account.allowFrom) && account.allowFrom.length > 0) {
        bits.push(`allow:${account.allowFrom.slice(0, 2).join(",")}`);
      }
      if (typeof account.tokenSource === "string" && account.tokenSource) {
        bits.push(`token:${account.tokenSource}`);
      }
      if (
        typeof account.botTokenSource === "string" &&
        account.botTokenSource
      ) {
        bits.push(`bot:${account.botTokenSource}`);
      }
      if (
        typeof account.appTokenSource === "string" &&
        account.appTokenSource
      ) {
        bits.push(`app:${account.appTokenSource}`);
      }
      const application = account.application as
        | { intents?: { messageContent?: string } }
        | undefined;
      const messageContent = application?.intents?.messageContent;
      if (
        typeof messageContent === "string" &&
        messageContent.length > 0 &&
        messageContent !== "enabled"
      ) {
        bits.push(`intents:content=${messageContent}`);
      }
      if (account.allowUnmentionedGroups === true) {
        bits.push("groups:unmentioned");
      }
      if (typeof account.baseUrl === "string" && account.baseUrl) {
        bits.push(`url:${account.baseUrl}`);
      }
      const probe = account.probe as { ok?: boolean } | undefined;
      if (probe && typeof probe.ok === "boolean") {
        bits.push(probe.ok ? "works" : "probe failed");
      }
      const audit = account.audit as { ok?: boolean } | undefined;
      if (audit && typeof audit.ok === "boolean") {
        bits.push(audit.ok ? "audit ok" : "audit failed");
      }
      if (typeof account.lastError === "string" && account.lastError) {
        bits.push(`error:${account.lastError}`);
      }
      const accountId =
        typeof account.accountId === "string" ? account.accountId : "default";
      const name = typeof account.name === "string" ? account.name.trim() : "";
      const labelText = formatProviderAccountLabel({
        provider,
        accountId,
        name: name || undefined,
      });
      return `- ${labelText}: ${bits.join(", ")}`;
    });

  const plugins = listProviderPlugins();
  const accountsByProvider = payload.providerAccounts as
    | Record<string, unknown>
    | undefined;
  const accountPayloads: Partial<
    Record<string, Array<Record<string, unknown>>>
  > = {};
  for (const plugin of plugins) {
    const raw = accountsByProvider?.[plugin.id];
    if (Array.isArray(raw)) {
      accountPayloads[plugin.id] = raw as Array<Record<string, unknown>>;
    }
  }

  for (const plugin of plugins) {
    const accounts = accountPayloads[plugin.id];
    if (accounts && accounts.length > 0) {
      lines.push(...accountLines(plugin.id as ChatProvider, accounts));
    }
  }

  lines.push("");
  const issues = collectProvidersStatusIssues(payload);
  if (issues.length > 0) {
    lines.push(theme.warn("Warnings:"));
    for (const issue of issues) {
      lines.push(
        `- ${issue.provider} ${issue.accountId}: ${issue.message}${issue.fix ? ` (${issue.fix})` : ""}`,
      );
    }
    lines.push(`- Run: clawdbot doctor`);
    lines.push("");
  }
  lines.push(
    `Tip: ${formatDocsLink("/cli#status", "status --deep")} adds gateway health probes to status output (requires a reachable gateway).`,
  );
  return lines;
}

async function formatConfigProvidersStatusLines(
  cfg: ClawdbotConfig,
  meta: { path?: string; mode?: "local" | "remote" },
): Promise<string[]> {
  const lines: string[] = [];
  lines.push(theme.warn("Gateway not reachable; showing config-only status."));
  if (meta.path) {
    lines.push(`Config: ${meta.path}`);
  }
  if (meta.mode) {
    lines.push(`Mode: ${meta.mode}`);
  }
  if (meta.path || meta.mode) lines.push("");

  const accountLines = (
    provider: ChatProvider,
    accounts: Array<Record<string, unknown>>,
  ) =>
    accounts.map((account) => {
      const bits: string[] = [];
      if (typeof account.enabled === "boolean") {
        bits.push(account.enabled ? "enabled" : "disabled");
      }
      if (typeof account.configured === "boolean") {
        bits.push(account.configured ? "configured" : "not configured");
      }
      if (typeof account.linked === "boolean") {
        bits.push(account.linked ? "linked" : "not linked");
      }
      if (typeof account.mode === "string" && account.mode.length > 0) {
        bits.push(`mode:${account.mode}`);
      }
      if (typeof account.tokenSource === "string" && account.tokenSource) {
        bits.push(`token:${account.tokenSource}`);
      }
      if (
        typeof account.botTokenSource === "string" &&
        account.botTokenSource
      ) {
        bits.push(`bot:${account.botTokenSource}`);
      }
      if (
        typeof account.appTokenSource === "string" &&
        account.appTokenSource
      ) {
        bits.push(`app:${account.appTokenSource}`);
      }
      if (typeof account.baseUrl === "string" && account.baseUrl) {
        bits.push(`url:${account.baseUrl}`);
      }
      const accountId =
        typeof account.accountId === "string" ? account.accountId : "default";
      const name = typeof account.name === "string" ? account.name.trim() : "";
      const labelText = formatProviderAccountLabel({
        provider,
        accountId,
        name: name || undefined,
      });
      return `- ${labelText}: ${bits.join(", ")}`;
    });

  const plugins = listProviderPlugins();
  for (const plugin of plugins) {
    const accountIds = plugin.config.listAccountIds(cfg);
    if (!accountIds.length) continue;
    const snapshots: ProviderAccountSnapshot[] = [];
    for (const accountId of accountIds) {
      const snapshot = await buildProviderAccountSnapshot({
        plugin,
        cfg,
        accountId,
      });
      snapshots.push(snapshot);
    }
    if (snapshots.length > 0) {
      lines.push(...accountLines(plugin.id as ChatProvider, snapshots));
    }
  }

  lines.push("");
  lines.push(
    `Tip: ${formatDocsLink("/cli#status", "status --deep")} adds gateway health probes to status output (requires a reachable gateway).`,
  );
  return lines;
}

export async function providersStatusCommand(
  opts: ProvidersStatusOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const timeoutMs = Number(opts.timeout ?? 10_000);
  const statusLabel = opts.probe
    ? "Checking provider status (probe)…"
    : "Checking provider status…";
  const shouldLogStatus = opts.json !== true && !process.stderr.isTTY;
  if (shouldLogStatus) runtime.log(statusLabel);
  try {
    const payload = await withProgress(
      {
        label: statusLabel,
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () =>
        await callGateway({
          method: "providers.status",
          params: { probe: Boolean(opts.probe), timeoutMs },
          timeoutMs,
        }),
    );
    if (opts.json) {
      runtime.log(JSON.stringify(payload, null, 2));
      return;
    }
    runtime.log(
      formatGatewayProvidersStatusLines(
        payload as Record<string, unknown>,
      ).join("\n"),
    );
  } catch (err) {
    runtime.error(`Gateway not reachable: ${String(err)}`);
    const cfg = await requireValidConfig(runtime);
    if (!cfg) return;
    const snapshot = await readConfigFileSnapshot();
    const mode = cfg.gateway?.mode === "remote" ? "remote" : "local";
    runtime.log(
      (
        await formatConfigProvidersStatusLines(cfg, {
          path: snapshot.path,
          mode,
        })
      ).join("\n"),
    );
  }
}
