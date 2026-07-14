import { html, nothing } from "lit";
import type {
  MemoryMigrationItem,
  MemoryMigrationProviderPlan,
  MigrationsMemoryApplyResult,
  MigrationsMemoryPlanResult,
} from "../../../../packages/gateway-protocol/src/schema/migrations.js";
import type { GatewayAgentRow } from "../../../../src/shared/session-types.js";
import "../../components/modal-dialog.ts";
import { icons } from "../../components/icons.ts";
import { renderProviderBrandIcon } from "../../components/provider-icon.ts";
import { t } from "../../i18n/index.ts";
import "../../styles/memory-import.css";

type MemoryCollection = {
  id: string;
  label: string;
  items: MemoryMigrationItem[];
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
  onSelectAgent: (agentId: string) => void;
  onReplaceExisting: (enabled: boolean) => void;
  onRefresh: () => void;
  onToggleCollection: (providerId: string, itemIds: readonly string[], selected: boolean) => void;
  onRequestImport: (providerId: string) => void;
  onConfirmImport: () => void;
  onCancelImport: () => void;
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

function artifactLabel(item: MemoryMigrationItem): string {
  const relativePath = detailString(item, "relativePath");
  if (relativePath) {
    return relativePath;
  }
  const pathValue = item.target ?? item.source ?? item.id;
  return pathValue.split(/[\\/]/u).at(-1) ?? pathValue;
}

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
    <div class="memory-import__collection">
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
          ? html`<span class="memory-import__badge memory-import__badge--conflict">
              ${t("memoryImport.alreadyImported", { count: String(conflicts) })}
            </span>`
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
      class="memory-import__result ${incomplete ? "memory-import__result--incomplete" : ""}"
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
  return html`
    <article class="card memory-import__provider" data-provider-id=${provider.providerId}>
      <div class="memory-import__provider-header">
        <div class="memory-import__provider-identity">
          ${renderProviderBrandIcon(provider.providerId, {
            className: "memory-import__provider-icon",
          })}
          <div>
            <h3>${providerLabel(provider)}</h3>
            <p>${providerDescription(provider)}</p>
          </div>
        </div>
        <span
          class="memory-import__badge ${provider.found
            ? "memory-import__badge--ready"
            : "memory-import__badge--muted"}"
        >
          ${provider.found ? fileCount(provider.items.length) : t("memoryImport.notFound")}
        </span>
      </div>

      ${provider.error
        ? html`<div class="callout danger" role="alert">${provider.error}</div>`
        : !provider.found
          ? html`<div class="memory-import__empty">
              ${provider.message ?? t("memoryImport.noMemoryFound")}
            </div>`
          : html`
              <dl class="memory-import__paths">
                ${provider.source
                  ? html`<div>
                      <dt>${t("memoryImport.source")}</dt>
                      <dd><code title=${provider.source}>${provider.source}</code></dd>
                    </div>`
                  : nothing}
                ${provider.target
                  ? html`<div>
                      <dt>${t("memoryImport.destination")}</dt>
                      <dd>
                        <code title=${provider.target}>${provider.target}/memory/imports/</code>
                      </dd>
                    </div>`
                  : nothing}
              </dl>
              <div class="memory-import__collections">
                ${groups.map((group) =>
                  renderCollection(
                    provider,
                    group,
                    selectedIds,
                    props.onToggleCollection,
                    props.loading || props.applyingProviderId !== null || props.error !== null,
                  ),
                )}
              </div>
              <div class="memory-import__provider-actions">
                <span>
                  ${selectedIds.size > 0
                    ? t("memoryImport.selectedCount", { count: String(selectedIds.size) })
                    : t("memoryImport.selectAtLeastOne")}
                </span>
                <button
                  class="btn primary"
                  data-test-id="memory-import-provider-button"
                  ?disabled=${selectedIds.size === 0 ||
                  props.applyingProviderId !== null ||
                  props.loading ||
                  props.error !== null}
                  @click=${() => props.onRequestImport(provider.providerId)}
                >
                  ${applying ? t("common.importing") : t("memoryImport.importSelected")}
                </button>
              </div>
            `}
      ${renderResult(props.lastResults[provider.providerId])}
    </article>
  `;
}

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

export function renderMemoryImport(props: MemoryImportViewProps) {
  if (!props.connected) {
    return html`<section class="card">
      <div class="card-sub">${t("memoryImport.disconnected")}</div>
    </section>`;
  }
  return html`
    <div class="memory-import" data-test-id="memory-import-page">
      <section class="card memory-import__intro">
        <div>
          <div class="card-title">${t("memoryImport.title")}</div>
          <div class="card-sub">${t("memoryImport.subtitle")}</div>
        </div>
        <div class="memory-import__controls">
          <label>
            <span>${t("memoryImport.agent")}</span>
            <select
              name="memory-import-agent"
              .value=${props.selectedAgentId ?? ""}
              ?disabled=${props.loading || props.applyingProviderId !== null}
              @change=${(event: Event) =>
                props.onSelectAgent((event.currentTarget as HTMLSelectElement).value)}
            >
              ${props.agents.map(
                (agent) => html`
                  <option value=${agent.id} ?selected=${agent.id === props.selectedAgentId}>
                    ${agent.identity?.name ?? agent.name ?? agent.id}
                  </option>
                `,
              )}
            </select>
          </label>
          <label class="memory-import__replace">
            <input
              type="checkbox"
              name="memory-import-replace"
              .checked=${props.replaceExisting}
              ?disabled=${props.loading || props.applyingProviderId !== null}
              @change=${(event: Event) =>
                props.onReplaceExisting((event.currentTarget as HTMLInputElement).checked)}
            />
            <span>
              <strong>${t("memoryImport.replaceExisting")}</strong>
              <small>${t("memoryImport.replaceHint")}</small>
            </span>
          </label>
          <button
            class="btn btn--sm"
            ?disabled=${props.loading || props.applyingProviderId !== null}
            @click=${props.onRefresh}
          >
            ${props.loading ? t("common.refreshing") : t("common.refresh")}
          </button>
        </div>
      </section>

      ${props.error ? html`<div class="callout danger" role="alert">${props.error}</div>` : nothing}
      ${props.applyError
        ? html`<div class="callout danger" role="alert">${props.applyError}</div>`
        : nothing}
      ${props.loading && !props.plan
        ? html`<section class="card memory-import__loading" aria-busy="true">
            <div class="memory-import__skeleton"></div>
            <div class="memory-import__skeleton"></div>
          </section>`
        : html`<div class="memory-import__grid">
            ${(props.plan?.providers ?? []).map((provider) => renderProvider(props, provider))}
          </div>`}
      ${renderConfirmation(props)}
    </div>
  `;
}
