import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type {
  ClawCatalogDetail,
  ClawCatalogEntry,
  ClawLifecycleApplyResult,
  ClawLifecyclePlanResult,
  ClawStatusEntry,
} from "../../../../packages/gateway-protocol/src/index.js";
import { t } from "../../i18n/index.ts";

export type ClawLifecycleViewProps = {
  catalogAvailable: boolean;
  lifecycleAvailable: boolean;
  mutationAvailable: boolean;
  busy: boolean;
  error: string | null;
  query: string;
  entries: readonly ClawCatalogEntry[];
  detail: ClawCatalogDetail | null;
  selected: ClawStatusEntry | null;
  plan: ClawLifecyclePlanResult | null;
  completion: ClawLifecycleApplyResult | null;
  removeUnused: boolean;
  riskAcknowledged: boolean;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onSelectCatalog: (entry: ClawCatalogEntry) => void;
  onPreviewAdd: () => void;
  onPreviewUpdate: () => void;
  onPreviewRemove: () => void;
  onApply: () => void;
  onCancelPlan: () => void;
  onRemoveUnusedChange: (value: boolean) => void;
  onRiskAcknowledgedChange: (value: boolean) => void;
  onOpenChat: (agentId: string) => void;
};

function renderCatalog(props: ClawLifecycleViewProps) {
  const selectedMatchesDetail =
    props.selected && props.detail && props.selected.name === props.detail.packageName;
  return html`
    <section class="claws-lifecycle" aria-label=${t("clawsPage.catalog.title")}>
      <div class="claws-lifecycle__heading">
        <div>
          <div class="claws-detail__heading">${t("clawsPage.catalog.title")}</div>
          <div class="muted">${t("clawsPage.catalog.subtitle")}</div>
        </div>
      </div>
      ${!props.catalogAvailable
        ? html`<div class="callout warn">${t("clawsPage.catalog.unavailable")}</div>`
        : html`
            <form
              class="claws-catalog-search"
              @submit=${(event: SubmitEvent) => {
                event.preventDefault();
                props.onSearch();
              }}
            >
              <input
                class="input"
                type="search"
                .value=${props.query}
                placeholder=${t("clawsPage.catalog.placeholder")}
                aria-label=${t("clawsPage.catalog.searchLabel")}
                ?disabled=${props.busy}
                @input=${(event: InputEvent) =>
                  props.onQueryChange((event.currentTarget as HTMLInputElement).value)}
              />
              <button class="btn" type="submit" ?disabled=${props.busy || !props.query.trim()}>
                ${t("common.search")}
              </button>
            </form>
            ${props.entries.length === 0
              ? nothing
              : html`<div class="claws-catalog-results" role="list">
                  ${repeat(
                    props.entries,
                    (entry) => entry.packageName,
                    (entry) => html`
                      <button
                        class="claws-catalog-result"
                        type="button"
                        role="listitem"
                        aria-pressed=${entry.packageName === props.detail?.packageName}
                        @click=${() => props.onSelectCatalog(entry)}
                      >
                        <span>
                          <strong>${entry.displayName}</strong>
                          <span class="muted">${entry.packageName}</span>
                        </span>
                        <span class="claws-catalog-result__meta">
                          ${entry.official
                            ? html`<span class="chip chip-ok"
                                >${t("clawsPage.catalog.official")}</span
                              >`
                            : nothing}
                          ${entry.latestVersion ?? ""}
                        </span>
                      </button>
                    `,
                  )}
                </div>`}
          `}
      ${props.detail
        ? html`
            <div class="claws-catalog-detail">
              <div>
                <div class="claws-detail__title">${props.detail.displayName}</div>
                <div class="muted">${props.detail.packageName} · ${props.detail.version}</div>
                ${props.detail.summary
                  ? html`<p class="claws-catalog-detail__summary">${props.detail.summary}</p>`
                  : nothing}
              </div>
              <dl class="claws-catalog-counts">
                <div>
                  <dt>${t("clawsPage.catalog.workspaceFiles")}</dt>
                  <dd>${props.detail.workspaceFiles}</dd>
                </div>
                <div>
                  <dt>${t("clawsPage.resourceKinds.skill")}</dt>
                  <dd>${props.detail.skills}</dd>
                </div>
                <div>
                  <dt>${t("clawsPage.resourceKinds.plugin")}</dt>
                  <dd>${props.detail.plugins}</dd>
                </div>
                <div>
                  <dt>${t("clawsPage.resourceKinds.mcpServer")}</dt>
                  <dd>${props.detail.mcpServers}</dd>
                </div>
                <div>
                  <dt>${t("clawsPage.resourceKinds.cronJob")}</dt>
                  <dd>${props.detail.scheduledJobs}</dd>
                </div>
              </dl>
              <div class="claws-lifecycle__actions">
                <button
                  class="btn primary"
                  type="button"
                  ?disabled=${props.busy || !props.lifecycleAvailable}
                  @click=${props.onPreviewAdd}
                >
                  ${t("clawsPage.actions.previewAdd")}
                </button>
                <button
                  class="btn"
                  type="button"
                  ?disabled=${props.busy || !props.lifecycleAvailable || !selectedMatchesDetail}
                  @click=${props.onPreviewUpdate}
                >
                  ${t("clawsPage.actions.previewUpdate")}
                </button>
              </div>
              ${props.selected && !selectedMatchesDetail
                ? html`<div class="muted">${t("clawsPage.catalog.selectMatchingAgent")}</div>`
                : nothing}
            </div>
          `
        : nothing}
    </section>
  `;
}

