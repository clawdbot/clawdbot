import { html, nothing } from "lit";
import type {
  MemoryMigrationItem,
  MemoryMigrationProviderPlan,
  MigrationsMemoryApplyResult,
  MigrationsMemoryPlanResult,
} from "../../../../packages/gateway-protocol/src/schema/migrations.js";
import type { GatewayAgentRow } from "../../../../src/shared/session-types.js";
import "../../components/agent-select-registration.ts";
import "../../components/modal-dialog.ts";
import { icons } from "../../components/icons.ts";
import { renderProviderBrandIcon } from "../../components/provider-icon.ts";
import {
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsToggleRow,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { normalizeAgentLabel } from "../../lib/agents/display.ts";
import "../../styles/memory-import.css";

type MemoryCollection = {
  id: string;
  label: string;
  items: MemoryMigrationItem[];
};

export type SessionBackfillGatewayResult = {
  days: number;
  candidates: number;
  perDay: Array<{ day: string; candidateCount: number; sample: string[] }>;
  staged: number;
  truncated?: boolean;
  cursor?: { advanced: boolean; exhausted: boolean; hasMore: boolean };
};

export type SessionBackfillProgress = {
  days: number;
  candidates: number;
  staged: number;
  complete: boolean;
};

export type SessionBackfillRollbackResult = {
  removedDiaryEntries: number;
  removedStagedEntries: number;
};

type MemoryImportViewProps = {
  connected: boolean;
  agents: GatewayAgentRow[];
  selectedAgentId: string | null;
  plan: MigrationsMemoryPlanResult | null;
  loading: boolean;
  error: string | null;
  applyError: string | null;
  replaceExisting: boolean;
  selectedByProvider: Record<string, string[]>;
  applyingProviderId: string | null;
  pendingProviderId: string | null;
  lastResults: Record<string, MigrationsMemoryApplyResult>;
  backfillAvailable: boolean;
  backfillFrom: string;
  backfillTo: string;
  backfillBusy: "preview" | "apply" | "rollback" | null;
  backfillError: string | null;
  backfillPreview: SessionBackfillGatewayResult | null;
  backfillProgress: SessionBackfillProgress | null;
  backfillRollbackResult: SessionBackfillRollbackResult | null;
  backfillRollbackPending: boolean;
  onSelectAgent: (agentId: string) => void;
  onReplaceExisting: (enabled: boolean) => void;
  onRefresh: () => void;
  onToggleCollection: (providerId: string, itemIds: readonly string[], selected: boolean) => void;
  onRequestImport: (providerId: string) => void;
  onConfirmImport: () => void;
  onCancelImport: () => void;
  onBackfillFromChange: (value: string) => void;
  onBackfillToChange: (value: string) => void;
  onBackfillPreview: () => void;
  onBackfillApply: () => void;
  onBackfillRollbackRequest: () => void;
  onBackfillRollbackConfirm: () => void;
  onBackfillRollbackCancel: () => void;
};

function detailString(item: MemoryMigrationItem, key: string): string | undefined {
  const value = item.details?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function groupMemoryItems(items: readonly MemoryMigrationItem[]): MemoryCollection[] {
  const groups = new Map<string, MemoryCollection>();
  for (const item of items) {
    const id = detailString(item, "collectionId") ?? item.id;
    const label =
      detailString(item, "collectionLabel") ??
      detailString(item, "sourceLabel") ??
      t("memoryImport.unknownCollection");
    const group = groups.get(id) ?? { id, label, items: [] };
    group.items.push(item);
    groups.set(id, group);
  }
  return [...groups.values()].toSorted((left, right) => left.label.localeCompare(right.label));
}

function providerLabel(provider: MemoryMigrationProviderPlan): string {
  return provider.providerId === "claude" ? t("memoryImport.claudeCode") : provider.label;
}

function providerDescription(provider: MemoryMigrationProviderPlan): string {
  if (provider.providerId === "codex") {
    return t("memoryImport.codexDescription");
  }
  if (provider.providerId === "claude") {
    return t("memoryImport.claudeDescription");
  }
  return t("memoryImport.providerFallback");
}

function fileCount(count: number): string {
  return t(count === 1 ? "memoryImport.fileCountOne" : "memoryImport.fileCount", {
    count: String(count),
  });
}

function processedDayCount(count: number): string {
  return t(
    count === 1
      ? "memoryImport.backfill.processedDayCountOne"
      : "memoryImport.backfill.processedDayCount",
    { count: String(count) },
  );
}

function artifactLabel(item: MemoryMigrationItem): string {
  const relativePath = detailString(item, "relativePath");
  if (relativePath) {
    return relativePath;
  }
  const pathValue = item.target ?? item.source ?? item.id;
  return pathValue.split(/[\\/]/u).at(-1) ?? pathValue;
}

// Collection review keeps custom markup: a select-all checkbox plus a
// collapsible per-file status list has no settings-ui primitive.
function renderCollection(
  provider: MemoryMigrationProviderPlan,
  collection: MemoryCollection,
  selectedIds: ReadonlySet<string>,
  onToggle: MemoryImportViewProps["onToggleCollection"],
  disabled: boolean,
) {
  const selectable = collection.items.filter((item) => item.status === "planned");
  const selectableIds = selectable.map((item) => item.id);
  const checked = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));
  const conflicts = collection.items.filter((item) => item.status === "conflict").length;
  return html`
    <div class="settings-row settings-row--stacked memory-import__collection">
      <div class="memory-import__collection-header">
        <label class="memory-import__collection-choice">
          <input
            type="checkbox"
            .checked=${checked}
            ?disabled=${selectableIds.length === 0 || disabled}
            @change=${(event: Event) =>
              onToggle(
                provider.providerId,
                selectableIds,
                (event.currentTarget as HTMLInputElement).checked,
              )}
          />
          <span>
            <strong>${collection.label}</strong>
            <small>${fileCount(collection.items.length)}</small>
          </span>
        </label>
        ${conflicts > 0
          ? renderSettingsStatus({
              kind: "warn",
              label: t("memoryImport.alreadyImported", { count: String(conflicts) }),
            })
          : nothing}
      </div>
      <details ?open=${collection.items.length <= 4}>
        <summary>${t("memoryImport.reviewFiles")}</summary>
        <ul class="memory-import__files">
          ${collection.items.map(
            (item) => html`
              <li>
                <span class="memory-import__file-icon" aria-hidden="true">${icons.fileText}</span>
                <code title=${item.source ?? artifactLabel(item)}>${artifactLabel(item)}</code>
                <span class="memory-import__file-status memory-import__file-status--${item.status}">
                  ${item.status === "planned"
                    ? t("memoryImport.ready")
                    : item.status === "conflict"
                      ? t("memoryImport.existing")
                      : item.status}
                </span>
              </li>
            `,
          )}
        </ul>
      </details>
    </div>
  `;
}

