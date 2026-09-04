// Run-history rendering for the Automations screen: the compact filter row
// plus run entries, shared by the list view's Run history tab and the job
// detail history tab.
import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type {
  CronRunLogEntry,
  CronDeliveryStatus,
  CronRunsStatusValue,
  CronSortDir,
} from "../../api/types.ts";
import { icon } from "../../components/icons.ts";
import "../../components/web-awesome.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { i18n, t } from "../../i18n/index.ts";
import { runFailureLabel } from "../../lib/cron/completion-cause.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import {
  formatDurationCompact,
  formatDurationHuman,
  formatRelativeTimestamp,
  formatMs,
  formatCompactTokenCount,
} from "../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { cronRunEntryMatchesLink } from "./route-model.ts";

// Leaf contract: the slice of the cron view props this module needs. Keeping
// it local (instead of importing CronProps from view.ts) avoids a module
// cycle between view.ts and view-runs.ts.
type CronRunsSectionProps = {
  basePath: string;
  agentId: string;
  runs: CronRunLogEntry[];
  highlightedRunId?: string | null;
  runsHasMore: boolean;
  runsLoadingMore: boolean;
  runsStatuses: CronRunsStatusValue[];
  runsDeliveryStatuses: CronDeliveryStatus[];
  runsQuery: string;
  runsSortDir: CronSortDir;
  conditionActivity?: {
    checkCount: number;
    lastCheckedAtMs?: number;
    lastFiredAtMs?: number;
  };
  onLoadMoreRuns: () => void;
  onRunsFiltersChange: (patch: {
    cronRunsStatuses?: CronRunsStatusValue[];
    cronRunsDeliveryStatuses?: CronDeliveryStatus[];
    cronRunsQuery?: string;
    cronRunsSortDir?: CronSortDir;
  }) => void | Promise<void>;
  onNavigateToChat?: (sessionKey: string) => void;
};

function renderConditionMetric(label: string, value: string) {
  return html`
    <div class="cron-condition-activity__metric">
      <dt>${label}</dt>
      <dd>${value}</dd>
    </div>
  `;
}

function renderConditionActivity(activity: NonNullable<CronRunsSectionProps["conditionActivity"]>) {
  const lastChecked = formatRelativeTimestamp(activity.lastCheckedAtMs, {
    fallback: t("cron.runs.notChecked"),
  });
  const lastFired = formatRelativeTimestamp(activity.lastFiredAtMs, {
    fallback: t("cron.runs.neverFired"),
  });
  return html`
    <div class="cron-condition-activity" data-test-id="cron-condition-activity">
      <div class="cron-condition-activity__intro">
        <div class="settings-row__title">
          <span class="cron-condition-activity__icon" aria-hidden="true">${icon("gitBranch")}</span>
          ${t("cron.runs.conditionActivity")}
        </div>
        <div class="settings-row__desc">${t("cron.runs.conditionActivityHint")}</div>
      </div>
      <dl class="cron-condition-activity__metrics">
        ${renderConditionMetric(t("cron.runs.checks"), String(activity.checkCount))}
        ${renderConditionMetric(t("cron.runs.lastChecked"), lastChecked)}
        ${renderConditionMetric(t("cron.runs.lastFired"), lastFired)}
      </dl>
    </div>
  `;
}

function conditionEmptyHint(activity: NonNullable<CronRunsSectionProps["conditionActivity"]>) {
  if (activity.checkCount === 0) {
    return t("cron.runs.emptyConditionUnchecked");
  }
  const key =
    activity.checkCount === 1 ? "cron.runs.emptyConditionHintOne" : "cron.runs.emptyConditionHint";
  return t(key, { count: String(activity.checkCount) });
}

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

const FILTER_OPTION_PREFIX = "option:";
const FILTER_COMMAND_PREFIX = "command:";

