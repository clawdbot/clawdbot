// Run-history rendering for the Automations screen: the compact filter row
// plus run entries, shared by the list view's Run history tab and the job
// detail history tab.
import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { CronRunLogEntry } from "../../api/types.ts";
import type { CronDeliveryStatus, CronRunsStatusValue, CronSortDir } from "../../api/types.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { icon } from "../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp, formatMs } from "../../lib/format.ts";
import { searchForSession } from "../../lib/sessions/index.ts";

// Leaf contract: the slice of the cron view props this module needs. Keeping
// it local (instead of importing CronProps from view.ts) avoids a module
// cycle between view.ts and view-runs.ts.
type CronRunsSectionProps = {
  basePath: string;
  runs: CronRunLogEntry[];
  runsHasMore: boolean;
  runsLoadingMore: boolean;
  runsStatuses: CronRunsStatusValue[];
  runsDeliveryStatuses: CronDeliveryStatus[];
  runsQuery: string;
  runsSortDir: CronSortDir;
  onLoadMoreRuns: () => void;
  onRunsFiltersChange: (patch: {
    cronRunsStatuses?: CronRunsStatusValue[];
    cronRunsDeliveryStatuses?: CronDeliveryStatus[];
    cronRunsQuery?: string;
    cronRunsSortDir?: CronSortDir;
  }) => void | Promise<void>;
  onNavigateToChat?: (sessionKey: string) => void;
};

function getRunStatusOptions(): Array<{ value: CronRunsStatusValue; label: string }> {
  return [
    { value: "ok", label: t("cron.runs.runStatusOk") },
    { value: "error", label: t("cron.runs.runStatusError") },
    { value: "skipped", label: t("cron.runs.runStatusSkipped") },
  ];
}

function getRunDeliveryOptions(): Array<{ value: CronDeliveryStatus; label: string }> {
  return [
    { value: "delivered", label: t("cron.runs.deliveryDelivered") },
    { value: "not-delivered", label: t("cron.runs.deliveryNotDelivered") },
    { value: "unknown", label: t("cron.runs.deliveryUnknown") },
    { value: "not-requested", label: t("cron.runs.deliveryNotRequested") },
  ];
}

function toggleSelection<T extends string>(selected: T[], value: T, checked: boolean): T[] {
  const set = new Set(selected);
  if (checked) {
    set.add(value);
  } else {
    set.delete(value);
  }
  return Array.from(set);
}

function summarizeSelection(selectedLabels: string[], allLabel: string) {
  if (selectedLabels.length === 0) {
    return allLabel;
  }
  if (selectedLabels.length <= 2) {
    return selectedLabels.join(", ");
  }
  return `${selectedLabels[0]} +${selectedLabels.length - 1}`;
}

function renderFilterDropdown(params: {
  id: string;
  title: string;
  summary: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onToggle: (value: string, checked: boolean) => void;
  onClear: () => void;
}) {
  return html`
    <div class="cron-filter-dropdown" data-filter=${params.id}>
      <details class="cron-filter-dropdown__details">
        <summary
          class="btn btn--sm cron-filter-dropdown__trigger ${params.selected.length > 0
            ? "active"
            : ""}"
          title=${params.title}
          aria-label=${params.title}
        >
          <span>${params.summary}</span>
          ${icon("chevronDown")}
        </summary>
        <div class="cron-filter-dropdown__panel">
          <div class="cron-filter-dropdown__list">
            ${params.options.map(
              (option) => html`
                <label class="cron-filter-dropdown__option">
                  <input
                    type="checkbox"
                    value=${option.value}
                    .checked=${params.selected.includes(option.value)}
                    @change=${(event: Event) => {
                      const target = event.target as HTMLInputElement;
                      params.onToggle(option.value, target.checked);
                    }}
                  />
                  <span>${option.label}</span>
                </label>
              `,
            )}
          </div>
          <div class="row">
            <button class="btn" type="button" @click=${params.onClear}>
              ${t("cron.runs.clear")}
            </button>
          </div>
        </div>
      </details>
    </div>
  `;
}