// Apply results keep custom markup: nested issue and recovery-artifact lists
// are a report, not a settings row.
function renderResult(result: MigrationsMemoryApplyResult | undefined) {
  if (!result) {
    return nothing;
  }
  const incomplete = result.summary.errors > 0 || result.summary.conflicts > 0;
  const resultDetailItems = result.items.filter(
    (item) =>
      item.status === "error" ||
      item.status === "conflict" ||
      detailString(item, "recoveryRecordPath") !== undefined,
  );
  return html`
    <div
      class="settings-row settings-row--stacked memory-import__result ${incomplete
        ? "memory-import__result--incomplete"
        : ""}"
      role=${incomplete ? "alert" : "status"}
    >
      <span aria-hidden="true">${incomplete ? icons.alertTriangle : icons.check}</span>
      <div>
        <strong>
          ${t(incomplete ? "memoryImport.importIncomplete" : "memoryImport.importComplete")}
        </strong>
        <span>
          ${incomplete
            ? t("memoryImport.importedWithIssues", {
                conflicts: String(result.summary.conflicts),
                errors: String(result.summary.errors),
                migrated: String(result.summary.migrated),
              })
            : t("memoryImport.importedCount", { count: String(result.summary.migrated) })}
        </span>
        ${result.reportDir
          ? html`<span class="memory-import__result-path">
              ${t("memoryImport.reportSaved")}:
              <code title=${result.reportDir}>${result.reportDir}</code>
            </span>`
          : nothing}
        ${resultDetailItems.length > 0
          ? html`<ul class="memory-import__result-issues">
              ${resultDetailItems.map((item) => {
                const recoveryArtifacts = [
                  {
                    label: t("memoryImport.recoveryFile"),
                    path: detailString(item, "recoveryPath"),
                  },
                  {
                    label: t("memoryImport.recoveryJournal"),
                    path: detailString(item, "recoveryRecordPath"),
                  },
                  {
                    label: t("memoryImport.itemBackup"),
                    path: detailString(item, "backupPath"),
                  },
                ].filter((artifact): artifact is { label: string; path: string } =>
                  Boolean(artifact.path),
                );
                return html`<li>
                  <strong>${artifactLabel(item)}</strong>
                  <span>${item.reason ?? item.message ?? item.status}</span>
                  ${recoveryArtifacts.map(
                    (artifact) => html`<span class="memory-import__result-artifact">
                      <span>${artifact.label}</span>
                      <code title=${artifact.path}>${artifact.path}</code>
                    </span>`,
                  )}
                </li>`;
              })}
            </ul>`
          : nothing}
      </div>
    </div>
  `;
}

