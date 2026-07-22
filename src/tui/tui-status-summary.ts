// Formats status summaries shown in the TUI header and overlays.
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import { formatTokenCount } from "../utils/usage-format.js";
import { createTuiLocalization, type TuiLocalization } from "./i18n/runtime.js";
import { formatContextUsageLine } from "./tui-formatters.js";
import type { GatewayStatusSummary } from "./tui-types.js";

function formatLocalizedTimeAgo(durationMs: number, localization: TuiLocalization): string {
  if (localization.context.locale === "en") {
    return formatTimeAgo(durationMs);
  }
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return localization.t("tui.status.unknown");
  }
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 1) {
    return localization.t("tui.status.relative.justNow");
  }
  if (minutes < 60) {
    return localization.t("tui.status.relative.minutesAgo", { count: minutes });
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return localization.t("tui.status.relative.hoursAgo", { count: hours });
  }
  return localization.t("tui.status.relative.daysAgo", { count: Math.round(hours / 24) });
}

/** Formats Gateway/session health into compact status lines for the TUI. */
export function formatStatusSummary(
  summary: GatewayStatusSummary,
  localization: TuiLocalization = createTuiLocalization(),
) {
  const lines: string[] = [];
  lines.push(localization.t("tui.status.heading"));
  if (summary.runtimeVersion) {
    lines.push(localization.t("tui.status.version", { version: summary.runtimeVersion }));
  }

  if (!summary.linkChannel) {
    lines.push(localization.t("tui.status.linkChannelUnknown"));
  } else {
    const linkLabel = summary.linkChannel.label ?? localization.t("tui.status.linkChannelLabel");
    const linked = summary.linkChannel.linked === true;
    const authAge =
      linked && typeof summary.linkChannel.authAgeMs === "number"
        ? localization.t("tui.status.lastRefreshed", {
            age: formatLocalizedTimeAgo(summary.linkChannel.authAgeMs, localization),
          })
        : "";
    lines.push(
      `${linkLabel}: ${localization.t(linked ? "tui.status.linked" : "tui.status.notLinked")}${authAge}`,
    );
  }

  const providerSummary = Array.isArray(summary.providerSummary) ? summary.providerSummary : [];
  if (providerSummary.length > 0) {
    lines.push("");
    lines.push(localization.t("tui.status.systemHeading"));
    for (const line of providerSummary) {
      lines.push(`  ${line}`);
    }
  }

  const heartbeatAgents = summary.heartbeat?.agents ?? [];
  if (heartbeatAgents.length > 0) {
    const heartbeatParts = heartbeatAgents.map((agent) => {
      const agentId = agent.agentId ?? localization.t("tui.status.unknown");
      if (!agent.enabled || !agent.everyMs) {
        return localization.t("tui.status.disabledAgent", { agent: agentId });
      }
      return `${agent.every ?? localization.t("tui.status.unknown")} (${agentId})`;
    });
    lines.push("");
    lines.push(localization.t("tui.status.heartbeat", { summary: heartbeatParts.join(", ") }));
  }

  const sessionPaths = summary.sessions?.paths ?? [];
  if (sessionPaths.length === 1) {
    lines.push(localization.t("tui.status.sessionStore", { path: sessionPaths[0] ?? "" }));
  } else if (sessionPaths.length > 1) {
    lines.push(localization.t("tui.status.sessionStores", { count: sessionPaths.length }));
  }

  const defaults = summary.sessions?.defaults;
  const defaultModel = defaults?.model ?? localization.t("tui.status.unknown");
  const defaultCtx =
    typeof defaults?.contextTokens === "number"
      ? localization.t("tui.status.contextSuffix", {
          tokens: formatTokenCount(defaults.contextTokens),
        })
      : "";
  lines.push(
    localization.t("tui.status.defaultModel", { model: defaultModel, context: defaultCtx }),
  );

  const sessionCount = summary.sessions?.count ?? 0;
  lines.push(localization.t("tui.status.activeSessions", { count: sessionCount }));

  const recent = Array.isArray(summary.sessions?.recent) ? summary.sessions?.recent : [];
  if (recent.length > 0) {
    lines.push(localization.t("tui.status.recentSessions"));
    for (const entry of recent) {
      // Keep each recent session on one scan-friendly line for narrow terminal output.
      const ageLabel =
        typeof entry.age === "number"
          ? formatLocalizedTimeAgo(entry.age, localization)
          : localization.t("tui.status.noActivity");
      const model = entry.model ?? localization.t("tui.status.unknown");
      const usage = formatContextUsageLine(
        {
          total: entry.totalTokens ?? null,
          context: entry.contextTokens ?? null,
          remaining: entry.remainingTokens ?? null,
          percent: entry.percentUsed ?? null,
        },
        localization,
      );
      const flags = entry.flags?.length
        ? localization.t("tui.status.flags", { flags: entry.flags.join(", ") })
        : "";
      lines.push(
        localization.t("tui.status.recentSession", {
          session: entry.key,
          kind: entry.kind ? ` [${entry.kind}]` : "",
          age: ageLabel,
          model,
          usage,
          flags,
        }),
      );
    }
  }

  const queued = Array.isArray(summary.queuedSystemEvents) ? summary.queuedSystemEvents : [];
  if (queued.length > 0) {
    const preview = queued.slice(0, 3).join(" | ");
    lines.push(localization.t("tui.status.queuedEvents", { count: queued.length, preview }));
  }

  return lines;
}
