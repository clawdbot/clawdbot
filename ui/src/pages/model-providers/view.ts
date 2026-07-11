// Control UI view renders the Model Providers settings page content.
import { html, nothing } from "lit";
import { renderProviderBrandIcon } from "../../components/provider-icon.ts";
import { renderProviderUsageDetails } from "../../components/provider-usage.ts";
import { t } from "../../i18n/index.ts";
import { formatCost, formatTimeMs, formatTokens } from "../../lib/format.ts";
import type { ModelProviderAuthKind, ModelProviderCard } from "./data.ts";

export type ModelProvidersViewProps = {
  connected: boolean;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  updatedAt: number | null;
  costDays: number;
  cards: ModelProviderCard[];
  onRefresh: () => void;
};

const AUTH_KIND_I18N: Record<ModelProviderAuthKind, string> = {
  ok: "modelProviders.status.ok",
  expiring: "modelProviders.status.expiring",
  expired: "modelProviders.status.expired",
  missing: "modelProviders.status.missing",
  "api-key": "modelProviders.status.apiKey",
};

function renderAuthBadge(card: ModelProviderCard) {
  const auth = card.auth;
  if (!auth) {
    return nothing;
  }
  const label = t(AUTH_KIND_I18N[auth.kind]);
  const detail = auth.expiryLabel
    ? t("modelProviders.expiresIn", { time: auth.expiryLabel })
    : undefined;
  return html`
    <span
      class="model-providers__status model-providers__status--${auth.kind}"
      title=${detail ?? label}
    >
      ${label}
    </span>
  `;
}

function renderModelsLine(card: ModelProviderCard) {
  if (card.modelCount === 0) {
    return nothing;
  }
  const text =
    card.availableModelCount < card.modelCount
      ? t("modelProviders.modelsAvailable", {
          available: String(card.availableModelCount),
          count: String(card.modelCount),
        })
      : card.modelCount === 1
        ? t("modelProviders.modelOne")
        : t("modelProviders.models", { count: String(card.modelCount) });
  return html`<div class="model-providers__models">${text}</div>`;
}

// formatTokens tops out at "M"; month-scale provider totals can cross a
// billion tokens, which would render as e.g. "4132M".
function formatTokenTotal(tokens: number): string {
  if (tokens >= 1_000_000_000) {
    const billions = tokens / 1_000_000_000;
    return billions < 10 ? `${billions.toFixed(1)}B` : `${Math.round(billions)}B`;
  }
  return formatTokens(tokens);
}

function renderLocalCost(card: ModelProviderCard, costDays: number) {
  const cost = card.localCost;
  if (!cost || (cost.totalTokens === 0 && cost.totalCost === 0)) {
    return nothing;
  }
  return html`
    <div class="model-providers__local-cost">
      <div class="provider-usage-billing-row">
        <span>${t("modelProviders.localCost", { days: String(costDays) })}</span>
        <strong>${formatCost(cost.totalCost)}</strong>
      </div>
      <div class="model-providers__local-cost-detail">
        ${t("modelProviders.localCostDetail", {
          tokens: formatTokenTotal(cost.totalTokens),
          sessions: String(cost.sessionCount),
        })}
      </div>
    </div>
  `;
}

function renderCard(card: ModelProviderCard, costDays: number) {
  return html`
    <article class="provider-usage-card model-providers__card">
      <div class="provider-usage-card__header">
        <div class="model-providers__identity">
          ${renderProviderBrandIcon(card.id, { className: "model-providers__icon" })}
          <div>
            <div class="provider-usage-card__name">${card.displayName}</div>
            <div class="provider-usage-card__id">${card.id}</div>
          </div>
        </div>
        <div class="model-providers__badges">
          ${card.usage?.plan
            ? html`<span class="provider-usage-plan">${card.usage.plan}</span>`
            : nothing}
          ${renderAuthBadge(card)}
        </div>
      </div>
      ${renderModelsLine(card)}
      ${card.usage
        ? renderProviderUsageDetails(card.usage)
        : html`<div class="model-providers__no-stats">${t("modelProviders.noStats")}</div>`}
      ${renderLocalCost(card, costDays)}
    </article>
  `;
}

export function renderModelProviders(props: ModelProvidersViewProps) {
  if (!props.connected) {
    return html`
      <section class="card">
        <div class="card-sub">${t("modelProviders.disconnected")}</div>
      </section>
    `;
  }
  if (props.loading) {
    return html`
      <section class="card provider-usage-section" aria-busy="true">
        <div class="usage-skeleton-block"></div>
        <div class="usage-skeleton-block"></div>
      </section>
    `;
  }
  return html`
    <section class="card provider-usage-section model-providers">
      <div class="provider-usage-heading">
        <div>
          <div class="card-title usage-section-title">${t("modelProviders.title")}</div>
          <div class="card-sub">
            ${props.updatedAt
              ? t("modelProviders.updated", { time: formatTimeMs(props.updatedAt) })
              : t("modelProviders.subtitle")}
          </div>
        </div>
        <div class="model-providers__actions">
          <span class="provider-usage-count">${props.cards.length}</span>
          <button
            class="btn btn--sm"
            ?disabled=${props.refreshing}
            @click=${() => props.onRefresh()}
          >
            ${props.refreshing ? t("modelProviders.refreshing") : t("common.refresh")}
          </button>
        </div>
      </div>
      ${props.error ? html`<div class="provider-usage-error">${props.error}</div>` : nothing}
      ${props.cards.length === 0
        ? html`
            <div class="usage-empty-state__title">${t("modelProviders.emptyTitle")}</div>
            <div class="card-sub">${t("modelProviders.emptySubtitle")}</div>
          `
        : html`
            <div class="provider-usage-grid">
              ${props.cards.map((card) => renderCard(card, props.costDays))}
            </div>
          `}
    </section>
  `;
}
