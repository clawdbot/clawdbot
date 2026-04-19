import { listChannelPlugins } from "../../channels/plugins/index.js";
import { resolveCommandConfigWithSecrets } from "../../cli/command-config-resolution.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { getChannelsCommandSecretTargetIds } from "../../cli/command-secret-targets.js";
import { withProgress } from "../../cli/progress.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { collectChannelStatusIssues } from "../../infra/channels-status-issues.js";
import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import {
  appendBaseUrlBit,
  appendEnabledConfiguredLinkedBits,
  appendModeBit,
  appendTokenSourceBits,
  buildChannelAccountLine,
  type ChatChannel,
  requireValidConfigSnapshot,
} from "./shared.js";
import { formatConfigChannelsStatusLines } from "./status-config-format.js";

export { formatConfigChannelsStatusLines } from "./status-config-format.js";

export type ChannelsStatusOptions = {
  json?: boolean;
  probe?: boolean;
  timeout?: string;
};

export function formatGatewayChannelsStatusLines(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(theme.success("Gateway reachable."));
  const accountLines = (provider: ChatChannel, accounts: Array<Record<string, unknown>>) =>
    accounts.map((account) => {
      const bits: string[] = [];
      appendEnabledConfiguredLinkedBits(bits, account);
      if (typeof account.running === "boolean") {
        bits.push(account.running ? "running" : "stopped");
      }
      if (typeof account.connected === "boolean") {
        bits.push(account.connected ? "connected" : "disconnected");
      }
      const inboundAt =
        typeof account.lastInboundAt === "number" && Number.isFinite(account.lastInboundAt)
          ? account.lastInboundAt
          : null;
      const outboundAt =
        typeof account.lastOutboundAt === "number" && Number.isFinite(account.lastOutboundAt)
          ? account.lastOutboundAt
          : null;
      if (inboundAt) {
        bits.push(`in:${formatTimeAgo(Date.now() - inboundAt)}`);
      }
      if (outboundAt) {
        bits.push(`out:${formatTimeAgo(Date.now() - outboundAt)}`);
      }
      appendModeBit(bits, account);
      const botUsername = (() => {
        const bot = account.bot as { username?: string | null } | undefined;
        const probeBot = (account.probe as { bot?: { username?: string | null } } | undefined)?.bot;
        const raw = bot?.username ?? probeBot?.username ?? "";
        if (typeof raw !== "string") {
          return "";
        }
        const trimmed = raw.trim();
        if (!trimmed) {
          return "";
        }
        return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
      })();
      if (botUsername) {
        bits.push(`bot:${botUsername}`);
      }
      if (typeof account.dmPolicy === "string" && account.dmPolicy.length > 0) {
        bits.push(`dm:${account.dmPolicy}`);
      }
      if (Array.isArray(account.allowFrom) && account.allowFrom.length > 0) {
        bits.push(`allow:${account.allowFrom.slice(0, 2).join(",")}`);
      }
      appendTokenSourceBits(bits, account);
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
      appendBaseUrlBit(bits, account);
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
      return buildChannelAccountLine(provider, account, bits);
    });

  const plugins = listChannelPlugins();
  const accountsByChannel = payload.channelAccounts as Record<string, unknown> | undefined;
  const accountPayloads: Partial<Record<string, Array<Record<string, unknown>>>> = {};
  for (const plugin of plugins) {
    const raw = accountsByChannel?.[plugin.id];
    if (Array.isArray(raw)) {
      accountPayloads[plugin.id] = raw as Array<Record<string, unknown>>;
    }
  }

  for (const plugin of plugins) {
    const accounts = accountPayloads[plugin.id];
    if (accounts && accounts.length > 0) {
      lines.push(...accountLines(plugin.id, accounts));
    }
  }

  lines.push("");
  const issues = collectChannelStatusIssues(payload);
  if (issues.length > 0) {
    lines.push(theme.warn("Warnings:"));
    for (const issue of issues) {
      lines.push(
        `- ${issue.channel} ${issue.accountId}: ${issue.message}${issue.fix ? ` (${issue.fix})` : ""}`,
      );
    }
    lines.push(`- Run: ${formatCliCommand("openclaw doctor")}`);
    lines.push("");
  }
  lines.push(
    `Tip: ${formatDocsLink("/cli#status", "status --deep")} adds gateway health probes to status output (requires a reachable gateway).`,
  );
  return lines;
}

export async function channelsStatusCommand(
  opts: ChannelsStatusOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const timeoutMs = Number(opts.timeout ?? 10_000);
  const statusLabel = opts.probe ? "Checking channel status (probe)…" : "Checking channel status…";
  const shouldLogStatus = opts.json !== true && !process.stderr.isTTY;
  if (shouldLogStatus) {
    runtime.log(statusLabel);
  }
  try {
    const payload = await withProgress(
      {
        label: statusLabel,
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () =>
        await callGateway({
          method: "channels.status",
          params: { probe: Boolean(opts.probe), timeoutMs },
          timeoutMs,
        }),
    );
    if (opts.json) {
      writeRuntimeJson(runtime, payload);
      return;
    }
    runtime.log(formatGatewayChannelsStatusLines(payload).join("\n"));
  } catch (err) {
    runtime.error(`Gateway not reachable: ${String(err)}`);
    const cfg = await requireValidConfigSnapshot(runtime);
    if (!cfg) {
      return;
    }
    const { resolvedConfig } = await resolveCommandConfigWithSecrets({
      config: cfg,
      commandName: "channels status",
      targetIds: getChannelsCommandSecretTargetIds(),
      mode: "read_only_status",
      runtime,
    });
    const snapshot = await readConfigFileSnapshot();
    const mode = cfg.gateway?.mode === "remote" ? "remote" : "local";
    runtime.log(
      (
        await formatConfigChannelsStatusLines(
          resolvedConfig,
          {
            path: snapshot.path,
            mode,
          },
          { sourceConfig: cfg },
        )
      ).join("\n"),
    );
  }
}
