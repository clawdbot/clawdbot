/** Shared CLI formatting for gateway health failures, channels, and delivery queues. */
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { colorize, isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { formatChannelStatusState } from "../channels/plugins/status-state.js";
import type { ChannelAccountHealthSummary, HealthSummary } from "../gateway/health/types.js";
import { isGatewayTransportError } from "../gateway/transport-error.js";
import { formatDurationHuman } from "../infra/format-time/format-duration.js";

export function formatGatewayClosedDiagnostic(err: unknown): string | undefined {
  if (!isGatewayTransportError(err) || err.kind !== "closed" || err.code === undefined) {
    return undefined;
  }
  return `Gateway connect failed: ${sanitizeTerminalText(err.message.split("\n", 1)[0] ?? "")}`;
}

const formatKv = (line: string, rich: boolean) => {
  const idx = line.indexOf(": ");
  if (idx <= 0) {
    return colorize(rich, theme.muted, line);
  }
  const key = line.slice(0, idx);
  const value = line.slice(idx + 2);

  const valueColor =
    key === "Gateway target" || key === "Config"
      ? theme.command
      : key === "Source"
        ? theme.muted
        : theme.info;

  return `${colorize(rich, theme.muted, `${key}:`)} ${colorize(rich, valueColor, value)}`;
};

/** Formats thrown health errors with rich detail lines when terminal color is enabled. */
export function formatHealthCheckFailure(err: unknown, opts: { rich?: boolean } = {}): string {
  const rich = opts.rich ?? isRich();
  const raw = String(err);
  const message = err instanceof Error ? err.message : raw;

  if (!rich) {
    return `Health check failed: ${raw}`;
  }

  const lines = message
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);
  const detailsIdx = lines.findIndex((l) => l.startsWith("Gateway target: "));

  const summaryLines = (detailsIdx >= 0 ? lines.slice(0, detailsIdx) : lines)
    .map((l) => l.trim())
    .filter(Boolean);
  const detailLines = detailsIdx >= 0 ? lines.slice(detailsIdx) : [];

  const summary = summaryLines.length > 0 ? summaryLines.join(" ") : message;
  const header = colorize(rich, theme.error.bold, "Health check failed");

  const out: string[] = [`${header}: ${summary}`];
  for (const line of detailLines) {
    out.push(`  ${formatKv(line, rich)}`);
  }
  return out.join("\n");
}

const formatProbeLine = (
  probe: unknown,
  accounts?: readonly ChannelAccountHealthSummary[],
): string | null => {
  const record = asNullableRecord(probe);
  if (!record) {
    return null;
  }
  const ok = typeof record.ok === "boolean" ? record.ok : undefined;
  if (ok === undefined) {
    return null;
  }
  if (!ok) {
    const status = typeof record.status === "number" ? record.status : null;
    const error = typeof record.error === "string" ? record.error : null;
    return `failed (${status ?? "unknown"})${error ? ` - ${error}` : ""}`;
  }

  const elapsedMs = typeof record.elapsedMs === "number" ? record.elapsedMs : null;
  const bot = asNullableRecord(record.bot);
  const botUsername = bot && typeof bot.username === "string" ? bot.username : null;
  const webhook = asNullableRecord(record.webhook);
  const webhookUrl = webhook && typeof webhook.url === "string" ? webhook.url : null;
  const usernames = new Set<string>();
  if (botUsername) {
    usernames.add(botUsername);
  }
  for (const account of accounts ?? []) {
    const accountProbe = asNullableRecord(account.probe);
    const accountBot = accountProbe ? asNullableRecord(accountProbe.bot) : null;
    if (accountBot && typeof accountBot.username === "string" && accountBot.username) {
      usernames.add(accountBot.username);
    }
  }

  let label = "ok";
  if (usernames.size > 0) {
    label += ` (@${Array.from(usernames).join(", @")})`;
  }
  if (elapsedMs != null) {
    label += ` (${elapsedMs}ms)`;
  }
  if (webhookUrl) {
    label += ` - webhook ${webhookUrl}`;
  }
  return label;
};

