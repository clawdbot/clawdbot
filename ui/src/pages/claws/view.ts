import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type {
  ClawResourceStatus,
  ClawStatusEntry,
  ClawsDoctorResult,
  ClawsStatusResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { icon, type IconName } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";

type ClawsProps = {
  connected: boolean;
  available: boolean;
  loading: boolean;
  busy: boolean;
  error: string | null;
  status: ClawsStatusResult | null;
  doctor: ClawsDoctorResult | null;
  selectedAgentId: string | null;
  onSelect: (agentId: string) => void;
};

function recordHealthy(record: ClawStatusEntry): boolean {
  const healthyStates = new Set(["present", "unchanged", "complete"]);
  return (
    record.status === "complete" &&
    record.bootstrapState === "complete" &&
    !record.orphaned &&
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

function bootstrapStateLabel(state: ClawStatusEntry["bootstrapState"]): string {
  const labels: Record<ClawStatusEntry["bootstrapState"], string> = {
    pending: t("clawsPage.states.pending"),
    complete: t("clawsPage.states.complete"),
    modified: t("clawsPage.states.modified"),
    unsafe: t("clawsPage.states.unsafe"),
    unknown: t("clawsPage.states.unknown"),
  };
  return labels[state];
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

function renderSummary(status: ClawsStatusResult) {
  const stats: Array<{ key: string; label: string; value: number; iconName: IconName }> = [
    {
      key: "healthy",
      label: t("clawsPage.healthy"),
      value: status.summary.healthy,
      iconName: "check",
    },
    {
      key: "attention",
      label: t("clawsPage.attention"),
      value: status.summary.attention,
      iconName: "alertTriangle",
    },
    {
      key: "managed",
      label: t("clawsPage.managed"),
      value: status.summary.managed,
      iconName: "lock",
    },
    {
      key: "referenced",
      label: t("clawsPage.referenced"),
      value: status.summary.referenced,
      iconName: "link",
    },
  ];
  return html`
    <section class="claws-summary" aria-label=${t("clawsPage.summaryLabel")}>
      ${stats.map(
        (stat) => html`
          <div class="claws-summary__item" data-stat=${stat.key}>
            <span class="claws-summary__icon" aria-hidden="true">${icon(stat.iconName)}</span>
            <div>
              <div class="claws-summary__value">${stat.value}</div>
              <div class="claws-summary__label">${stat.label}</div>
            </div>
          </div>
        `,
      )}
    </section>
  `;
}

function renderInventory(records: readonly ClawStatusEntry[], props: ClawsProps) {
  return html`
    <div class="claws-inventory" role="list">
      ${repeat(
        records,
        (record) => record.agentId,
        (record) => {
          const healthy = recordHealthy(record);
          return html`
            <button
              class="claws-inventory__row"
              type="button"
              role="listitem"
              aria-pressed=${record.agentId === props.selectedAgentId}
              ?disabled=${props.busy}
              @click=${() => props.onSelect(record.agentId)}
            >
              <span class="claws-inventory__main">
                <span class="claws-inventory__name">${record.name}</span>
                <span class="claws-inventory__agent">${record.agentId}</span>
              </span>
              <span class="claws-inventory__meta">
                <span class="chip ${healthy ? "chip-ok" : "chip-warn"}">
                  ${healthy ? t("clawsPage.healthy") : t("clawsPage.attention")}
                </span>
                <span>${t("clawsPage.versionCompact", { version: record.version })}</span>
              </span>
            </button>
          `;
        },
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
                <span class="claws-resource__kind">${resourceKindLabel(resource.kind)}</span>
                <span class="claws-resource__id">${resource.id}</span>
              </div>
              <div class="claws-resource__state">
                ${resource.relationship
                  ? html`<span class="chip">${relationshipLabel(resource.relationship)}</span>`
                  : nothing}
                ${resource.origin
                  ? html`<span class="chip">${originLabel(resource.origin)}</span>`
                  : nothing}
                ${resource.independentOwner
                  ? html`<span class="chip" title=${t("clawsPage.independentOwner")}>
                      ${t("clawsPage.referenced")}
                    </span>`
                  : nothing}
                <span class="chip ${chipClassForState(resource.state)}">
                  ${resourceStateLabel(resource.state)}
                </span>
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
        ${t("clawsPage.diagnostics")}
        ${doctor
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

function renderDetail(record: ClawStatusEntry) {
  return html`
    <section class="claws-detail">
      <div class="claws-detail__header">
        <div>
          <div class="claws-detail__title">${record.name}</div>
          <div class="claws-detail__subtitle">${t("clawsPage.agent")}: ${record.agentId}</div>
        </div>
        <span class="chip ${recordHealthy(record) ? "chip-ok" : "chip-warn"}">
          ${recordHealthy(record) ? t("clawsPage.healthy") : t("clawsPage.attention")}
        </span>
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
          <dt>${t("clawsPage.bootstrap")}</dt>
          <dd>
            <span class="chip ${chipClassForState(record.bootstrapState)}"
              >${bootstrapStateLabel(record.bootstrapState)}</span
            >
          </dd>
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

export function renderClaws(props: ClawsProps) {
  if (!props.connected) {
    return html`<div class="callout warn">${t("clawsPage.disconnected")}</div>`;
  }
  if (!props.available) {
    return html`<div class="callout warn">${t("clawsPage.unavailable")}</div>`;
  }
  if (props.error) {
    return html`<div class="callout danger">${props.error}</div>`;
  }
  if (props.loading && !props.status) {
    return html`<div class="muted claws-empty">${t("clawsPage.loading")}</div>`;
  }
  if (!props.status || props.status.records.length === 0) {
    return html`<div class="muted claws-empty">${t("clawsPage.empty")}</div>`;
  }
  const selected =
    props.status.records.find((record) => record.agentId === props.selectedAgentId) ??
    props.status.records[0];
  return html`
    <div class="claws-page stack">
      ${renderSummary(props.status)}
      <div class="claws-workspace">
        ${renderInventory(props.status.records, props)}
        ${selected ? renderDetail(selected) : nothing}
      </div>
      ${renderDiagnostics(props.doctor)}
    </div>
  `;
}
