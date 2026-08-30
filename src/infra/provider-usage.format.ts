// Formats provider usage summaries for CLI and status output.
import { clampPercent } from "./provider-usage.shared.js";
import type {
  ProviderUsageBilling,
  ProviderUsageSnapshot,
  UsageSummary,
  UsageWindow,
} from "./provider-usage.types.js";

// Compact reset times for chat/status lines; long windows fall back to a date.
function formatResetRemaining(targetMs?: number, now?: number): string | null {
  if (!targetMs) {
    return null;
  }
  const base = now ?? Date.now();
  const diffMs = targetMs - base;
  if (diffMs <= 0) {
    return "now";
  }

  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) {
    return `${diffMins}m`;
  }

  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours < 24) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ${hours % 24}h`;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(targetMs));
}

function formatWindowShort(window: UsageWindow, now?: number): string {
  const remaining = clampPercent(100 - window.usedPercent);
  const reset = formatResetRemaining(window.resetAt, now);
  const resetSuffix = reset ? ` ⏱${reset}` : "";
  return `${remaining.toFixed(0)}% left (${window.label}${resetSuffix})`;
}

function formatBillingAmount(amount: number, unit: string): string {
  const normalizedUnit = unit.trim().toUpperCase();
  if (normalizedUnit === "USD") {
    return amount < 0 ? `-$${Math.abs(amount).toFixed(2)}` : `$${amount.toFixed(2)}`;
  }
  if (normalizedUnit === "CNY" || normalizedUnit === "RMB") {
    return amount < 0 ? `-¥${Math.abs(amount).toFixed(2)}` : `¥${amount.toFixed(2)}`;
  }
  return `${amount.toFixed(2)} ${unit}`;
}

function formatBillingEntry(entry: ProviderUsageBilling): string {
  const label =
    entry.label ??
    (entry.type === "balance" ? "Balance" : entry.type === "spend" ? "Usage" : "Budget");
  if (entry.type === "budget") {
    return `${label}: ${formatBillingAmount(entry.used, entry.unit)} / ${formatBillingAmount(entry.limit, entry.unit)}`;
  }
  return `${label}: ${formatBillingAmount(entry.amount, entry.unit)}`;
}

/** Formats one provider snapshot into a short usage-window summary. */
export function formatUsageWindowSummary(
  snapshot: ProviderUsageSnapshot,
  opts?: { now?: number; maxWindows?: number; includeResets?: boolean },
): string | null {
  if (snapshot.error) {
    return null;
  }
  if (snapshot.windows.length === 0) {
    const billing = snapshot.billing?.[0];
    return snapshot.summary?.trim() || (billing ? formatBillingEntry(billing) : null);
  }
  const now = opts?.now ?? Date.now();
  const maxWindows =
    typeof opts?.maxWindows === "number" && opts.maxWindows > 0
      ? Math.min(opts.maxWindows, snapshot.windows.length)
      : snapshot.windows.length;
  const includeResets = opts?.includeResets ?? false;
  const windows = snapshot.windows.slice(0, maxWindows);
  const parts = windows.map((window) => {
    const remaining = clampPercent(100 - window.usedPercent);
    const reset = includeResets ? formatResetRemaining(window.resetAt, now) : null;
    const resetSuffix = reset ? ` ⏱${reset}` : "";
    return `${window.label} ${remaining.toFixed(0)}% left${resetSuffix}`;
  });
  return parts.join(" · ");
}

export function formatUsageSummaryLine(
  summary: UsageSummary,
  opts?: { now?: number; maxProviders?: number },
): string | null {
  const providers = summary.providers
    .filter(
      (entry) =>
        (entry.windows.length > 0 ||
          Boolean(entry.summary?.trim()) ||
          Boolean(entry.billing?.length)) &&
        !entry.error,
    )
    .slice(0, opts?.maxProviders ?? summary.providers.length);
  if (providers.length === 0) {
    return null;
  }

  const parts = providers.map((entry) => {
    if (entry.windows.length === 0 && entry.summary?.trim()) {
      return `${entry.displayName} ${entry.summary.trim()}`;
    }
    if (entry.windows.length === 0 && entry.billing?.[0]) {
      return `${entry.displayName} ${formatBillingEntry(entry.billing[0])}`;
    }
    const window = entry.windows.reduce((best, next) =>
      next.usedPercent > best.usedPercent ? next : best,
    );
    return `${entry.displayName} ${formatWindowShort(window, opts?.now)}`;
  });
  return `📊 Usage: ${parts.join(" · ")}`;
}

export function formatUsageReportLines(summary: UsageSummary, opts?: { now?: number }): string[] {
  if (summary.providers.length === 0) {
    return ["Usage: no provider usage available."];
  }

  const lines: string[] = ["Usage:"];
  for (const entry of summary.providers) {
    const planSuffix = entry.plan ? ` (${entry.plan})` : "";
    if (entry.error) {
      lines.push(`  ${entry.displayName}${planSuffix}: ${entry.error}`);
      continue;
    }
    if (entry.windows.length === 0 && !entry.billing?.length) {
      lines.push(`  ${entry.displayName}${planSuffix}: ${entry.summary?.trim() || "no data"}`);
      continue;
    }
    lines.push(`  ${entry.displayName}${planSuffix}`);
    if (entry.summary?.trim()) {
      lines.push(`    ${entry.summary.trim()}`);
    }
    for (const window of entry.windows) {
      const remaining = clampPercent(100 - window.usedPercent);
      const reset = formatResetRemaining(window.resetAt, opts?.now);
      const resetSuffix = reset ? ` · resets ${reset}` : "";
      lines.push(`    ${window.label}: ${remaining.toFixed(0)}% left${resetSuffix}`);
    }
    for (const billing of entry.billing ?? []) {
      lines.push(`    ${formatBillingEntry(billing)}`);
    }
  }
  return lines;
}