const formatAccountProbeTiming = (summary: ChannelAccountHealthSummary): string | null => {
  const probe = asNullableRecord(summary.probe);
  if (!probe) {
    return null;
  }
  const elapsedMs = typeof probe.elapsedMs === "number" ? Math.round(probe.elapsedMs) : null;
  const ok = typeof probe.ok === "boolean" ? probe.ok : null;
  if (elapsedMs == null && ok !== true) {
    return null;
  }

  const accountId = summary.accountId || "default";
  const botRecord = asNullableRecord(probe.bot);
  const botUsername =
    botRecord && typeof botRecord.username === "string" ? botRecord.username : null;
  const handle = botUsername ? `@${botUsername}` : accountId;
  const timing = elapsedMs != null ? `${elapsedMs}ms` : "ok";

  return `${handle}:${accountId}:${timing}`;
};

/** Formats terse channel and activated-plugin health lines for shared CLI surfaces. */
export const formatHealthChannelLines = (
  summary: HealthSummary,
  opts: {
    accountMode?: "default" | "all";
    accountIdsByChannel?: Record<string, string[] | undefined>;
  } = {},
): string[] => {
  const channels = summary.channels ?? {};
  const channelOrder =
    summary.channelOrder?.length > 0 ? summary.channelOrder : Object.keys(channels);
  const accountMode = opts.accountMode ?? "default";

  const lines: string[] = [];
  for (const channelId of channelOrder) {
    const channelSummary = channels[channelId];
    if (!channelSummary) {
      continue;
    }
    const label = summary.channelLabels?.[channelId] ?? channelId;
    const accountSummaries = channelSummary.accounts ?? {};
    const accountIds = accountMode === "all" ? undefined : opts.accountIdsByChannel?.[channelId];
    const listSummaries = accountIds?.length
      ? accountIds.flatMap((accountId) => accountSummaries[accountId] ?? [])
      : Object.values(accountSummaries);
    const preferredSummary = accountIds?.length
      ? (listSummaries[0] ?? channelSummary)
      : channelSummary;
    const activeSummaries = listSummaries.filter(
      (account) =>
        account.enabled !== false &&
        account.configured !== false &&
        account.linked !== false &&
        account.statusState !== "disabled" &&
        account.statusState !== "unconfigured",
    );
    // Preserve active preferred order without letting inactive defaults mask other probes.
    const selectedSummary =
      activeSummaries.find(
        (account) =>
          (account.healthState && account.healthState !== "healthy") ||
          (account.statusState &&
            account.statusState !== "linked" &&
            account.statusState !== "configured"),
      ) ??
      activeSummaries.find((account) => account.accountId === preferredSummary.accountId) ??
      activeSummaries[0] ??
      preferredSummary;
    const statusState =
      typeof selectedSummary.statusState === "string" ? selectedSummary.statusState : null;
    const healthState =
      typeof selectedSummary.healthState === "string" && selectedSummary.healthState
        ? selectedSummary.healthState
        : null;
    const { linked, configured } = selectedSummary;
    const inactiveState =
      selectedSummary.enabled === false
        ? "disabled"
        : statusState === "disabled" || statusState === "unconfigured"
          ? formatChannelStatusState(statusState)
          : configured === false
            ? "not configured"
            : null;
    // Explicit inactive/degraded facts outrank probes; passive success waits until after them.
    // Otherwise a live probe can be hidden behind stale "healthy", "linked", or "configured".
    const preProbeState = inactiveState
      ? inactiveState
      : healthState && healthState !== "healthy"
        ? healthState
        : statusState && statusState !== "linked" && statusState !== "configured"
          ? formatChannelStatusState(statusState)
          : linked === false
            ? "not linked"
            : null;
    if (preProbeState) {
      const error =
        typeof selectedSummary.lastError === "string"
          ? sanitizeTerminalText(selectedSummary.lastError)
          : "";
      lines.push(`${label}: ${preProbeState}${error ? ` (${error})` : ""}`);
      continue;
    }

    const failedSummary = activeSummaries.find(
      (account) => asNullableRecord(account.probe)?.ok === false,
    );
    if (failedSummary) {
      const failureLine = formatProbeLine(failedSummary.probe);
      if (failureLine) {
        lines.push(`${label}: ${failureLine}`);
        continue;
      }
    }

    const accountTimings =
      accountMode === "all"
        ? activeSummaries
            .map((account) => formatAccountProbeTiming(account))
            .filter((value): value is string => Boolean(value))
        : [];

    if (accountTimings.length > 0) {
      lines.push(`${label}: ok (${accountTimings.join(", ")})`);
      continue;
    }

    const probeLine = formatProbeLine(selectedSummary.probe, activeSummaries);
    if (probeLine) {
      lines.push(`${label}: ${probeLine}`);
      continue;
    }

    const authAgeMs =
      typeof selectedSummary.authAgeMs === "number" ? selectedSummary.authAgeMs : null;
    const authLabel = authAgeMs != null ? ` (auth age ${Math.round(authAgeMs / 60000)}m)` : "";
    const passiveState = healthState
      ? healthState
      : statusState
        ? `${formatChannelStatusState(statusState)}${statusState === "linked" ? authLabel : ""}`
        : linked === true
          ? `linked${authLabel}`
          : configured === true
            ? "configured"
            : "unknown";
    lines.push(`${label}: ${passiveState}`);
  }
  const failedPlugins = (summary.plugins?.errors ?? []).filter((plugin) => plugin.activated);
  for (const plugin of failedPlugins.slice(0, 20)) {
    const id = sanitizeTerminalText(plugin.id).slice(0, 120);
    const error = sanitizeTerminalText(plugin.error).slice(0, 500);
    lines.push(`Plugin ${id}: failed - ${error}; run openclaw doctor`);
  }
  if (failedPlugins.length > 20) {
    lines.push(
      `Plugins: failed - ${failedPlugins.length - 20} additional activated failures; run openclaw doctor`,
    );
  }
  return lines;
};