function renderFilterDropdown(params: {
  id: string;
  title: string;
  summary: string;
  options: Array<{ value: string; label: string }>;
  selected: string[];
  onToggle: (value: string, checked: boolean) => void;
  onClear: () => void;
}) {
  const selectedLabels = params.options
    .filter((option) => params.selected.includes(option.value))
    .map((option) => option.label);
  const accessibleSummary =
    selectedLabels.length > 2
      ? `${params.summary} (${new Intl.ListFormat(i18n.getLocale(), {
          style: "long",
          type: "conjunction",
        }).format(selectedLabels)})`
      : params.summary;
  return html`
    <div class="cron-filter-dropdown" data-filter=${params.id}>
      <wa-dropdown
        class="cron-filter-dropdown__details"
        placement="bottom-start"
        @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
          const value = event.detail.item.value;
          if (value === `${FILTER_COMMAND_PREFIX}clear`) {
            params.onClear();
            return;
          }
          if (value?.startsWith(FILTER_OPTION_PREFIX)) {
            event.preventDefault();
            const optionValue = value.slice(FILTER_OPTION_PREFIX.length);
            params.onToggle(optionValue, !params.selected.includes(optionValue));
          }
        }}
      >
        <button
          slot="trigger"
          type="button"
          class="btn btn--sm cron-filter-dropdown__trigger ${
            params.selected.length > 0 ? "active" : ""
          }"
          title=${params.title}
          aria-label=${`${params.title} ${accessibleSummary}`}
        >
          <span>${params.summary}</span>
          ${icon("chevronDown")}
        </button>
        ${params.options.map(
          (option) => html`
            <wa-dropdown-item
              class="cron-filter-dropdown__option"
              type="checkbox"
              value=${`${FILTER_OPTION_PREFIX}${option.value}`}
              .checked=${params.selected.includes(option.value)}
            >
              ${option.label}
            </wa-dropdown-item>
          `,
        )}
        <div class="session-menu__separator" role="separator"></div>
        <wa-dropdown-item value=${`${FILTER_COMMAND_PREFIX}clear`}>
          ${t("cron.runs.clear")}
        </wa-dropdown-item>
      </wa-dropdown>
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
  const sortLabel =
    props.runsSortDir === "asc" ? t("cron.runs.oldestFirst") : t("cron.runs.newestFirst");
  return html`
    <div class="cron-runs">
      ${props.conditionActivity ? renderConditionActivity(props.conditionActivity) : nothing}
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
        <div class="cron-filter-dropdown">
          <wa-dropdown
            class="cron-filter-dropdown__details"
            placement="bottom-start"
            @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
              const value = event.detail.item.value;
              if (value === "asc" || value === "desc") {
                void props.onRunsFiltersChange({ cronRunsSortDir: value });
              }
            }}
          >
            <button
              slot="trigger"
              type="button"
              class="btn btn--sm cron-filter-dropdown__trigger cron-run-sort"
              aria-label=${`${t("cron.jobs.sort")} ${sortLabel}`}
            >
              <span>${sortLabel}</span>
              ${icon("chevronDown")}
            </button>
            <wa-dropdown-item value="desc" aria-current=${String(props.runsSortDir === "desc")}>
              ${t("cron.runs.newestFirst")}
              <span slot="details" aria-hidden="true">
                ${props.runsSortDir === "desc" ? icon("check") : nothing}
              </span>
            </wa-dropdown-item>
            <wa-dropdown-item value="asc" aria-current=${String(props.runsSortDir === "asc")}>
              ${t("cron.runs.oldestFirst")}
              <span slot="details" aria-hidden="true">
                ${props.runsSortDir === "asc" ? icon("check") : nothing}
              </span>
            </wa-dropdown-item>
          </wa-dropdown>
        </div>
      </div>
      ${
        runs.length === 0
          ? hasRunFilters
            ? html`<div class="muted cron-runs__empty">${t("cron.runs.noMatching")}</div>`
            : html`
                <div class="cron-empty-state">
                  <div class="cron-empty-state__title">
                    ${
                      props.conditionActivity
                        ? t("cron.runs.emptyConditionTitle")
                        : t("cron.runs.emptyTitle")
                    }
                  </div>
                  <div class="cron-empty-state__copy">
                    ${
                      props.conditionActivity
                        ? conditionEmptyHint(props.conditionActivity)
                        : t("cron.runs.emptyHint")
                    }
                  </div>
                </div>
              `
          : html`
              <div class="cron-runs__list">
                ${runs.map((entry) =>
                  renderRun(
                    entry,
                    props.agentId,
                    props.basePath,
                    props.highlightedRunId,
                    props.onNavigateToChat,
                  ),
                )}
              </div>
            `
      }
      ${
        props.runsHasMore
          ? html`
              <button
                class="btn btn--sm cron-load-more"
                ?disabled=${props.runsLoadingMore}
                @click=${props.onLoadMoreRuns}
              >
                ${props.runsLoadingMore ? t("cron.list.loading") : t("cron.runs.loadMore")}
              </button>
            `
          : nothing
      }
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

