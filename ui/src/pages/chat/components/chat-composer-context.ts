import { html, nothing } from "lit";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { normalizeBasePath } from "../../../app-route-paths.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { formatCompactTokenCount, formatCost } from "../../../lib/format.ts";
import { isMonitoredAuthProvider } from "../../../lib/model-auth.ts";
import {
  collectProviderQuotaGroups,
  formatQuotaReset,
  type ProviderQuotaGroup,
  type ProviderUsageDisplayProps,
  type QuotaBudgetSummary,
  type QuotaLimitSummary,
} from "../../../lib/provider-quota-summary.ts";

const CONTEXT_NOTICE_RATIO = 0.85;
const CONTEXT_COMPACT_RATIO = 0.9;

type ContextNoticeOptions = {
  compactBusy?: boolean;
  compactDisabled?: boolean;
  messages?: unknown[];
  onCompact?: () => void | Promise<void>;
  providerUsage?: ProviderUsageDisplayProps;
};

type ProviderCostStats = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  provider: string | null;
  model: string | null;
};

function readCostRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function readCostValue(
  cost: Record<string, unknown> | null,
  key: "input" | "output" | "cacheRead" | "cacheWrite",
) {
  const value = cost?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function latestProviderCostStats(messages: unknown[] | undefined): ProviderCostStats | null {
  if (!messages?.length) {
    return null;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = readCostRecord(messages[index]);
    if (message?.role === "user") {
      return null;
    }
    if (message?.role !== "assistant") {
      continue;
    }
    const directCost = readCostRecord(message.cost);
    const usageCost = readCostRecord(readCostRecord(message.usage)?.cost);
    const stats: ProviderCostStats = {
      provider: typeof message.provider === "string" ? message.provider.trim() || null : null,
      model:
        (typeof message.responseModel === "string" ? message.responseModel.trim() : "") ||
        (typeof message.model === "string" ? message.model.trim() : "") ||
        null,
    };
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      const cost = readCostValue(directCost, key) ?? readCostValue(usageCost, key);
      if (cost !== undefined) {
        stats[key] = cost;
      }
    }
    if (
      [stats.input, stats.output, stats.cacheRead, stats.cacheWrite].some((value) => value != null)
    ) {
      return stats;
    }
  }
  return null;
}

function parseHexRgb(hex: string): [number, number, number] | null {
  const h = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    return null;
  }
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

let cachedThemeNoticeColors: {
  warnHex: string;
  dangerHex: string;
  warnRgb: [number, number, number];
  dangerRgb: [number, number, number];
} | null = null;

function getThemeNoticeColors() {
  if (cachedThemeNoticeColors) {
    return cachedThemeNoticeColors;
  }
  const rootStyle = getComputedStyle(document.documentElement);
  const warnHex = rootStyle.getPropertyValue("--warn").trim() || "#f59e0b";
  const dangerHex = rootStyle.getPropertyValue("--danger").trim() || "#ef4444";
  cachedThemeNoticeColors = {
    warnHex,
    dangerHex,
    warnRgb: parseHexRgb(warnHex) ?? [245, 158, 11],
    dangerRgb: parseHexRgb(dangerHex) ?? [239, 68, 68],
  };
  return cachedThemeNoticeColors;
}

