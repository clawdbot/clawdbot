// Shared renderer for provider-reported usage snapshots (quota windows,
// billing, provider cost history). Used by the usage dashboard and the
// Models settings page; styles live in styles/usage.css.
import { html, nothing } from "lit";
import type { ProviderUsageSnapshot } from "../../../src/infra/provider-usage.types.js";
import { t } from "../i18n/index.ts";
import { formatUiExternalText } from "../lib/format-error.ts";
import { formatCompactTokenCount } from "../lib/format.ts";

function createProviderAmountFormatter(unit: string): (amount: number) => string {
  const normalizedUnit = unit.trim().toUpperCase();
  if (["USD", "EUR", "GBP", "CNY", "JPY"].includes(normalizedUnit)) {
    const formatter = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: normalizedUnit,
      maximumFractionDigits: normalizedUnit === "JPY" ? 0 : 2,
    });
    return (amount) => formatter.format(amount);
  }
  const formatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  return (amount) => `${formatter.format(amount)} ${unit}`;
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
    const formatAmount = createProviderAmountFormatter(entry.unit);
    const value =
      entry.type === "budget"
        ? `${formatAmount(entry.used)} / ${formatAmount(entry.limit)}`
        : formatAmount(entry.amount);
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
  let maxAmount = 0;
  let periodAmount = 0;
  const totals = { requests: 0, input: 0, cache: 0, output: 0 };
  for (const day of history.daily) {
    maxAmount = Math.max(maxAmount, day.amount);
    periodAmount += day.amount;
    totals.requests += day.requests ?? 0;
    totals.input += day.inputTokens;
    totals.cache = totals.cache + day.cacheReadTokens + day.cacheWriteTokens;
    totals.output += day.outputTokens;
  }
  const inputCount = formatCompactTokenCount(totals.input);
  const cacheCount = formatCompactTokenCount(totals.cache);
  const outputCount = formatCompactTokenCount(totals.output);
  const windows = [
    [t("usage.providerUsage.today"), providerHistoryAmount(snapshot, 1)],
    [t("usage.providerUsage.last7Days"), providerHistoryAmount(snapshot, 7)],
    [t("usage.providerUsage.lastDays", { count: String(history.periodDays) }), periodAmount],
  ] as const;
  const formatAmount = createProviderAmountFormatter(history.unit);

  return html`
    <div class="provider-cost-history">
      <div class="provider-cost-windows">
        ${windows.map(
          ([label, amount]) => html`
            <div class="provider-cost-window">
              <span>${label}</span>
              <strong>${formatAmount(amount)}</strong>
            </div>
          `,
        )}
      </div>
      <div class="provider-cost-chart" aria-label=${t("usage.providerUsage.dailyCost")}>
        ${history.daily.map((day) => {
          const height =
            day.amount > 0 && maxAmount > 0 ? Math.max(3, (day.amount / maxAmount) * 100) : 0;
          const label = `${day.date}: ${formatAmount(day.amount)}`;
          return html`<span
            style=${`height: ${height}%`}
            title=${label}
            aria-label=${label}
          ></span>`;
        })}
      </div>
      <div class="provider-cost-tokens">
        ${
          totals.requests > 0
            ? html`<span
                >${t("usage.providerUsage.requests", {
                  count: new Intl.NumberFormat().format(totals.requests),
                })}</span
              >`
            : nothing
        }
        <span>${t("usage.providerUsage.inputTokens", { count: inputCount })}</span>
        <span>${t("usage.providerUsage.cacheTokens", { count: cacheCount })}</span>
        <span>${t("usage.providerUsage.outputTokens", { count: outputCount })}</span>
      </div>
      ${
        history.models.length > 0 || history.categories.length > 0
          ? html`
              <div class="provider-cost-breakdowns">
                ${
                  history.models.length > 0
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
                                  ><strong>${formatCompactTokenCount(model.totalTokens)}</strong>
                                </div>
                              `,
                            )}
                        </div>
                      `
                    : nothing
                }
                ${
                  history.categories.length > 0
                    ? html`
                        <div class="provider-cost-breakdown">
                          <span class="provider-cost-breakdown__title"
                            >${t("usage.providerUsage.costCategories")}</span
                          >
                          ${history.categories.slice(0, 3).map(
                            (category) => html`
                              <div>
                                <span>${category.name}</span>
                                <strong>${formatAmount(category.amount)}</strong>
                              </div>
                            `,
                          )}
                        </div>
                      `
                    : nothing
                }
              </div>
            `
          : nothing
      }
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
    return html`<div class="provider-usage-error">${formatUiExternalText(snapshot.error)}</div>`;
  }
  return html`
    ${
      snapshot.windows.length > 0
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
                    ${
                      reset
                        ? html`<div class="provider-usage-reset">
                            ${t("usage.providerUsage.resets", { date: reset })}
                          </div>`
                        : nothing
                    }
                  </div>
                `;
              })}
            </div>
          `
        : nothing
    }
    ${
      snapshot.billing && snapshot.billing.length > 0
        ? html`<div class="provider-usage-billing">${renderProviderBilling(snapshot)}</div>`
        : nothing
    }
    ${renderProviderCostHistory(snapshot)}
    ${
      snapshot.summary
        ? html`<div class="provider-usage-summary">${snapshot.summary}</div>`
        : nothing
    }
  `;
}