function runFailureLabelText(
  entry: Parameters<typeof runFailureLabel>[0],
  nowMs: number,
): string | null {
  const label = runFailureLabel(entry, nowMs);
  if (!label) {
    return null;
  }
  return t(`cron.runs.failureLabel.${label}`);
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

/** Localized label for a recorded run origin. Missing values render nothing. */
function runOriginLabel(trigger: string | undefined): string | null {
  switch (trigger) {
    case "scheduled":
      return t("cron.runs.originScheduled");
    case "manual":
      return t("cron.runs.originManual");
    case "trigger-script":
      return t("cron.runs.originTriggerScript");
    case "on-exit":
      return t("cron.runs.originOnExit");
    case "stream":
      return t("cron.runs.originStream");
    case undefined:
      return null;
    default:
      return t("cron.runs.originLegacyUnknown");
  }
}

function renderRun(
  entry: CronRunLogEntry,
  fallbackAgentId: string,
  basePath: string,
  highlightedRunId?: string | null,
  onNavigateToChat?: (sessionKey: string) => void,
) {
  const chatUrl =
    typeof entry.sessionKey === "string" && entry.sessionKey.trim().length > 0
      ? sessionNavigationTarget({
          face: "chat",
          sessionKey: entry.sessionKey,
          fallbackAgentId,
          basePath,
        }).href
      : null;
  const status = runStatusLabel(entry.status ?? "unknown");
  const failure = runFailureLabelText(entry, Date.now());
  const delivery = runDeliveryLabel(entry.deliveryStatus ?? "not-requested");
  const usage = entry.usage;
  const usageSummary =
    usage && typeof usage.total_tokens === "number"
      ? `${formatCompactTokenCount(usage.total_tokens)} ${t("usage.metrics.tokens")}`
      : usage && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number"
        ? `${formatCompactTokenCount(usage.input_tokens)} in / ${formatCompactTokenCount(usage.output_tokens)} out`
        : null;
  const bodySource =
    entry.summary || formatUiExternalText(entry.error) || t("cron.runEntry.noSummary");
  const showErrorInMeta = Boolean(entry.error) && Boolean(entry.summary);
  const suppressionReason = formatUiExternalText(entry.deliverySuppressionReason);
  const facts = [
    runOriginLabel(entry.trigger),
    delivery,
    suppressionReason
      ? t("cron.runEntry.deliverySuppression", { reason: suppressionReason })
      : null,
    entry.model,
    entry.provider,
    usageSummary,
  ].filter(Boolean);
  const highlighted = Boolean(highlightedRunId && cronRunEntryMatchesLink(highlightedRunId, entry));
  return html`
    <div class="cron-run-entry ${highlighted ? "cron-run-entry--highlighted" : ""}">
      <div class="cron-run-entry__header">
        <div class="cron-run-entry__main">
          <div class="cron-run-entry__title">
            ${entry.jobName ?? entry.jobId}
            <span class="muted"> · ${status}</span>
            ${
              failure
                ? html`<span
                    class="cron-run-entry__failure-pill"
                    data-cause=${entry.completionCause ?? "derived"}
                    >${failure}</span
                  >`
                : nothing
            }
          </div>
          <div class="cron-run-entry__facts muted">${facts.join(" · ")}</div>
        </div>
        <div class="cron-run-entry__meta">
          <div>${formatMs(entry.ts)}</div>
          ${
            typeof entry.runAtMs === "number"
              ? html`<div class="muted">
                  ${t("cron.runEntry.runAt")} ${formatMs(entry.runAtMs)}
                </div>`
              : nothing
          }
          <div class="muted">
            ${
              typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs)
                ? (formatDurationCompact(entry.durationMs) ??
                  formatDurationHuman(entry.durationMs, t("common.na")))
                : t("common.na")
            }
          </div>
          ${
            typeof entry.nextRunAtMs === "number"
              ? html`<div class="muted">${formatRunNextLabel(entry.nextRunAtMs)}</div>`
              : nothing
          }
          ${
            chatUrl
              ? html`<div>
                  <a
                    class="session-link"
                    href=${chatUrl}
                    @click=${(e: MouseEvent) => {
                      if (!shouldHandleNavigationClick(e)) {
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
              : nothing
          }
          ${
            showErrorInMeta
              ? html`<div class="muted">${formatUiExternalText(entry.error)}</div>`
              : nothing
          }
          ${
            entry.deliveryError
              ? html`<div class="muted">${formatUiExternalText(entry.deliveryError)}</div>`
              : nothing
          }
        </div>
      </div>
      <div class="cron-run-entry__body chat-text">
        ${unsafeHTML(toSanitizedMarkdownHtml(bodySource))}
      </div>
    </div>
  `;
}