function getContextNoticeViewModel(
  session: GatewaySessionRow | undefined,
  defaultContextTokens: number | null,
): {
  pct: number;
  used: number;
  limit: number;
  input: number | null;
  output: number | null;
  cost: number | null;
  provider: string | null;
  model: string | null;
  detail: string;
  color: string;
  bg: string;
  warning: boolean;
  compactRecommended: boolean;
  approximate: boolean;
} | null {
  const used = session?.totalTokens;
  const limit = session?.contextTokens ?? defaultContextTokens ?? 0;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || !limit) {
    return null;
  }
  const approximate = session?.totalTokensFresh === false;
  const ratio = used / limit;
  const pct = Math.min(Math.round(ratio * 100), 100);
  // A stale total is still useful orientation, but must not drive warning or
  // compaction decisions because the session may already have compacted.
  const warning = !approximate && ratio >= CONTEXT_NOTICE_RATIO;
  // Session rows expose the latest run snapshot; totalTokens is the separate context snapshot.
  const input = Number.isFinite(session?.inputTokens) ? (session?.inputTokens ?? null) : null;
  const output = Number.isFinite(session?.outputTokens) ? (session?.outputTokens ?? null) : null;
  const cost =
    typeof session?.estimatedCostUsd === "number" &&
    Number.isFinite(session.estimatedCostUsd) &&
    session.estimatedCostUsd >= 0
      ? session.estimatedCostUsd
      : null;
  const usage = {
    used,
    limit,
    input,
    output,
    cost,
    provider: session?.modelProvider?.trim() || null,
    model: session?.model?.trim() || null,
  };
  if (!warning) {
    return {
      pct,
      ...usage,
      detail: `${approximate ? "~" : ""}${formatCompactTokenCount(used)} / ${formatCompactTokenCount(limit)}`,
      color: "var(--muted)",
      bg: "color-mix(in srgb, var(--muted) 8%, transparent)",
      warning,
      compactRecommended: false,
      approximate,
    };
  }
  const { warnRgb, dangerRgb } = getThemeNoticeColors();
  const [wr, wg, wb] = warnRgb;
  const [dr, dg, db] = dangerRgb;
  const mix = Math.min(Math.max((ratio - 0.85) / 0.1, 0), 1);
  const r = Math.round(wr + (dr - wr) * mix);
  const g = Math.round(wg + (dg - wg) * mix);
  const b = Math.round(wb + (db - wb) * mix);
  const color = `rgb(${r}, ${g}, ${b})`;
  const bgOpacity = 0.08 + 0.08 * mix;
  const bg = `rgba(${r}, ${g}, ${b}, ${bgOpacity})`;
  return {
    pct,
    ...usage,
    detail: `${formatCompactTokenCount(used)} / ${formatCompactTokenCount(limit)}`,
    color,
    bg,
    warning,
    compactRecommended: ratio >= CONTEXT_COMPACT_RATIO,
    approximate,
  };
}

const RING_RADIUS = 6.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// Provider window labels arrive as compact data strings ("5h", "Week"); model
// scoped labels (e.g. "Opus") pass through untranslated.
function formatUsageWindowLabel(label: string): string {
  if (label === "5h") {
    return t("chat.composer.contextUsage.limitFiveHour");
  }
  if (label === "Week") {
    return t("chat.composer.contextUsage.limitWeekly");
  }
  if (label === "Day") {
    return t("chat.composer.contextUsage.limitDaily");
  }
  const hours = /^(\d+)h$/.exec(label);
  if (hours) {
    return t("chat.composer.contextUsage.limitHours", { hours: hours[1] ?? "" });
  }
  return label;
}

function formatBudgetAmount(amount: number, unit: string): string {
  if (/^[A-Za-z]{3}$/.test(unit)) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: unit.toUpperCase(),
        maximumFractionDigits: 2,
      }).format(amount);
    } catch {
      // Non-ISO currency codes fall through to plain unit suffix formatting.
    }
  }
  return `${amount.toFixed(2)} ${unit}`;
}

function renderLimitBar(usedPercent: number, ariaLabel: string) {
  const severity = usedPercent >= 90 ? "danger" : usedPercent >= 75 ? "warn" : null;
  return html`
    <div
      class="context-usage__limit-bar"
      role="progressbar"
      aria-label=${ariaLabel}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow=${usedPercent}
    >
      <span
        class=${severity ? `context-usage__limit-fill--${severity}` : ""}
        style="width: ${usedPercent}%"
      ></span>
    </div>
  `;
}

function renderQuotaLimitRow(limit: QuotaLimitSummary) {
  const label = formatUsageWindowLabel(limit.label);
  const reset = formatQuotaReset(limit.resetAt);
  return html`
    <div class="context-usage__limit">
      <div class="context-usage__limit-head">
        <span class="context-usage__limit-label">${label}</span>
        <span class="context-usage__limit-meta">
          ${reset
            ? html`<span class="context-usage__limit-reset"
                >${t("chat.composer.contextUsage.resets", { time: reset })}</span
              >`
            : nothing}
          <strong>${limit.usedPercent}%</strong>
        </span>
      </div>
      ${renderLimitBar(limit.usedPercent, label)}
    </div>
  `;
}

