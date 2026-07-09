// Control UI module implements provider quota summary behavior.
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { ModelAuthStatusProvider, ModelAuthStatusResult } from "../api/types.ts";

export type QuotaWindowSummary = {
  displayName: string;
  label: string;
  remaining: number;
  resetAt?: number;
};

export function formatQuotaReset(resetAt?: number): string | null {
  const timestampMs = asDateTimestampMs(resetAt);
  if (timestampMs === undefined) {
    return null;
  }
  const diffMs = timestampMs - Date.now();
  if (diffMs <= 0) {
    return "now";
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  return new Date(timestampMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function collectQuotaWindows(
  providers: ReadonlyArray<ModelAuthStatusProvider>,
): QuotaWindowSummary[] {
  return providers
    .flatMap((provider) =>
      (provider.usage?.windows ?? []).map((window) => ({
        displayName: provider.displayName,
        label: (window.label || "").trim(),
        remaining: Math.max(0, Math.min(100, Math.round(100 - window.usedPercent))),
        resetAt: window.resetAt,
      })),
    )
    .toSorted((a, b) => a.remaining - b.remaining || a.displayName.localeCompare(b.displayName));
}

export function collectQuotaWindowsFromAuthStatus(
  status: ModelAuthStatusResult | null,
  filter: (provider: ModelAuthStatusProvider) => boolean,
): QuotaWindowSummary[] {
  return collectQuotaWindows((status?.providers ?? []).filter(filter));
}

/** Auth-status source props for surfaces that render provider plan usage. */
export type ProviderUsageDisplayProps = {
  basePath?: string;
  modelAuthStatusResult?: ModelAuthStatusResult | null;
};

export type QuotaLimitSummary = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

export type QuotaBudgetSummary = {
  label?: string;
  used: number;
  limit: number;
  unit: string;
};

export type ProviderQuotaGroup = {
  /** Auth provider ids sharing this usage payload (e.g. anthropic + claude-cli). */
  providers: string[];
  displayName: string;
  plan?: string;
  windows: QuotaLimitSummary[];
  budgets: QuotaBudgetSummary[];
};

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Groups provider usage windows and budget billing into per-provider plan
 * summaries. Rows that share one usage payload (the same subscription exposed
 * through several auth provider ids) collapse into a single group so the
 * popover never repeats identical bars.
 */
export function collectProviderQuotaGroups(
  status: ModelAuthStatusResult | null,
  filter: (provider: ModelAuthStatusProvider) => boolean,
): ProviderQuotaGroup[] {
  const groups: Array<{ identity: string; group: ProviderQuotaGroup }> = [];
  for (const provider of (status?.providers ?? []).filter(filter)) {
    const usage = provider.usage;
    if (!usage) {
      continue;
    }
    const windows: QuotaLimitSummary[] = (usage.windows ?? []).map((limit) => {
      const summary: QuotaLimitSummary = {
        label: (limit.label || "").trim(),
        usedPercent: clampPercent(limit.usedPercent),
      };
      if (limit.resetAt !== undefined) {
        summary.resetAt = limit.resetAt;
      }
      return summary;
    });
    const budgets: QuotaBudgetSummary[] = (usage.billing ?? []).flatMap((entry) => {
      if (
        entry.type !== "budget" ||
        !Number.isFinite(entry.used) ||
        !Number.isFinite(entry.limit) ||
        entry.used < 0 ||
        entry.limit <= 0
      ) {
        return [];
      }
      const budget: QuotaBudgetSummary = {
        used: entry.used,
        limit: entry.limit,
        unit: entry.unit,
      };
      if (entry.label) {
        budget.label = entry.label;
      }
      return [budget];
    });
    if (windows.length === 0 && budgets.length === 0) {
      continue;
    }
    // Session rows report canonical model providers while auth rows may use
    // CLI aliases (claude-cli vs anthropic); expose both ids for matching.
    const providerIds = [
      ...new Set([provider.provider, usage.providerId].filter((id): id is string => Boolean(id))),
    ];
    const identity = JSON.stringify([provider.displayName, windows, budgets]);
    const existing = groups.find((group) => group.identity === identity);
    if (existing) {
      for (const id of providerIds) {
        if (!existing.group.providers.includes(id)) {
          existing.group.providers.push(id);
        }
      }
      continue;
    }
    groups.push({
      identity,
      group: {
        providers: providerIds,
        displayName: provider.displayName,
        ...(usage.plan ? { plan: usage.plan } : {}),
        windows,
        budgets,
      },
    });
  }
  return groups.map((entry) => entry.group);
}
