import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type {
  ClawCatalogDetail,
  ClawCatalogEntry,
  ClawLifecycleApplyResult,
  ClawLifecyclePlanResult,
  ClawResourceStatus,
  ClawStatusEntry,
  ClawsDoctorResult,
  ClawsStatusResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { renderSettingsSegmented } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { setupAnswerEditable, type ClawSetupAnswers } from "./lifecycle-request.ts";
import { renderClawSetupInputs } from "./setup-view.ts";
import { type ClawStage, renderClawStages } from "./stages-view.ts";
import { renderClawSummary } from "./summary-view.ts";

type ClawsMode = "installed" | "discover";

type ClawsProps = {
  connected: boolean;
  available: boolean;
  catalogAvailable: boolean;
  lifecycleAvailable: boolean;
  lifecycleMutationAvailable: boolean;
  configureAvailable: boolean;
  configureMutationAvailable: boolean;
  loading: boolean;
  operationBusy: boolean;
  error: string | null;
  status: ClawsStatusResult | null;
  doctor: ClawsDoctorResult | null;
  selectedAgentId: string | null;
  mode: ClawsMode;
  query: string;
  catalogEntries: readonly ClawCatalogEntry[];
  catalogDetail: ClawCatalogDetail | null;
  installedCatalogAgents: readonly ClawStatusEntry[];
  plan: ClawLifecyclePlanResult | null;
  outcome: ClawLifecycleApplyResult | null;
  answers: ClawSetupAnswers;
  regenerateSeeds: readonly string[];
  planStale: boolean;
  completionReadiness: ClawLifecyclePlanResult["readiness"] | null;
  removeUnused: boolean;
  riskAcknowledged: boolean;
  onSelect: (agentId: string) => void;
  onModeChange: (mode: ClawsMode) => void;
  onQueryChange: (query: string) => void;
  onSearch: () => void;
  onSelectCatalog: (entry: ClawCatalogEntry) => void;
  onPreviewAdd: (detail: ClawCatalogDetail) => void;
  onPreviewUpdate: (record: ClawStatusEntry, detail?: ClawCatalogDetail) => void;
  onPreviewConfigure: (record: ClawStatusEntry) => void;
  onPreviewRemove: (record: ClawStatusEntry) => void;
  onRemoveUnusedChange: (value: boolean) => void;
  onRiskAcknowledgedChange: (value: boolean) => void;
  onAnswerChange: (id: string, value: ClawSetupAnswers[string] | undefined) => void;
  onSeedSelectionChange: (destination: string, selected: boolean) => void;
  onReviewPersonalization: () => void;
  onCancelPlan: () => void;
  onApplyPlan: () => void;
};

function recordHealthy(record: ClawStatusEntry): boolean {
  const healthyStates = new Set(["present", "unchanged", "complete"]);
  return (
    record.status === "complete" &&
    !record.orphaned &&
    (!record.personalization ||
      (record.personalization.status === "complete" &&
        !record.personalization.updatePending &&
        record.personalization.seeds.every((seed) => seed.status === "complete"))) &&
    record.resources.every((resource) => healthyStates.has(resource.state))
  );
}

function chipClassForState(state: string): string {
  return state === "present" || state === "unchanged" || state === "complete"
    ? "chip-ok"
    : state === "pending" || state === "incomplete"
      ? "chip-warn"
      : "chip-danger";
}

function resourceKindLabel(kind: ClawResourceStatus["kind"]): string {
  const labels: Record<ClawResourceStatus["kind"], string> = {
    agent: t("clawsPage.resourceKinds.agent"),
    "workspace-file": t("clawsPage.resourceKinds.workspaceFile"),
    skill: t("clawsPage.resourceKinds.skill"),
    plugin: t("clawsPage.resourceKinds.plugin"),
    "mcp-server": t("clawsPage.resourceKinds.mcpServer"),
    "cron-job": t("clawsPage.resourceKinds.cronJob"),
  };
  return labels[kind];
}

function resourceStateLabel(state: ClawResourceStatus["state"]): string {
  const labels: Record<ClawResourceStatus["state"], string> = {
    present: t("clawsPage.states.present"),
    unchanged: t("clawsPage.states.unchanged"),
    complete: t("clawsPage.states.complete"),
    modified: t("clawsPage.states.modified"),
    missing: t("clawsPage.states.missing"),
    unsafe: t("clawsPage.states.unsafe"),
    ambiguous: t("clawsPage.states.ambiguous"),
    incomplete: t("clawsPage.states.incomplete"),
    pending: t("clawsPage.states.pending"),
    failed: t("clawsPage.states.failed"),
    removed: t("clawsPage.states.removed"),
  };
  return labels[state];
}

function relationshipLabel(relationship: NonNullable<ClawResourceStatus["relationship"]>): string {
  return relationship === "managed" ? t("clawsPage.managed") : t("clawsPage.referenced");
}

function originLabel(origin: NonNullable<ClawResourceStatus["origin"]>): string {
  return origin === "claw-introduced"
    ? t("clawsPage.origins.clawIntroduced")
    : t("clawsPage.origins.preExisting");
}

function severityLabel(severity: ClawsDoctorResult["findings"][number]["severity"]): string {
  const labels: Record<ClawsDoctorResult["findings"][number]["severity"], string> = {
    info: t("clawsPage.severities.info"),
    warning: t("clawsPage.severities.warning"),
    error: t("clawsPage.severities.error"),
  };
  return labels[severity];
}

function sourceKindLabel(sourceKind: ClawStatusEntry["sourceKind"]): string {
  return sourceKind === "package"
    ? t("clawsPage.sources.package")
    : t("clawsPage.sources.development");
}

function operationLabel(operation: ClawLifecyclePlanResult["operation"]): string {
  return t(`clawsPage.operations.${operation}`);
}

function renderInventory(records: readonly ClawStatusEntry[], props: ClawsProps) {
  return html`
    <div class="claws-inventory" role="list">
      ${repeat(
        records,
        (record) => record.agentId,
        (record) => html`
          <button
            class="claws-inventory__row"
            type="button"
            role="listitem"
            aria-pressed=${record.agentId === props.selectedAgentId}
            @click=${() => props.onSelect(record.agentId)}
          >
            <span class="claws-inventory__main"
              ><span class="claws-inventory__name">${record.name}</span
              ><span class="claws-inventory__agent">${record.agentId}</span></span
            >
            <span class="claws-inventory__meta"
              ><span class="chip ${recordHealthy(record) ? "chip-ok" : "chip-warn"}"
                >${recordHealthy(record) ? t("clawsPage.healthy") : t("clawsPage.attention")}</span
              ><span>${t("clawsPage.versionCompact", { version: record.version })}</span></span
            >
          </button>
        `,
      )}
    </div>
  `;
}

function renderResources(record: ClawStatusEntry) {
  return html`
    <section class="claws-detail__section">
      <div class="claws-detail__heading">${t("clawsPage.resources")}</div>
      <div class="claws-resource-list">
        ${repeat(
          record.resources,
          (resource) => `${resource.kind}:${resource.id}`,
          (resource) => html`
            <div class="claws-resource">
              <div class="claws-resource__identity">
                <span class="claws-resource__kind">${resourceKindLabel(resource.kind)}</span
                ><span class="claws-resource__id">${resource.id}</span>
              </div>
              <div class="claws-resource__state">
                ${resource.relationship
                  ? html`<span class="chip">${relationshipLabel(resource.relationship)}</span>`
                  : nothing}
                ${resource.origin
                  ? html`<span class="chip">${originLabel(resource.origin)}</span>`
                  : nothing}
                ${resource.independentOwner
                  ? html`<span class="chip" title=${t("clawsPage.independentOwner")}
                      >${t("clawsPage.referenced")}</span
                    >`
                  : nothing}
                <span class="chip ${chipClassForState(resource.state)}"
                  >${resourceStateLabel(resource.state)}</span
                >
              </div>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

function renderDiagnostics(doctor: ClawsDoctorResult | null) {
  return html`
    <section class="claws-detail__section">
      <div class="claws-detail__heading">
        ${t("clawsPage.diagnostics")}${doctor
          ? html`<span class="claws-detail__count">${doctor.findings.length}</span>`
          : nothing}
      </div>
      ${!doctor || doctor.findings.length === 0
        ? html`<div class="muted">${t("clawsPage.noDiagnostics")}</div>`
        : html`<div class="claws-findings">
            ${repeat(
              doctor.findings,
              (finding, index) => `${finding.path ?? "finding"}:${index}`,
              (finding) => html`
                <div class="claws-finding claws-finding--${finding.severity}">
                  <span class="claws-finding__severity">${severityLabel(finding.severity)}</span>
                  <div>
                    <div class="claws-finding__message">${finding.message}</div>
                    ${finding.fixHint
                      ? html`<div class="claws-finding__hint">${finding.fixHint}</div>`
                      : nothing}
                  </div>
                </div>
              `,
            )}
          </div>`}
    </section>
  `;
}

function renderDetail(record: ClawStatusEntry, props: ClawsProps) {
  return html`
    <section class="claws-detail">
      <div class="claws-detail__header">
        <div>
          <div class="claws-detail__title">${record.name}</div>
          <div class="claws-detail__subtitle">${t("clawsPage.agent")}: ${record.agentId}</div>
        </div>
        <span class="chip ${recordHealthy(record) ? "chip-ok" : "chip-warn"}"
          >${recordHealthy(record) ? t("clawsPage.healthy") : t("clawsPage.attention")}</span
        >
      </div>
      <div class="claws-detail__actions">
        ${record.personalization
          ? html`<button
              class="btn"
              type="button"
              ?disabled=${!props.configureAvailable || props.operationBusy}
              @click=${() => props.onPreviewConfigure(record)}
            >
              ${t("clawsPage.actions.personalize")}
            </button>`
          : nothing}
        <button
          class="btn"
          type="button"
          ?disabled=${!props.lifecycleAvailable || props.operationBusy}
          @click=${() => props.onPreviewUpdate(record)}
        >
          ${t("clawsPage.actions.previewUpdate")}
        </button>
        <button
          class="btn danger"
          type="button"
          ?disabled=${!props.lifecycleAvailable || props.operationBusy}
          @click=${() => props.onPreviewRemove(record)}
        >
          ${t("clawsPage.actions.previewRemove")}
        </button>
      </div>
      <dl class="claws-metadata">
        <div>
          <dt>${t("common.version")}</dt>
          <dd>${record.version}</dd>
        </div>
        <div>
          <dt>${t("clawsPage.source")}</dt>
          <dd>${sourceKindLabel(record.sourceKind)}</dd>
        </div>
        <div>
          <dt>${t("clawsPage.updated")}</dt>
          <dd title=${new Date(record.updatedAtMs).toISOString()}>
            ${formatRelativeTimestamp(record.updatedAtMs)}
          </dd>
        </div>
      </dl>
      ${renderResources(record)}
    </section>
  `;
}

function renderModeControl(props: ClawsProps) {
  return renderSettingsSegmented({
    value: props.mode,
    options: (["installed", "discover"] as const).map((mode) => ({
      value: mode,
      label: t(`clawsPage.modes.${mode}`),
      disabled: mode === "discover" && !props.catalogAvailable,
    })),
    ariaLabel: t("clawsPage.modeLabel"),
    className: "claws-mode",
    onChange: (mode) => props.onModeChange(mode),
  });
}

function renderCatalogDetail(detail: ClawCatalogDetail, props: ClawsProps) {
  const counts = [
    [t("clawsPage.resourceKinds.workspaceFile"), detail.workspaceFiles],
    [t("clawsPage.resourceKinds.skill"), detail.skills],
    [t("clawsPage.resourceKinds.plugin"), detail.plugins],
    [t("clawsPage.resourceKinds.mcpServer"), detail.mcpServers],
    [t("clawsPage.resourceKinds.cronJob"), detail.scheduledJobs],
  ] as const;
  return html`
    <section class="claws-detail claws-catalog-detail">
      <div class="claws-detail__header">
        <div>
          <div class="claws-detail__title">${detail.displayName}</div>
          <div class="claws-detail__subtitle">${detail.packageName} · ${detail.version}</div>
        </div>
        ${detail.official
          ? html`<span class="chip chip-ok">${t("clawsPage.official")}</span>`
          : nothing}
      </div>
      ${detail.summary
        ? html`<p class="claws-catalog-detail__summary">${detail.summary}</p>`
        : nothing}
      ${detail.agentDescription
        ? html`<p class="muted claws-catalog-detail__summary">${detail.agentDescription}</p>`
        : nothing}
      <dl class="claws-metadata claws-catalog-counts">
        ${counts.map(
          ([label, value]) =>
            html`<div>
              <dt>${label}</dt>
              <dd>${value}</dd>
            </div>`,
        )}
      </dl>
      ${detail.scanStatus
        ? html`<div class="claws-scan">
            <span>${t("clawsPage.scanStatus")}</span><span class="chip">${detail.scanStatus}</span>
          </div>`
        : nothing}
      ${props.installedCatalogAgents.length > 1
        ? html`<div class="callout warn">${t("clawsPage.multipleInstalled")}</div>`
        : html`<div class="claws-detail__actions">
            ${props.installedCatalogAgents.length === 1
              ? html`<button
                  class="btn primary"
                  type="button"
                  ?disabled=${!props.lifecycleAvailable || props.operationBusy}
                  @click=${() => props.onPreviewUpdate(props.installedCatalogAgents[0]!, detail)}
                >
                  ${t("clawsPage.actions.previewUpdate")}
                </button>`
              : html`<button
                  class="btn primary"
                  type="button"
                  ?disabled=${!props.lifecycleAvailable || props.operationBusy}
                  @click=${() => props.onPreviewAdd(detail)}
                >
                  ${t("clawsPage.actions.previewAdd")}
                </button>`}
          </div>`}
      ${renderClawStages("overview")}
    </section>
  `;
}

function renderDiscover(props: ClawsProps) {
  if (!props.catalogAvailable) {
    return html`<div class="callout warn">${t("clawsPage.catalogUnavailable")}</div>`;
  }
  return html`
    <form
      class="claws-search"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        props.onSearch();
      }}
    >
      <label class="claws-search__field"
        ><span>${t("clawsPage.searchLabel")}</span
        ><input
          type="search"
          .value=${props.query}
          placeholder=${t("clawsPage.searchPlaceholder")}
          @input=${(event: Event) =>
            props.onQueryChange((event.currentTarget as HTMLInputElement).value)}
      /></label>
      <button
        class="btn primary"
        type="submit"
        ?disabled=${props.operationBusy || !props.query.trim()}
      >
        ${t("clawsPage.search")}
      </button>
    </form>
    <div class="claws-workspace claws-catalog-workspace">
      <div class="claws-inventory" role="list">
        ${props.catalogEntries.length === 0
          ? html`<div class="muted claws-empty">${t("clawsPage.searchEmpty")}</div>`
          : repeat(
              props.catalogEntries,
              (entry) => entry.packageName,
              (entry) => html`
                <button
                  class="claws-inventory__row"
                  type="button"
                  role="listitem"
                  aria-pressed=${entry.packageName === props.catalogDetail?.packageName}
                  @click=${() => props.onSelectCatalog(entry)}
                >
                  <span class="claws-inventory__main"
                    ><span class="claws-inventory__name">${entry.displayName}</span
                    ><span class="claws-inventory__agent">${entry.packageName}</span></span
                  >
                  <span class="claws-inventory__meta"
                    >${entry.official
                      ? html`<span class="chip chip-ok">${t("clawsPage.official")}</span>`
                      : nothing}${entry.latestVersion
                      ? html`<span
                          >${t("clawsPage.versionCompact", { version: entry.latestVersion })}</span
                        >`
                      : nothing}</span
                  >
                </button>
              `,
            )}
      </div>
      ${props.catalogDetail
        ? renderCatalogDetail(props.catalogDetail, props)
        : html`<div class="muted claws-empty claws-catalog-prompt">
            ${t("clawsPage.selectCatalog")}
          </div>`}
    </div>
  `;
}

function renderPlan(plan: ClawLifecyclePlanResult, props: ClawsProps) {
  const blocked = plan.blockers.length > 0;
  const consentMissing = plan.riskAcknowledgementRequired && !props.riskAcknowledged;
  const setupNeedsReview = Boolean(plan.setup && (props.planStale || !plan.setup.valid));
  const mutationAvailable =
    plan.operation === "configure"
      ? props.configureMutationAvailable
      : props.lifecycleMutationAvailable;
  const activeStage: ClawStage = props.operationBusy
    ? "add"
    : setupNeedsReview
      ? "personalize"
      : "review";
  return html`
    <section class="claws-plan" aria-label=${t("clawsPage.plan.title")}>
      ${plan.operation === "add" ? renderClawStages(activeStage) : nothing}
      <div class="claws-detail__header">
        <div>
          <div class="claws-detail__title">
            ${t("clawsPage.plan.heading", { operation: operationLabel(plan.operation) })}
          </div>
          <div class="claws-detail__subtitle">${plan.target.name ?? plan.target.agentId ?? ""}</div>
        </div>
        <span class="chip ${blocked ? "chip-danger" : "chip-warn"}"
          >${blocked ? t("clawsPage.plan.blocked") : t("clawsPage.plan.preview")}</span
        >
      </div>
      ${plan.setup
        ? html`<section class="claws-setup" aria-label=${t("clawsPage.setup.title")}>
            <div class="claws-detail__heading">${t("clawsPage.setup.title")}</div>
            <div class="claws-setup__fields">
              ${renderClawSetupInputs(plan.setup.inputs, {
                ...props,
                allowAnswerClearing: plan.operation === "configure",
                disabledInputIds: new Set(
                  plan.setup.inputs
                    .filter((input) => !setupAnswerEditable(plan, input.id))
                    .map((input) => input.id),
                ),
              })}
            </div>
            ${plan.operation === "configure" && plan.setup.seeds.length > 0
              ? html`<fieldset class="claws-setup__seeds">
                  <legend>${t("clawsPage.setup.regenerate")}</legend>
                  ${plan.setup.seeds.map(
                    (seed) => html`<label>
                      <input
                        type="checkbox"
                        .checked=${props.regenerateSeeds.includes(seed.destination)}
                        ?disabled=${props.operationBusy}
                        @change=${(event: Event) =>
                          props.onSeedSelectionChange(
                            seed.destination,
                            (event.currentTarget as HTMLInputElement).checked,
                          )}
                      />${seed.destination}
                    </label>`,
                  )}
                </fieldset>`
              : nothing}
            ${plan.setup.diagnostics.map(
              (diagnostic) => html`<div class="callout warn">${diagnostic.message}</div>`,
            )}
            ${setupNeedsReview
              ? html`<button
                  class="btn primary"
                  type="button"
                  ?disabled=${props.operationBusy}
                  @click=${props.onReviewPersonalization}
                >
                  ${t("clawsPage.setup.review")}
                </button>`
              : nothing}
          </section>`
        : nothing}
      <div class="claws-plan__groups">
        <section>
          <div class="claws-detail__heading">${t("clawsPage.plan.actions")}</div>
          <div class="claws-plan__list">
            ${repeat(
              plan.actions,
              (action) => `${action.kind}:${action.id}:${action.action}`,
              (action) =>
                html`<div class="claws-plan__row">
                  <span><strong>${action.action}</strong> ${action.id}</span
                  ><span class="chip ${action.blocked ? "chip-danger" : ""}">${action.kind}</span>
                </div>`,
            )}
          </div>
        </section>
        ${plan.capabilities.length > 0
          ? html`<section>
              <div class="claws-detail__heading">${t("clawsPage.plan.capabilities")}</div>
              <div class="claws-plan__list">
                ${repeat(
                  plan.capabilities,
                  (capability) => `${capability.kind}:${capability.id}`,
                  (capability) =>
                    html`<div class="claws-plan__row">
                      <span
                        ><strong>${capability.action}</strong> ${capability.id}<small
                          >${capability.reason}</small
                        ></span
                      ><span class="chip">${capability.kind}</span>
                    </div>`,
                )}
              </div>
            </section>`
          : nothing}
        ${plan.blockers.length > 0
          ? html`<section>
              <div class="claws-detail__heading">${t("clawsPage.plan.blockers")}</div>
              <div class="claws-plan__list">
                ${repeat(
                  plan.blockers,
                  (blocker) => `${blocker.code}:${blocker.path}`,
                  (blocker) =>
                    html`<div class="claws-plan__row claws-plan__row--blocked">
                      <span><strong>${blocker.code}</strong><small>${blocker.message}</small></span>
                    </div>`,
                )}
              </div>
            </section>`
          : nothing}
      </div>
      ${plan.readiness && plan.readiness.requirements.length > 0
        ? html`<section class="claws-detail__section">
            <div class="claws-detail__heading">${t("clawsPage.setup.connections")}</div>
            <div class="claws-plan__list">
              ${plan.readiness.requirements.map(
                (requirement) => html`<div class="claws-plan__row">
                  <span>${requirement.owner}</span><span class="chip">${requirement.kind}</span>
                </div>`,
              )}
            </div>
          </section>`
        : nothing}
      ${plan.operation === "remove"
        ? html`<label class="claws-consent"
            ><input
              type="checkbox"
              .checked=${props.removeUnused}
              ?disabled=${props.operationBusy}
              @change=${(event: Event) =>
                props.onRemoveUnusedChange((event.currentTarget as HTMLInputElement).checked)}
            /><span>${t("clawsPage.plan.removeUnused")}</span></label
          >`
        : nothing}
      ${plan.trustWarning ? html`<div class="callout warn">${plan.trustWarning}</div>` : nothing}
      ${plan.riskAcknowledgementRequired
        ? html`<label class="claws-consent"
            ><input
              type="checkbox"
              .checked=${props.riskAcknowledged}
              @change=${(event: Event) =>
                props.onRiskAcknowledgedChange((event.currentTarget as HTMLInputElement).checked)}
            /><span>${t("clawsPage.plan.acknowledgeRisk")}</span></label
          >`
        : nothing}
      <div class="claws-plan__actions">
        <button
          class="btn"
          type="button"
          ?disabled=${props.operationBusy}
          @click=${props.onCancelPlan}
        >
          ${t("common.cancel")}</button
        ><button
          class="btn primary"
          type="button"
          ?disabled=${!mutationAvailable ||
          props.operationBusy ||
          blocked ||
          consentMissing ||
          setupNeedsReview}
          @click=${props.onApplyPlan}
        >
          ${props.operationBusy
            ? t("clawsPage.plan.applying")
            : t("clawsPage.plan.confirm", { operation: operationLabel(plan.operation) })}
        </button>
      </div>
    </section>
  `;
}

export function renderClaws(props: ClawsProps) {
  if (!props.connected) {
    return html`<div class="callout warn">${t("clawsPage.disconnected")}</div>`;
  }
  if (!props.available) {
    return html`<div class="callout warn">${t("clawsPage.unavailable")}</div>`;
  }
  const selected =
    props.status?.records.find((record) => record.agentId === props.selectedAgentId) ??
    props.status?.records[0];
  return html`
    <div class="claws-page stack">
      ${renderModeControl(props)}
      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}
      ${props.outcome
        ? html`<div class="callout ${props.outcome.status === "complete" ? "success" : "warn"}">
            ${props.outcome.message}
          </div>`
        : nothing}
      ${props.outcome?.operation === "add"
        ? renderClawStages(props.completionReadiness?.ready === false ? "connect" : "ready")
        : nothing}
      ${props.outcome && props.completionReadiness?.requirements.length
        ? html`<div class="callout warn">
            ${t("clawsPage.setup.connectOwners", {
              owners: props.completionReadiness.requirements
                .map((requirement) => requirement.owner)
                .join(", "),
            })}
          </div>`
        : nothing}
      ${props.plan ? renderPlan(props.plan, props) : nothing}
      ${props.mode === "discover"
        ? renderDiscover(props)
        : props.loading && !props.status
          ? html`<div class="muted claws-empty">${t("clawsPage.loading")}</div>`
          : !props.status || props.status.records.length === 0
            ? html`<div class="muted claws-empty">${t("clawsPage.empty")}</div>`
            : html`${renderClawSummary(props.status)}
                <div class="claws-workspace">
                  ${renderInventory(props.status.records, props)}${selected
                    ? renderDetail(selected, props)
                    : nothing}
                </div>
                ${renderDiagnostics(props.doctor)}`}
    </div>
  `;
}