function renderProvider(props: MemoryImportViewProps, provider: MemoryMigrationProviderPlan) {
  const selectedIds = new Set(props.selectedByProvider[provider.providerId] ?? []);
  const groups = groupMemoryItems(provider.items);
  const applying = props.applyingProviderId === provider.providerId;
  const backfillMutating =
    props.backfillBusy === "apply" ||
    props.backfillBusy === "rollback" ||
    props.backfillRollbackPending;
  const rows = provider.error
    ? html`<div class="callout danger" role="alert">${provider.error}</div>`
    : !provider.found
      ? renderSettingsEmpty(provider.message ?? t("memoryImport.noMemoryFound"))
      : html`
          ${provider.source
            ? renderSettingsRow({
                title: t("memoryImport.source"),
                control: renderSettingsValue(provider.source, { mono: true }),
              })
            : nothing}
          ${provider.target
            ? renderSettingsRow({
                title: t("memoryImport.destination"),
                control: renderSettingsValue(`${provider.target}/memory/imports/`, { mono: true }),
              })
            : nothing}
          ${groups.map((group) =>
            renderCollection(
              provider,
              group,
              selectedIds,
              props.onToggleCollection,
              props.loading ||
                props.applyingProviderId !== null ||
                props.error !== null ||
                backfillMutating,
            ),
          )}
          ${renderSettingsRow({
            title:
              selectedIds.size > 0
                ? t("memoryImport.selectedCount", { count: String(selectedIds.size) })
                : t("memoryImport.selectAtLeastOne"),
            control: html`
              <button
                class="btn primary"
                data-test-id="memory-import-provider-button"
                ?disabled=${selectedIds.size === 0 ||
                props.applyingProviderId !== null ||
                backfillMutating ||
                props.loading ||
                props.error !== null}
                @click=${() => props.onRequestImport(provider.providerId)}
              >
                ${applying ? t("common.importing") : t("memoryImport.importSelected")}
              </button>
            `,
          })}
        `;
  return html`
    <div data-provider-id=${provider.providerId}>
      ${renderSettingsSection(
        {
          title: html`<span class="memory-import__provider-title">
            ${renderProviderBrandIcon(provider.providerId, {
              className: "memory-import__provider-icon",
            })}
            ${providerLabel(provider)}
          </span>`,
          description: providerDescription(provider),
          actions: renderSettingsStatus({
            kind: provider.found ? "ok" : "muted",
            label: provider.found ? fileCount(provider.items.length) : t("memoryImport.notFound"),
          }),
        },
        html`${rows}${renderResult(props.lastResults[provider.providerId])}`,
      )}
    </div>
  `;
}

