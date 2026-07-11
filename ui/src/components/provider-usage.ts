// Shared renderer for provider-reported usage snapshots (quota windows,
// billing, provider cost history). Used by the usage dashboard and the
// Model Providers settings page; styles live in styles/usage.css.
import { html, nothing } from "lit";
import type { ProviderUsageSnapshot } from "../../../src/infra/provider-usage.types.js";
import { t } from "../i18n/index.ts";
import { formatTokens } from "../lib/format.ts";

export function formatProviderAmount(amount: number, unit: string): string {
  const normalizedUnit = unit.trim().toUpperCase();
  if (["USD", "EUR", "GBP", "CNY", "JPY"].includes(normalizedUnit)) {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: normalizedUnit,
      maximumFractionDigits: normalizedUnit === "JPY" ? 0 : 2,
    }).format(amount);
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(amount)} ${unit}`;
}

function formatProviderReset(resetAt: number | undefined): string | null {
  if (!resetAt || !Number.isFinite(resetAt)) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(resetAt));
}

function renderProviderBilling(snapshot: ProviderUsageSnapshot) {
  return (snapshot.billing ?? []).map((entry) => {
    const label =
      entry.label ??
      (entry.type === "balance"
        ? t("usage.providerUsage.balance")
        : entry.type === "spend"
          ? t("usage.providerUsage.spend")
          : t("usage.providerUsage.budget"));
    const value =
      entry.type === "budget"
        ? `${formatProviderAmount(entry.used, entry.unit)} / ${formatProviderAmount(entry.limit, entry.unit)}`
        : formatProviderAmount(entry.amount, entry.unit);
    return html`
      <div class="provider-usage-billing-row">
        <span>${label}</span>
        <strong>${value}</strong>
      </div>
    `;
  });
}

function providerHistoryAmount(snapshot: ProviderUsageSnapshot, days: number): number {
  const history = snapshot.costHistory;
  if (!history) {
    return 0;
  }
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoff = today - (Math.max(1, days) - 1) * 86_400_000;
  return history.daily.reduce((total, day) => {
    const time = Date.parse(`${day.date}T00:00:00Z`);
    return Number.isFinite(time) && time >= cutoff && time <= today ? total + day.amount : total;
  }, 0);
}

function renderProviderCostHistory(snapshot: ProviderUsageSnapshot) {
  const history = snapshot.costHistory;
  if (!history || history.daily.length === 0) {
    return nothing;
  }
  const maxAmount = Math.max(...history.daily.map((day) => day.amount), 0);
  const totals = history.daily.reduce(
    (acc, day) => ({
      requests: acc.requests + (day.requests ?? 0),
      input: acc.input + day.inputTokens,
      cache: acc.cache + day.cacheReadTokens + day.cacheWriteTokens,
      output: acc.output + day.outputTokens,
    }),
    { requests: 0, input: 0, cache: 0, output: 0 },
  );
  const windows = [
    [t("usage.providerUsage.today"), providerHistoryAmount(snapshot, 1)],
    [t("usage.providerUsage.last7Days"), providerHistoryAmount(snapshot, 7)],
    [
      t("usage.providerUsage.lastDays", { count: String(history.periodDays) }),
      history.daily.reduce((total, day) => total + day.amount, 0),
    ],
  ] as const;

  return html`
    <div class="provider-cost-history">
      <div class="provider-cost-windows">
        ${windows.map(
          ([label, amount]) => html`
            <div class="provider-cost-window">
              <span>${label}</span>
              <strong>${formatProviderAmount(amount, history.unit)}</strong>
            </div>
          `,
        )}
      </div>
      <div class="provider-cost-chart" aria-label=${t("usage.providerUsage.dailyCost")}>
        ${history.daily.map((day) => {
          const height =
            day.amount > 0 && maxAmount > 0 ? Math.max(3, (day.amount / maxAmount) * 100) : 0;
          return html`<span
            style=${`height: ${height}%`}
            title=${`${day.date}: ${formatProviderAmount(day.amount, history.unit)}`}
            aria-label=${`${day.date}: ${formatProviderAmount(day.amount, history.unit)}`}
          ></span>`;
        })}
      </div>
      <div class="provider-cost-tokens">
        ${totals.requests > 0
          ? html`<span
              >${t("usage.providerUsage.requests", {
                count: new Intl.NumberFormat().format(totals.requests),
              })}</span
            >`
          : nothing}
        <span>${t("usage.providerUsage.inputTokens", { count: formatTokens(totals.input) })}</span>
        <span>${t("usage.providerUsage.cacheTokens", { count: formatTokens(totals.cache) })}</span>
        <span
          >${t("usage.providerUsage.outputTokens", { count: formatTokens(totals.output) })}</span
        >
      </div>
      ${history.models.length > 0 || history.categories.length > 0
        ? html`
            <div class="provider-cost-breakdowns">
              ${history.models.length > 0
                ? html`
                    <div class="provider-cost-breakdown">
                      <span class="provider-cost-breakdown__title"
                        >${t("usage.providerUsage.topModels")}</span
                      >
                      ${history.models
                        .slice(0, 3)
                        .map(
                          (model) => html`
                            <div>
                              <span>${model.name}</span
                              ><strong>${formatTokens(model.totalTokens)}</strong>
                            </div>
                          `,
                        )}
                    </div>
                  `
                : nothing}
              ${history.categories.length > 0
                ? html`
                    <div class="provider-cost-breakdown">
                      <span class="provider-cost-breakdown__title"
                        >${t("usage.providerUsage.costCategories")}</span
                      >
                      ${history.categories.slice(0, 3).map(
                        (category) => html`
                          <div>
                            <span>${category.name}</span>
                            <strong>${formatProviderAmount(category.amount, history.unit)}</strong>
                          </div>
                        `,
                      )}
                    </div>
                  `
                : nothing}
            </div>
          `
        : nothing}
    </div>
  `;
}

/**
 * Card body for one provider usage snapshot: quota windows with progress
 * bars, billing rows, provider cost history, and the provider summary line.
 * The surrounding card header (name, plan badge, icon) stays surface-owned.
 */
export function renderProviderUsageDetails(snapshot: ProviderUsageSnapshot) {
  if (snapshot.error) {
    return html`<div class="provider-usage-error">${snapshot.error}</div>`;
  }
  return html`
    ${snapshot.windows.length > 0
      ? html`
          <div class="provider-usage-windows">
            ${snapshot.windows.map((window) => {
              const used = Math.max(0, Math.min(100, window.usedPercent));
              const remaining = Math.max(0, 100 - used);
              const reset = formatProviderReset(window.resetAt);
              return html`
                <div class="provider-usage-window">
                  <div class="provider-usage-window__meta">
                    <span>${window.label}</span>
                    <strong
                      >${t("usage.providerUsage.remaining", {
                        percent: remaining.toFixed(0),
                      })}</strong
                    >
                  </div>
                  <div
                    class="provider-usage-progress"
                    role="progressbar"
                    aria-label=${window.label}
                    aria-valuemin="0"
                    aria-valuemax="100"
                    aria-valuenow=${used.toFixed(0)}
                  >
                    <span style=${`width: ${used}%`}></span>
                  </div>
                  ${reset
                    ? html`<div class="provider-usage-reset">
                        ${t("usage.providerUsage.resets", { date: reset })}
                      </div>`
                    : nothing}
                </div>
              `;
            })}
          </div>
        `
      : nothing}
    ${snapshot.billing && snapshot.billing.length > 0
      ? html`<div class="provider-usage-billing">${renderProviderBilling(snapshot)}</div>`
      : nothing}
    ${renderProviderCostHistory(snapshot)}
    ${snapshot.summary
      ? html`<div class="provider-usage-summary">${snapshot.summary}</div>`
      : nothing}
  `;
}
