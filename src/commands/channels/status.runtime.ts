// Runtime-only rendering and config fallback for `openclaw channels status`.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import { resolveCommandConfigWithSecrets } from "../../cli/command-config-resolution.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { getConfiguredChannelsCommandSecretTargetIds } from "../../cli/command-secret-targets.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { collectChannelStatusIssues } from "../../infra/channels-status-issues.js";
import { formatDurationCompact } from "../../infra/format-time/format-duration.js";
import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
import { formatPhoneNumberForCli } from "../../infra/phone-number-presentation.js";
import { listConfiguredAnnounceChannelIdsForConfig } from "../../plugins/channel-plugin-ids.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { requireValidConfig } from "../config-validation.js";
import {
  appendBaseUrlBit,
  appendEnabledConfiguredLinkedBits,
  appendModeBit,
  appendTokenSourceBits,
  buildChannelAccountLine,
  type ChatChannel,
} from "./shared.js";
import { formatConfigChannelsStatusLines } from "./status-config-format.js";
import type { ChannelsStatusOptions } from "./status.js";

function formatEventLoopBits(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.degraded !== true) {
    return null;
  }
  const reasons = Array.isArray(record.reasons)
    ? record.reasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  const delayMaxMs =
    typeof record.delayMaxMs === "number" && Number.isFinite(record.delayMaxMs)
      ? Math.round(record.delayMaxMs)
      : null;
  const utilization =
    typeof record.utilization === "number" && Number.isFinite(record.utilization)
      ? record.utilization
      : null;
  const cpuCoreRatio =
    typeof record.cpuCoreRatio === "number" && Number.isFinite(record.cpuCoreRatio)
      ? record.cpuCoreRatio
      : null;
  const degradedSinceMs =
    typeof record.degradedSinceMs === "number" && Number.isFinite(record.degradedSinceMs)
      ? Math.max(0, record.degradedSinceMs)
      : null;
  const delayP99Ms =
    typeof record.delayP99Ms === "number" && Number.isFinite(record.delayP99Ms)
      ? Math.round(record.delayP99Ms)
      : null;
  return [
    degradedSinceMs != null ? `for ${formatDurationCompact(degradedSinceMs) ?? "0s"}` : null,
    delayP99Ms != null ? `(p99 ${delayP99Ms}ms)` : null,
    reasons.length ? `reasons=${reasons.join(",")}` : null,
    delayMaxMs != null ? `eventLoopDelayMaxMs=${delayMaxMs}` : null,
    utilization != null ? `eventLoopUtilization=${utilization}` : null,
    cpuCoreRatio != null ? `cpuCoreRatio=${cpuCoreRatio}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

/** Render gateway channel status payloads into terminal-friendly lines. */
export function formatGatewayChannelsStatusLines(payload: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push(theme.success("Gateway reachable."));
  const eventLoopLine = formatEventLoopBits(payload.eventLoop);
  if (eventLoopLine) {
    lines.push(theme.warn(`Gateway event loop degraded ${eventLoopLine}`));
  }
  const channelLabels =
    payload.channelLabels && typeof payload.channelLabels === "object"
      ? (payload.channelLabels as Record<string, unknown>)
      : {};
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
      const transportAt =
        typeof account.lastTransportActivityAt === "number" &&
        Number.isFinite(account.lastTransportActivityAt)
          ? account.lastTransportActivityAt
          : null;
      if (inboundAt) {
        bits.push(`in:${formatTimeAgo(Date.now() - inboundAt)}`);
      }
      if (outboundAt) {
        bits.push(`out:${formatTimeAgo(Date.now() - outboundAt)}`);
      }
      if (transportAt) {
        bits.push(`transport:${formatTimeAgo(Date.now() - transportAt)}`);
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
        const allowFrom = account.allowFrom
          .slice(0, 2)
          .map((entry) => formatPhoneNumberForCli(String(entry)));
        bits.push(`allow:${allowFrom.join(",")}`);
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
      if (typeof account.healthState === "string" && account.healthState) {
        bits.push(`health:${account.healthState}`);
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
      const rawChannelLabel = channelLabels[provider];
      return buildChannelAccountLine(provider, account, bits, {
        channelLabel: typeof rawChannelLabel === "string" ? rawChannelLabel : provider,
      });
    });

  const accountsByChannel = payload.channelAccounts as Record<string, unknown> | undefined;
  const accountPayloads: Partial<Record<string, Array<Record<string, unknown>>>> = {};
  for (const channelId of Object.keys(accountsByChannel ?? {}).toSorted()) {
    const raw = accountsByChannel?.[channelId];
    if (Array.isArray(raw)) {
      accountPayloads[channelId] = raw as Array<Record<string, unknown>>;
    }
  }
  for (const channelId of Object.keys(accountPayloads).toSorted()) {
    const accounts = accountPayloads[channelId];
    if (accounts && accounts.length > 0) {
      lines.push(...accountLines(channelId, accounts));
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

export async function renderChannelsStatusFallback(params: {
  opts: ChannelsStatusOptions;
  runtime: RuntimeEnv;
  safeError: string;
  gatewayAuthUnavailable: boolean;
}): Promise<void> {
  const { opts, runtime, safeError, gatewayAuthUnavailable } = params;
  const fallbackReason = gatewayAuthUnavailable
    ? "Gateway auth unavailable; showing config-only status."
    : "Gateway not reachable; showing config-only status.";
  runtime.error(
    `${gatewayAuthUnavailable ? "Gateway auth unavailable" : "Gateway not reachable"}: ${safeError}`,
  );
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }
  const { resolvedConfig } = await resolveCommandConfigWithSecrets({
    config: cfg,
    commandName: "channels status",
    targetIds: getConfiguredChannelsCommandSecretTargetIds(cfg),
    mode: "read_only_status",
    runtime,
  });
  const snapshot = await readConfigFileSnapshot();
  const mode = cfg.gateway?.mode === "remote" ? "remote" : "local";
  const requestedChannel = opts.channel
    ? (normalizeChannelId(opts.channel) ?? normalizeOptionalLowercaseString(opts.channel))
    : null;
  if (opts.json) {
    writeRuntimeJson(runtime, {
      gatewayReachable: false,
      error: safeError,
      gatewayAuthUnavailable,
      configOnly: true,
      config: { path: snapshot.path, mode },
      configuredChannels: listConfiguredAnnounceChannelIdsForConfig({
        config: resolvedConfig,
        activationSourceConfig: cfg,
        env: process.env,
      }).filter((channelId) => !requestedChannel || channelId === requestedChannel),
    });
    return;
  }
  runtime.log(
    (
      await formatConfigChannelsStatusLines(
        resolvedConfig,
        { path: snapshot.path, mode },
        { sourceConfig: cfg, channel: opts.channel, fallbackReason },
      )
    ).join("\n"),
  );
}