function renderQuotaBudgetRow(budget: QuotaBudgetSummary) {
  const label = budget.label || t("chat.composer.contextUsage.usageCredits");
  const usedPercent = Math.max(0, Math.min(100, Math.round((budget.used / budget.limit) * 100)));
  const value = t("chat.composer.contextUsage.budgetValue", {
    used: formatBudgetAmount(budget.used, budget.unit),
    limit: formatBudgetAmount(budget.limit, budget.unit),
  });
  return html`
    <div class="context-usage__limit">
      <div class="context-usage__limit-head">
        <span class="context-usage__limit-label">${label}</span>
        <span class="context-usage__limit-meta"><strong>${value}</strong></span>
      </div>
      ${renderLimitBar(usedPercent, label)}
    </div>
  `;
}

function renderQuotaGroup(
  group: ProviderQuotaGroup,
  options: { usageHref: string; showProvider: boolean },
) {
  const heading = options.showProvider
    ? `${t("chat.composer.contextUsage.planUsage")} · ${group.displayName}`
    : t("chat.composer.contextUsage.planUsage");
  return html`
    <div class="context-usage__section-label context-usage__plan-header">
      <span>${heading}</span>
      <a
        class="context-usage__plan-link"
        href=${options.usageHref}
        data-chat-provider-usage="true"
        aria-label=${t("chat.composer.contextUsage.openUsage")}
      >
        ${group.plan ? html`<span class="context-usage__plan-badge">${group.plan}</span>` : nothing}
        ${icons.externalLink}
      </a>
    </div>
    ${group.accountEmail
      ? html`<div class="context-usage__account" data-chat-usage-account="true">
          ${group.accountEmail}
        </div>`
      : nothing}
    <div class="context-usage__limits">
      ${group.windows.map((limit) => renderQuotaLimitRow(limit))}
      ${group.budgets.map((budget) => renderQuotaBudgetRow(budget))}
    </div>
  `;
}

