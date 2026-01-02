import path from "node:path";

import { info, warn } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  collectUsageSummary,
  type UsageRateWindow,
  type UsageTotals,
  type UsageUnifiedWindow,
} from "../infra/usage-monitor.js";

type UsageCommandOptions = {
  json?: boolean;
  sessionsDir?: string;
  tier?: string;
};

const formatTokens = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return `${Math.round(value)}`;
  const precision = value >= 10_000 ? 0 : 1;
  return `${(value / 1000).toFixed(precision)}k`;
};

const formatCost = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "$0";
  const decimals = value < 1 ? 4 : 2;
  return `$${value.toFixed(decimals)}`;
};

const formatTotals = (totals: UsageTotals) =>
  [
    `input ${formatTokens(totals.inputTokens)}`,
    `output ${formatTokens(totals.outputTokens)}`,
    `cache ${formatTokens(totals.cacheTokens)}`,
    `total ${formatTokens(totals.totalTokens)}`,
    `cost ${formatCost(totals.costUsd)}`,
  ].join(" | ");

const formatRate = (window: UsageRateWindow | null) => {
  if (!window) return "n/a";
  const used = formatTokens(window.usedTokens);
  const limit =
    window.limitTokens != null ? formatTokens(window.limitTokens) : "?";
  const pct = window.usedPercent != null ? `${window.usedPercent}%` : "?";
  return `${used}/${limit} (${pct})`;
};

const formatPercent = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return "?";
  const rounded = Math.round(value * 10) / 10;
  return rounded % 1 === 0 ? `${rounded.toFixed(0)}` : `${rounded.toFixed(1)}`;
};

const formatUnifiedWindow = (window: UsageUnifiedWindow | null) => {
  if (!window) return "n/a";
  return `${formatPercent(window.usedPercent)}% used`;
};

const formatResetIn = (resetAt: string | null, asOf: Date) => {
  if (!resetAt) return "reset time unknown";
  const resetMs = Date.parse(resetAt);
  const baseMs = asOf.getTime();
  if (!Number.isFinite(resetMs) || !Number.isFinite(baseMs)) {
    return "reset time unknown";
  }
  const deltaMs = resetMs - baseMs;
  if (deltaMs <= 0) return "reset pending";
  const totalMinutes = Math.ceil(deltaMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `resets in ${hours}h ${minutes}m`;
};

export async function usageCommand(
  opts: UsageCommandOptions,
  runtime: RuntimeEnv,
) {
  const summary = await collectUsageSummary({
    sessionsDir: opts.sessionsDir,
    tier: opts.tier,
  });

  if (opts.json) {
    runtime.log(JSON.stringify(summary, null, 2));
    return;
  }

  runtime.log(info(`Usage (${summary.rateLimits.model})`));
  runtime.log(
    `Sessions: ${summary.sessionCount} (${summary.sessionsDir || "unknown"})`,
  );
  if (summary.rateLimits.mode === "unified") {
    const asOf = new Date(summary.asOf);
    const unified = summary.rateLimits.unified;
    const fiveHour = unified?.fiveHour ?? null;
    const sevenDay = unified?.sevenDay ?? null;
    const fallback = unified?.fallback ?? "unknown";
    runtime.log(
      `5h window: ${formatUnifiedWindow(fiveHour)} (${formatResetIn(
        fiveHour?.resetAt ?? null,
        asOf,
      )})`,
    );
    runtime.log(`7d window: ${formatUnifiedWindow(sevenDay)}`);
    runtime.log(`Fallback: ${fallback}`);
  } else if (summary.rateLimits.perMinute) {
    const perMinute = summary.rateLimits.perMinute;
    const perMinuteLabel =
      perMinute.source === "headers"
        ? `Last minute (rate limits): tokens ${formatRate(perMinute.input)} | requests ${formatRate(perMinute.output)}`
        : `Last minute: input ${formatRate(perMinute.input)} | output ${formatRate(perMinute.output)}`;
    runtime.log(perMinuteLabel);
  }
  runtime.log(`This hour: ${formatTotals(summary.totals.thisHour)}`);
  runtime.log(`Today: ${formatTotals(summary.totals.today)}`);

  if (summary.currentSession) {
    const label =
      summary.currentSession.sessionId ??
      path.basename(summary.currentSession.path);
    runtime.log(
      `Current session (${label}): ${formatTotals(summary.currentSession.totals)}`,
    );
  } else {
    runtime.log("Current session: none");
  }

  if (
    summary.rateLimits.daily &&
    (summary.rateLimits.daily.input || summary.rateLimits.daily.output)
  ) {
    const tierLabel = summary.rateLimits.daily.tier ?? "unknown tier";
    runtime.log(
      `Daily estimate (${tierLabel}): input ${formatRate(summary.rateLimits.daily.input)} | output ${formatRate(summary.rateLimits.daily.output)}`,
    );
  }

  if (summary.warnings.length > 0) {
    runtime.log(warn("Warnings:"));
    for (const warning of summary.warnings) {
      runtime.log(`- ${warning.message}`);
    }
  }
}