export function renderRunsSection(props: CronRunsSectionProps) {
  const runs = props.runs.toSorted((a, b) =>
    props.runsSortDir === "asc" ? a.ts - b.ts : b.ts - a.ts,
  );
  const hasRunFilters =
    props.runsQuery.trim().length > 0 ||
    props.runsStatuses.length > 0 ||
    props.runsDeliveryStatuses.length > 0;
  const runStatusOptions = getRunStatusOptions();
  const runDeliveryOptions = getRunDeliveryOptions();
  const selectedStatusLabels = runStatusOptions
    .filter((option) => props.runsStatuses.includes(option.value))
    .map((option) => option.label);
  const selectedDeliveryLabels = runDeliveryOptions
    .filter((option) => props.runsDeliveryStatuses.includes(option.value))
    .map((option) => option.label);
  const statusSummary = summarizeSelection(selectedStatusLabels, t("cron.runs.allStatuses"));
  const deliverySummary = summarizeSelection(selectedDeliveryLabels, t("cron.runs.allDelivery"));
  return html`
    <div class="cron-runs">
      <div class="cron-run-filters">
        <div class="cron-search-box cron-run-filter-search">
          <span class="cron-search-box__icon" aria-hidden="true">${icon("search")}</span>
          <input
            type="search"
            class="settings-input"
            .value=${props.runsQuery}
            aria-label=${t("cron.runs.searchRuns")}
            placeholder=${t("cron.runs.searchPlaceholder")}
            @input=${(e: Event) =>
              props.onRunsFiltersChange({ cronRunsQuery: (e.target as HTMLInputElement).value })}
          />
        </div>
        ${renderFilterDropdown({
          id: "status",
          title: t("cron.runs.status"),
          summary: statusSummary,
          options: runStatusOptions,
          selected: props.runsStatuses,
          onToggle: (value, checked) => {
            const next = toggleSelection(props.runsStatuses, value as CronRunsStatusValue, checked);
            void props.onRunsFiltersChange({ cronRunsStatuses: next });
          },
          onClear: () => {
            void props.onRunsFiltersChange({ cronRunsStatuses: [] });
          },
        })}
        ${renderFilterDropdown({
          id: "delivery",
          title: t("cron.runs.delivery"),
          summary: deliverySummary,
          options: runDeliveryOptions,
          selected: props.runsDeliveryStatuses,
          onToggle: (value, checked) => {
            const next = toggleSelection(
              props.runsDeliveryStatuses,
              value as CronDeliveryStatus,
              checked,
            );
            void props.onRunsFiltersChange({ cronRunsDeliveryStatuses: next });
          },
          onClear: () => {
            void props.onRunsFiltersChange({ cronRunsDeliveryStatuses: [] });
          },
        })}
        <select
          class="cron-run-sort"
          aria-label=${t("cron.jobs.sort")}
          title=${t("cron.jobs.sort")}
          .value=${props.runsSortDir}
          @change=${(e: Event) =>
            props.onRunsFiltersChange({
              cronRunsSortDir: (e.target as HTMLSelectElement).value as CronSortDir,
            })}
        >
          <option value="desc">${t("cron.runs.newestFirst")}</option>
          <option value="asc">${t("cron.runs.oldestFirst")}</option>
        </select>
      </div>
      ${runs.length === 0
        ? hasRunFilters
          ? html`<div class="muted cron-runs__empty">${t("cron.runs.noMatching")}</div>`
          : html`
              <div class="cron-empty-state">
                <div class="cron-empty-state__title">${t("cron.runs.emptyTitle")}</div>
                <div class="cron-empty-state__copy">${t("cron.runs.emptyHint")}</div>
              </div>
            `
        : html`
            <div class="cron-runs__list">
              ${runs.map((entry) => renderRun(entry, props.basePath, props.onNavigateToChat))}
            </div>
          `}
      ${props.runsHasMore
        ? html`
            <button
              class="btn btn--sm cron-load-more"
              ?disabled=${props.runsLoadingMore}
              @click=${props.onLoadMoreRuns}
            >
              ${props.runsLoadingMore ? t("cron.list.loading") : t("cron.runs.loadMore")}
            </button>
          `
        : nothing}
    </div>
  `;
}