/** Formats dead-lettered and pressured delivery queue entries for text health output. */
export function formatDeliveryQueueHealthLine(
  summary: HealthSummary,
  now = Date.now(),
): string | null {
  const failed = summary.deliveryQueues?.failed ?? [];
  const ingressFailed = summary.deliveryQueues?.ingressFailed ?? [];
  const ingressPressure = summary.deliveryQueues?.ingressPressure ?? [];
  const warnings: string[] = [];
  const deadLetterCounts = [
    ...failed.map((queue) => `${queue.queueName}: ${queue.count}`),
    ...ingressFailed.map(
      (queue) => `inbound ${queue.channelId}/${queue.accountId}: ${queue.count}`,
    ),
  ].join(", ");
  const oldest = [...failed, ...ingressFailed]
    .map((queue) => queue.oldestFailedAt)
    .filter((value): value is number => typeof value === "number");
  const oldestNote =
    oldest.length > 0 ? `; oldest ${formatDurationHuman(now - Math.min(...oldest))} ago` : "";
  if (deadLetterCounts) {
    warnings.push(`dead-lettered entries — ${deadLetterCounts}${oldestNote}`);
  }
  if (ingressPressure.length > 0) {
    const pressureCounts = ingressPressure
      .map(
        (queue) =>
          `inbound ${queue.channelId}/${queue.accountId}: ${queue.laneCount} pressured ${
            queue.laneCount === 1 ? "lane" : "lanes"
          }, ${queue.pendingCount} pending, ${queue.claimedCount} claimed, ${queue.blockedCount} blocked`,
      )
      .join(", ");
    const oldestPressure = Math.min(...ingressPressure.map((queue) => queue.oldestReceivedAt));
    warnings.push(
      `ingress pressure — ${pressureCounts}; oldest ${formatDurationHuman(now - oldestPressure)} ago`,
    );
  }
  return warnings.length > 0 ? `Delivery queue: warning (${warnings.join("; ")})` : null;
}