// The confirmation modal reuses the shared exec-approval dialog anatomy, not
// the settings design language.
function renderConfirmation(props: MemoryImportViewProps) {
  const provider = props.plan?.providers.find(
    (candidate) => candidate.providerId === props.pendingProviderId,
  );
  if (!provider) {
    return nothing;
  }
  const count = props.selectedByProvider[provider.providerId]?.length ?? 0;
  const title = t("memoryImport.confirmTitle", { provider: providerLabel(provider) });
  const description = t("memoryImport.confirmDescription", { count: String(count) });
  return html`
    <openclaw-modal-dialog
      label=${title}
      description=${description}
      @modal-cancel=${() => {
        if (props.applyingProviderId === null) {
          props.onCancelImport();
        }
      }}
    >
      <div class="exec-approval-card memory-import__confirm">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">${title}</div>
            <div class="exec-approval-sub">${description}</div>
          </div>
        </div>
        <div class="callout ${props.replaceExisting ? "warn" : ""}">
          ${props.replaceExisting
            ? t("memoryImport.confirmReplace")
            : t("memoryImport.confirmBackup")}
        </div>
        <div class="exec-approval-actions">
          <button
            class="btn primary"
            data-test-id="memory-import-confirm"
            ?disabled=${props.applyingProviderId !== null}
            @click=${props.onConfirmImport}
          >
            ${t("memoryImport.confirmImport")}
          </button>
          <button
            class="btn"
            ?disabled=${props.applyingProviderId !== null}
            @click=${props.onCancelImport}
          >
            ${t("common.cancel")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}

function renderIntroSection(props: MemoryImportViewProps) {
  const busy = props.loading || props.applyingProviderId !== null || props.backfillBusy !== null;
  return renderSettingsSection(
    {
      title: t("memoryImport.title"),
      description: t("memoryImport.subtitle"),
      actions: html`
        <button class="btn btn--sm" ?disabled=${busy} @click=${props.onRefresh}>
          ${props.loading ? t("common.refreshing") : t("common.refresh")}
        </button>
      `,
    },
    html`
      ${renderSettingsRow({
        title: t("memoryImport.agent"),
        control: html`
          <openclaw-agent-select
            class="agent-select--settings"
            name="memory-import-agent"
            .options=${props.agents.map((agent) => ({
              value: agent.id,
              label: normalizeAgentLabel(agent),
              agent,
            }))}
            .value=${props.selectedAgentId ?? ""}
            .accessibleLabel=${t("memoryImport.agent")}
            .disabled=${busy}
            .onSelect=${props.onSelectAgent}
          ></openclaw-agent-select>
        `,
      })}
      ${renderSettingsToggleRow({
        title: t("memoryImport.replaceExisting"),
        description: t("memoryImport.replaceHint"),
        checked: props.replaceExisting,
        disabled: busy,
        onChange: (enabled) => props.onReplaceExisting(enabled),
      })}
    `,
  );
}

function renderBackfillConfirmation(props: MemoryImportViewProps) {
  if (!props.backfillRollbackPending) {
    return nothing;
  }
  return html`
    <openclaw-modal-dialog
      label=${t("memoryImport.backfill.rollbackConfirmTitle")}
      description=${t("memoryImport.backfill.rollbackConfirmDescription")}
      @modal-cancel=${props.onBackfillRollbackCancel}
    >
      <div class="exec-approval-card memory-import__confirm">
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">
              ${t("memoryImport.backfill.rollbackConfirmTitle")}
            </div>
            <div class="exec-approval-sub">
              ${t("memoryImport.backfill.rollbackConfirmDescription")}
            </div>
          </div>
        </div>
        <div class="callout warn">${t("memoryImport.backfill.rollbackWarning")}</div>
        <div class="exec-approval-actions">
          <button
            class="btn danger"
            data-test-id="memory-backfill-rollback-confirm"
            ?disabled=${props.backfillBusy !== null || props.applyingProviderId !== null}
            @click=${props.onBackfillRollbackConfirm}
          >
            ${t("memoryImport.backfill.rollback")}
          </button>
          <button
            class="btn"
            ?disabled=${props.backfillBusy !== null || props.applyingProviderId !== null}
            @click=${props.onBackfillRollbackCancel}
          >
            ${t("common.cancel")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}

function renderBackfillSection(props: MemoryImportViewProps) {
  const busy = props.backfillBusy !== null || props.applyingProviderId !== null;
  const result = props.backfillPreview;
  return html`
    <div data-test-id="memory-session-backfill">
      ${renderSettingsSection(
        {
          title: t("memoryImport.backfill.title"),
          description: t("memoryImport.backfill.subtitle"),
        },
        html`
          ${props.backfillAvailable
            ? html`
                ${renderSettingsRow({
                  title: t("memoryImport.backfill.dateRange"),
                  description: t("memoryImport.backfill.dateRangeHint"),
                  control: html`<div class="memory-import__backfill-dates">
                    <label>
                      <span>${t("memoryImport.backfill.from")}</span>
                      <input
                        class="input"
                        type="date"
                        .value=${props.backfillFrom}
                        ?disabled=${busy}
                        @input=${(event: Event) =>
                          props.onBackfillFromChange(
                            (event.currentTarget as HTMLInputElement).value,
                          )}
                      />
                    </label>
                    <label>
                      <span>${t("memoryImport.backfill.to")}</span>
                      <input
                        class="input"
                        type="date"
                        .value=${props.backfillTo}
                        ?disabled=${busy}
                        @input=${(event: Event) =>
                          props.onBackfillToChange((event.currentTarget as HTMLInputElement).value)}
                      />
                    </label>
                  </div>`,
                })}
                ${renderSettingsRow({
                  title: t("memoryImport.backfill.actions"),
                  control: html`<div class="memory-import__backfill-actions">
                    <button
                      class="btn"
                      data-test-id="memory-backfill-preview"
                      ?disabled=${busy}
                      @click=${props.onBackfillPreview}
                    >
                      ${props.backfillBusy === "preview"
                        ? t("memoryImport.backfill.previewing")
                        : t("memoryImport.backfill.preview")}
                    </button>
                    <button
                      class="btn primary"
                      data-test-id="memory-backfill-apply"
                      ?disabled=${busy}
                      @click=${props.onBackfillApply}
                    >
                      ${props.backfillBusy === "apply"
                        ? t("memoryImport.backfill.applying")
                        : t("memoryImport.backfill.apply")}
                    </button>
                    <button
                      class="btn danger"
                      data-test-id="memory-backfill-rollback"
                      ?disabled=${busy}
                      @click=${props.onBackfillRollbackRequest}
                    >
                      ${t("memoryImport.backfill.rollback")}
                    </button>
                  </div>`,
                })}
                ${props.backfillError
                  ? html`<div class="callout danger" role="alert">${props.backfillError}</div>`
                  : nothing}
                ${result
                  ? html`<div
                      class="settings-row settings-row--stacked memory-import__backfill-preview"
                    >
                      <strong>
                        ${t("memoryImport.backfill.previewSummary", {
                          candidates: String(result.candidates),
                          days: String(result.days),
                        })}
                      </strong>
                      ${result.perDay.length > 0
                        ? html`<ul>
                            ${result.perDay.map(
                              (day) => html`<li>
                                <div>
                                  <strong>${day.day}</strong>
                                  <span>
                                    ${t("memoryImport.backfill.candidateCount", {
                                      count: String(day.candidateCount),
                                    })}
                                  </span>
                                </div>
                                ${day.sample.length > 0
                                  ? html`<ul>
                                      ${day.sample.map((sample) => html`<li>${sample}</li>`)}
                                    </ul>`
                                  : nothing}
                              </li>`,
                            )}
                          </ul>`
                        : html`<span>${t("memoryImport.backfill.noCandidates")}</span>`}
                      ${result.truncated
                        ? html`<div class="callout warn">
                            ${t("memoryImport.backfill.previewTruncated")}
                          </div>`
                        : nothing}
                    </div>`
                  : nothing}
                ${props.backfillProgress
                  ? html`<div
                      class="settings-row settings-row--stacked memory-import__backfill-progress"
                      role="status"
                    >
                      <strong>
                        ${props.backfillProgress.complete
                          ? t("memoryImport.backfill.complete", {
                              count: String(props.backfillProgress.staged),
                            })
                          : t("memoryImport.backfill.progress", {
                              days: String(props.backfillProgress.days),
                              staged: String(props.backfillProgress.staged),
                            })}
                      </strong>
                      <span>
                        ${t("memoryImport.backfill.processedCandidates", {
                          count: String(props.backfillProgress.candidates),
                        })}
                        · ${processedDayCount(props.backfillProgress.days)}
                      </span>
                    </div>`
                  : nothing}
                ${props.backfillRollbackResult
                  ? html`<div class="settings-row settings-row--stacked" role="status">
                      <strong>${t("memoryImport.backfill.rollbackComplete")}</strong>
                      <span>
                        ${t("memoryImport.backfill.rollbackCounts", {
                          diary: String(props.backfillRollbackResult.removedDiaryEntries),
                          staged: String(props.backfillRollbackResult.removedStagedEntries),
                        })}
                      </span>
                    </div>`
                  : nothing}
              `
            : renderSettingsEmpty(t("memoryImport.backfill.unavailable"))}
        `,
      )}
      ${renderBackfillConfirmation(props)}
    </div>
  `;
}

export function renderMemoryImport(props: MemoryImportViewProps) {
  if (!props.connected) {
    return renderSettingsPage(renderSettingsEmpty(t("memoryImport.disconnected")));
  }
  return html`
    <div class="memory-import" data-test-id="memory-import-page">
      ${renderSettingsPage(html`
        ${renderIntroSection(props)} ${renderBackfillSection(props)}
        ${props.error
          ? html`<div class="callout danger" role="alert">${props.error}</div>`
          : nothing}
        ${props.applyError
          ? html`<div class="callout danger" role="alert">${props.applyError}</div>`
          : nothing}
        ${props.loading && !props.plan
          ? html`<div class="settings-group memory-import__loading" aria-busy="true">
              <div class="memory-import__skeleton"></div>
              <div class="memory-import__skeleton"></div>
            </div>`
          : (props.plan?.providers ?? []).map((provider) => renderProvider(props, provider))}
        ${renderConfirmation(props)}
      `)}
    </div>
  `;
}