function formatRunNextLabel(nextRunAtMs: number, nowMs = Date.now()) {
  const rel = formatRelativeTimestamp(nextRunAtMs);
  return nextRunAtMs > nowMs ? t("cron.runEntry.next", { rel }) : t("cron.runEntry.due", { rel });
}

export function runStatusLabel(value: string): string {
  switch (value) {
    case "ok":
      return t("cron.runs.runStatusOk");
    case "error":
      return t("cron.runs.runStatusError");
    case "skipped":
      return t("cron.runs.runStatusSkipped");
    default:
      return t("cron.runs.runStatusUnknown");
  }
}

function runDeliveryLabel(value: string): string {
  switch (value) {
    case "delivered":
      return t("cron.runs.deliveryDelivered");
    case "not-delivered":
      return t("cron.runs.deliveryNotDelivered");
    case "not-requested":
      return t("cron.runs.deliveryNotRequested");
    default:
      return t("cron.runs.deliveryUnknown");
  }
}

function renderRun(
  entry: CronRunLogEntry,
  basePath: string,
  onNavigateToChat?: (sessionKey: string) => void,
) {
  const chatUrl =
    typeof entry.sessionKey === "string" && entry.sessionKey.trim().length > 0
      ? `${pathForRoute("chat", basePath)}${searchForSession(entry.sessionKey)}`
      : null;
  const status = runStatusLabel(entry.status ?? "unknown");
  const delivery = runDeliveryLabel(entry.deliveryStatus ?? "not-requested");
  const usage = entry.usage;
  const usageSummary =
    usage && typeof usage.total_tokens === "number"
      ? `${usage.total_tokens} tokens`
      : usage && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number"
        ? `${usage.input_tokens} in / ${usage.output_tokens} out`
        : null;
  const bodySource = entry.summary || entry.error || t("cron.runEntry.noSummary");
  const showErrorInMeta = Boolean(entry.error) && Boolean(entry.summary);
  const facts = [delivery, entry.model, entry.provider, usageSummary].filter(Boolean);
  return html`
    <div class="cron-run-entry">
      <div class="cron-run-entry__header">
        <div class="cron-run-entry__main">
          <div class="cron-run-entry__title">
            ${entry.jobName ?? entry.jobId}
            <span class="muted"> · ${status}</span>
          </div>
          <div class="cron-run-entry__facts muted">${facts.join(" · ")}</div>
        </div>
        <div class="cron-run-entry__meta">
          <div>${formatMs(entry.ts)}</div>
          ${typeof entry.runAtMs === "number"
            ? html`<div class="muted">${t("cron.runEntry.runAt")} ${formatMs(entry.runAtMs)}</div>`
            : nothing}
          <div class="muted">${entry.durationMs ?? 0}ms</div>
          ${typeof entry.nextRunAtMs === "number"
            ? html`<div class="muted">${formatRunNextLabel(entry.nextRunAtMs)}</div>`
            : nothing}
          ${chatUrl
            ? html`<div>
                <a
                  class="session-link"
                  href=${chatUrl}
                  @click=${(e: MouseEvent) => {
                    if (
                      e.defaultPrevented ||
                      e.button !== 0 ||
                      e.metaKey ||
                      e.ctrlKey ||
                      e.shiftKey ||
                      e.altKey
                    ) {
                      return;
                    }
                    if (onNavigateToChat && entry.sessionKey) {
                      e.preventDefault();
                      onNavigateToChat(entry.sessionKey);
                    }
                  }}
                  >${t("cron.runEntry.openRunChat")}</a
                >
              </div>`
            : nothing}
          ${showErrorInMeta ? html`<div class="muted">${entry.error}</div>` : nothing}
          ${entry.deliveryError ? html`<div class="muted">${entry.deliveryError}</div>` : nothing}
        </div>
      </div>
      <div class="cron-run-entry__body chat-text">
        ${unsafeHTML(toSanitizedMarkdownHtml(bodySource))}
      </div>
    </div>
  `;
}