function renderPlan(props: ClawLifecycleViewProps) {
  const plan = props.plan;
  if (!plan) {
    return nothing;
  }
  const blocked = plan.blockers.length > 0 || plan.actions.some((action) => action.blocked);
  const canApply =
    props.mutationAvailable &&
    !props.busy &&
    !blocked &&
    (!plan.riskAcknowledgementRequired || props.riskAcknowledged);
  return html`
    <section class="claws-plan" aria-label=${t("clawsPage.plan.title")}>
      <div class="claws-lifecycle__heading">
        <div>
          <div class="claws-detail__heading">${t("clawsPage.plan.title")}</div>
          <div class="muted">${t(`clawsPage.plan.operations.${plan.operation}`)}</div>
        </div>
        <span class="chip ${blocked ? "chip-danger" : "chip-ok"}">
          ${blocked ? t("clawsPage.plan.blocked") : t("clawsPage.plan.ready")}
        </span>
      </div>
      ${plan.trustWarning ? html`<div class="callout warn">${plan.trustWarning}</div>` : nothing}
      ${plan.blockers.length > 0
        ? html`<div class="claws-plan__blockers">
            ${plan.blockers.map(
              (blocker) => html`<div class="callout danger">${blocker.message}</div>`,
            )}
          </div>`
        : nothing}
      <div class="claws-plan__actions-list">
        ${repeat(
          plan.actions,
          (action) => `${action.kind}:${action.id}:${action.action}`,
          (action) => html`
            <div class="claws-plan-action">
              <span><strong>${action.action}</strong> ${action.kind}</span>
              <span class="claws-plan-action__id">${action.id}</span>
              ${action.blocked
                ? html`<span class="chip chip-danger">${t("clawsPage.plan.blocked")}</span>`
                : nothing}
            </div>
          `,
        )}
      </div>
      ${plan.readiness && !plan.readiness.ready
        ? html`<div class="callout warn">
            ${t("clawsPage.plan.readiness", {
              count: String(plan.readiness.requirements.length),
            })}
          </div>`
        : nothing}
      ${plan.operation === "remove"
        ? html`<label class="claws-consent-row">
            <input
              type="checkbox"
              .checked=${props.removeUnused}
              @change=${(event: Event) =>
                props.onRemoveUnusedChange((event.currentTarget as HTMLInputElement).checked)}
            />
            <span>${t("clawsPage.plan.removeUnused")}</span>
          </label>`
        : nothing}
      ${plan.riskAcknowledgementRequired
        ? html`<label class="claws-consent-row">
            <input
              type="checkbox"
              .checked=${props.riskAcknowledged}
              @change=${(event: Event) =>
                props.onRiskAcknowledgedChange((event.currentTarget as HTMLInputElement).checked)}
            />
            <span>${t("clawsPage.plan.acknowledgeRisk")}</span>
          </label>`
        : nothing}
      ${!props.mutationAvailable
        ? html`<div class="callout warn">${t("clawsPage.plan.adminRequired")}</div>`
        : nothing}
      <div class="claws-lifecycle__actions">
        <button class="btn primary" type="button" ?disabled=${!canApply} @click=${props.onApply}>
          ${props.busy ? t("clawsPage.actions.applying") : t("clawsPage.actions.apply")}
        </button>
        <button class="btn" type="button" ?disabled=${props.busy} @click=${props.onCancelPlan}>
          ${t("common.cancel")}
        </button>
      </div>
    </section>
  `;
}

export function renderClawLifecycle(props: ClawLifecycleViewProps) {
  return html`
    <div class="claws-lifecycle-stack">
      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}
      ${props.completion
        ? html`<div class="callout ${props.completion.status === "partial" ? "warn" : "success"}">
            <div>
              <div>${props.completion.message}</div>
              ${props.completion.status === "partial"
                ? html`<div>${t("clawsPage.partialGuidance")}</div>`
                : nothing}
            </div>
            ${props.completion.status === "complete" && props.completion.operation !== "remove"
              ? html`<button
                  class="btn"
                  type="button"
                  @click=${() => props.onOpenChat(props.completion!.agentId)}
                >
                  ${t("clawsPage.actions.openChat")}
                </button>`
              : nothing}
          </div>`
        : nothing}
      ${renderCatalog(props)}
      ${props.selected
        ? html`<div class="claws-lifecycle__installed-actions">
            <button
              class="btn danger"
              type="button"
              ?disabled=${props.busy}
              @click=${props.onPreviewRemove}
            >
              ${t("clawsPage.actions.previewRemove")}
            </button>
            ${props.selected.bootstrapState === "pending"
              ? html`<button
                  class="btn"
                  type="button"
                  @click=${() => props.onOpenChat(props.selected!.agentId)}
                >
                  ${t("clawsPage.actions.completeSetup")}
                </button>`
              : nothing}
          </div>`
        : nothing}
      ${renderPlan(props)}
    </div>
  `;
}