export function renderContextNotice(
  session: GatewaySessionRow | undefined,
  defaultContextTokens: number | null,
  options: ContextNoticeOptions = {},
) {
  const model = getContextNoticeViewModel(session, defaultContextTokens);
  const quotaGroups = options.providerUsage
    ? collectProviderQuotaGroups(
        options.providerUsage.modelAuthStatusResult ?? null,
        isMonitoredAuthProvider,
      )
    : [];
  if (!model && quotaGroups.length === 0) {
    return nothing;
  }
  const canRenderCompact = Boolean(model?.compactRecommended && options.onCompact);
  const compactDisabled = options.compactDisabled === true || options.compactBusy === true;
  const summary = model
    ? t("chat.composer.contextUsage.summary", {
        used: `${model.approximate ? "~" : ""}${formatCompactTokenCount(model.used)}`,
        limit: formatCompactTokenCount(model.limit),
        pct: `${model.approximate ? "~" : ""}${model.pct}`,
      })
    : t("chat.usageRemaining");
  const percentage = model ? `${model.approximate ? "~" : ""}${model.pct}%` : null;
  const dashOffset = model ? RING_CIRCUMFERENCE * (1 - model.pct / 100) : RING_CIRCUMFERENCE;
  const providerCosts = model ? latestProviderCostStats(options.messages) : null;
  const provider = providerCosts?.provider ?? model?.provider;
  const responseModel = providerCosts?.model ?? model?.model;
  const sessionProviderKeys = new Set(
    [model?.provider, providerCosts?.provider]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.trim().toLowerCase()),
  );
  const currentGroup = quotaGroups.find((group) =>
    group.providers.some((id) => sessionProviderKeys.has(id.trim().toLowerCase())),
  );
  const planGroups = currentGroup
    ? [currentGroup, ...quotaGroups.filter((group) => group !== currentGroup)]
    : quotaGroups;
  // Plan-billed sessions hide dollar estimates: subscription usage is bounded
  // by the plan windows below, and per-token math would misread as real spend.
  // Billing mode is provider-level: session rows do not record which auth
  // profile served the run, so a provider with both an API key and a
  // subscription resolves to subscription display (per-run credential
  // attribution is #102807).
  const showCosts = !currentGroup;
  const usageHref = `${normalizeBasePath(options.providerUsage?.basePath ?? "")}/usage`;
  const formatStat = (value: number | null) =>
    value === null ? t("usage.common.emptyValue") : formatCompactTokenCount(value);
  const renderCostStat = (label: string, value: number | undefined) =>
    value === undefined
      ? nothing
      : html`
          <div>
            <dt>${label}</dt>
            <dd>${formatCost(value)}</dd>
          </div>
        `;
  return html`
    <div
      class="context-usage"
      style=${model ? `--ctx-color:${model.color};--ctx-bg:${model.bg}` : ""}
    >
      <details>
        <summary
          class="context-ring ${model?.warning ? "context-ring--warning" : ""}"
          aria-label=${summary}
          title=${t("chat.composer.contextUsage.open")}
        >
          <svg
            class="context-ring__dial"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            aria-hidden="true"
          >
            <circle class="context-ring__track" cx="8" cy="8" r=${RING_RADIUS} />
            <circle
              class="context-ring__fill"
              cx="8"
              cy="8"
              r=${RING_RADIUS}
              stroke-dasharray=${RING_CIRCUMFERENCE.toFixed(2)}
              stroke-dashoffset=${dashOffset.toFixed(2)}
            />
          </svg>
          ${percentage ? html`<span class="context-ring__pct">${percentage}</span>` : nothing}
        </summary>
        <section class="context-usage__popover" aria-label=${t("chat.composer.contextUsage.title")}>
          ${model
            ? html`
                <div class="context-usage__header">
                  <span class="context-usage__title"
                    >${t("chat.composer.contextUsage.contextWindow")}</span
                  >
                  <strong class="context-usage__context-value"
                    >${model.detail} · ${percentage}</strong
                  >
                </div>
                <div
                  class="context-usage__bar"
                  role="progressbar"
                  aria-label=${summary}
                  aria-valuemin="0"
                  aria-valuemax="100"
                  aria-valuenow=${model.pct}
                >
                  <span style="width: ${model.pct}%"></span>
                </div>
              `
            : nothing}
          ${model
            ? html`
                <div class="context-usage__section-label">
                  ${t("chat.composer.contextUsage.latestRunTokens")}
                </div>
                <dl class="context-usage__stats">
                  <div>
                    <dt>${t("usage.breakdown.input")}</dt>
                    <dd>${formatStat(model.input)}</dd>
                  </div>
                  <div>
                    <dt>${t("usage.breakdown.output")}</dt>
                    <dd>${formatStat(model.output)}</dd>
                  </div>
                  ${!showCosts || model.cost === null
                    ? nothing
                    : html`
                        <div>
                          <dt>${t("chat.composer.contextUsage.estimatedCost")}</dt>
                          <dd>${formatCost(model.cost)}</dd>
                        </div>
                      `}
                </dl>
              `
            : nothing}
          ${showCosts && providerCosts
            ? html`
                <div class="context-usage__section-label">${t("usage.breakdown.costByType")}</div>
                <dl class="context-usage__stats context-usage__stats--cost">
                  ${renderCostStat(t("usage.breakdown.input"), providerCosts.input)}
                  ${renderCostStat(t("usage.breakdown.output"), providerCosts.output)}
                  ${renderCostStat(t("usage.breakdown.cacheRead"), providerCosts.cacheRead)}
                  ${renderCostStat(t("usage.breakdown.cacheWrite"), providerCosts.cacheWrite)}
                </dl>
              `
            : nothing}
          ${planGroups.map((group) =>
            renderQuotaGroup(group, {
              usageHref,
              showProvider: planGroups.length > 1,
            }),
          )}
          ${provider
            ? html`
                <div class="context-usage__model">
                  <span>${t("sessionsView.provider")}:</span>
                  <strong>${provider}</strong>
                </div>
              `
            : nothing}
          ${responseModel
            ? html`
                <div class="context-usage__model">
                  <span>${t("sessionsView.model")}:</span>
                  <strong>${responseModel}</strong>
                </div>
              `
            : nothing}
        </section>
      </details>
      ${canRenderCompact
        ? html`
            <button
              class="context-ring__action ${options.compactBusy
                ? "context-ring__action--busy"
                : ""}"
              type="button"
              aria-label=${t("chat.composer.compactRecommendedContext")}
              ?disabled=${compactDisabled}
              @click=${(event: Event) => {
                event.preventDefault();
                event.stopPropagation();
                if (compactDisabled) {
                  return;
                }
                void options.onCompact?.();
              }}
            >
              ${options.compactBusy ? icons.loader : icons.minimize}
              <span>${options.compactBusy ? "Compacting" : "Compact"}</span>
            </button>
          `
        : nothing}
    </div>
  `;
}
