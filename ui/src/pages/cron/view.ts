// Control UI view renders the Automations (cron) screen: a full-width list (stats, task table,
// starter ideas) and a full-page detail view for creating or editing a single automation.
import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { repeat } from "lit/directives/repeat.js";
import type { ChannelUiMetaEntry, CronJob, CronRunLogEntry, CronStatus } from "../../api/types.ts";
import "../../styles/chat/text.css";
import "../../styles/cron.css";
import type {
  CronDeliveryStatus,
  CronJobsEnabledFilter,
  CronRunsStatusValue,
  CronJobsSortBy,
  CronSortDir,
} from "../../api/types.ts";
import { icon, icons } from "../../components/icons.ts";
import {
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsToggle,
  renderSettingsToggleRow,
} from "../../components/settings-ui.ts";
import "../../components/tooltip.ts";
import "../../components/web-awesome.ts";
import "../../components/web-awesome-popover.ts";
import { t } from "../../i18n/index.ts";
import { isCronJobActiveFailure, resolveCronJobLastRunStatus } from "../../lib/cron-status.ts";
import { parseCronEveryMs } from "../../lib/cron/decimal.ts";
import type {
  CronFieldErrors,
  CronFieldKey,
  CronFormState,
  CronJobsLastStatusFilter,
  CronJobsScheduleKindFilter,
} from "../../lib/cron/index.ts";
import { formatRelativeTimestamp, formatMs } from "../../lib/format.ts";
import { formatCronSchedule } from "../../lib/presenter.ts";
import { normalizeStringEntries, uniqueStrings } from "../../lib/string-coerce.ts";
import { renderSegmented } from "./segmented-control.ts";
import { renderCronStats } from "./stats.ts";
import { CRON_SUGGESTIONS, suggestionFormPatch } from "./suggestions.ts";
import { renderRunsSection, runStatusLabel } from "./view-runs.ts";

type CronPanelMode = "overview" | "create" | "job";

export type CronListTab = "tasks" | "activity";
export type CronDetailTab = "settings" | "history";

type CronProps = {
  basePath: string;
  loading: boolean;
  jobsLoadingMore: boolean;
  status: CronStatus | null;
  failingCount: number | null;
  agentScoped: boolean;
  scopedTotal: number | null;
  scopedNextWakeAtMs: number | null;
  jobs: CronJob[];
  jobsTotal: number;
  jobsHasMore: boolean;
  jobsQuery: string;
  jobsEnabledFilter: CronJobsEnabledFilter;
  jobsScheduleKindFilter: CronJobsScheduleKindFilter;
  jobsLastStatusFilter: CronJobsLastStatusFilter;
  jobsSortBy: CronJobsSortBy;
  jobsSortDir: CronSortDir;
  error: string | null;
  busy: boolean;
  form: CronFormState;
  fieldErrors: CronFieldErrors;
  canSubmit: boolean;
  editingJobId: string | null;
  createOpen: boolean;
  listTab: CronListTab;
  detailTab: CronDetailTab;
  channels: string[];
  channelLabels?: Record<string, string>;
  channelMeta?: ChannelUiMetaEntry[];
  runs: CronRunLogEntry[];
  runsTotal: number;
  runsHasMore: boolean;
  runsLoadingMore: boolean;
  runsStatuses: CronRunsStatusValue[];
  runsDeliveryStatuses: CronDeliveryStatus[];
  runsQuery: string;
  runsSortDir: CronSortDir;
  agentSuggestions: string[];
  modelSuggestions: string[];
  thinkingSuggestions: string[];
  timezoneSuggestions: string[];
  deliveryToSuggestions: string[];
  accountSuggestions: string[];
  onListTabChange: (tab: CronListTab) => void;
  onDetailTabChange: (tab: CronDetailTab) => void;
  onFormChange: (patch: Partial<CronFormState>) => void;
  onRefresh: () => void;
  onSubmit: () => void;
  onSubmitRunNow: () => void;
  onSelectJob: (job: CronJob) => void;
  onOpenCreate: (patch?: Partial<CronFormState>) => void;
  onClosePanel: () => void;
  onClone: (job: CronJob) => void;
  onToggle: (job: CronJob, enabled: boolean) => void;
  onRun: (job: CronJob, mode?: "force" | "due") => void;
  onRemove: (job: CronJob) => void;
  onLoadMoreJobs: () => void;
  onJobsFiltersChange: (patch: {
    cronJobsQuery?: string;
    cronJobsEnabledFilter?: CronJobsEnabledFilter;
    cronJobsScheduleKindFilter?: CronJobsScheduleKindFilter;
    cronJobsLastStatusFilter?: CronJobsLastStatusFilter;
    cronJobsSortBy?: CronJobsSortBy;
    cronJobsSortDir?: CronSortDir;
  }) => void | Promise<void>;
  onJobsFiltersReset: () => void | Promise<void>;
  onLoadMoreRuns: () => void;
  onRunsFiltersChange: (patch: {
    cronRunsStatuses?: CronRunsStatusValue[];
    cronRunsDeliveryStatuses?: CronDeliveryStatus[];
    cronRunsQuery?: string;
    cronRunsSortDir?: CronSortDir;
  }) => void | Promise<void>;
  onNavigateToChat?: (sessionKey: string) => void;
};

// ── Shared option helpers ──

function buildChannelOptions(props: CronProps): string[] {
  const options = ["last", ...props.channels.filter(Boolean)];
  const current = props.form.deliveryChannel?.trim();
  if (current && !options.includes(current)) {
    options.push(current);
  }
  const seen = new Set<string>();
  return options.filter((value) => {
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
}

function resolveChannelLabel(props: CronProps, channel: string): string {
  if (channel === "last") {
    return "last";
  }
  const meta = props.channelMeta?.find((entry) => entry.id === channel);
  if (meta?.label) {
    return meta.label;
  }
  return props.channelLabels?.[channel] ?? channel;
}

function renderSuggestionList(id: string, options: string[]) {
  const clean = uniqueStrings(normalizeStringEntries(options));
  if (clean.length === 0) {
    return nothing;
  }
  return html`<datalist id=${id}>
    ${clean.map((value) => html`<option value=${value}></option> `)}
  </datalist>`;
}

// ── Validation summary helpers ──

type BlockingField = {
  key: CronFieldKey;
  label: string;
  message: string;
  inputId: string;
};

function errorIdForField(key: CronFieldKey) {
  return `cron-error-${key}`;
}

function inputIdForField(key: CronFieldKey) {
  if (key === "name") {
    return "cron-name";
  }
  if (key === "scheduleAt") {
    return "cron-schedule-at";
  }
  if (key === "everyAmount") {
    return "cron-every-amount";
  }
  if (key === "cronExpr") {
    return "cron-cron-expr";
  }
  if (key === "staggerAmount") {
    return "cron-stagger-amount";
  }
  if (key === "payloadText") {
    return "cron-payload-text";
  }
  if (key === "payloadModel") {
    return "cron-payload-model";
  }
  if (key === "payloadThinking") {
    return "cron-payload-thinking";
  }
  if (key === "timeoutSeconds") {
    return "cron-timeout-seconds";
  }
  if (key === "failureAlertAfter") {
    return "cron-failure-alert-after";
  }
  if (key === "failureAlertCooldownSeconds") {
    return "cron-failure-alert-cooldown-seconds";
  }
  return "cron-delivery-to";
}

function fieldLabelForKey(
  key: CronFieldKey,
  form: CronFormState,
  deliveryMode: CronFormState["deliveryMode"],
) {
  if (key === "payloadText") {
    return form.payloadKind === "systemEvent"
      ? t("cron.form.mainTimelineMessage")
      : t("cron.form.assistantTaskPrompt");
  }
  if (key === "deliveryTo") {
    return deliveryMode === "webhook" ? t("cron.form.webhookUrl") : t("cron.form.to");
  }
  const labels: Record<CronFieldKey, string> = {
    name: t("cron.form.fieldName"),
    scheduleAt: t("cron.form.runAt"),
    everyAmount: t("cron.form.every"),
    cronExpr: t("cron.form.expression"),
    staggerAmount: t("cron.form.staggerWindow"),
    payloadText: t("cron.form.assistantTaskPrompt"),
    payloadModel: t("cron.form.model"),
    payloadThinking: t("cron.form.thinking"),
    timeoutSeconds: t("cron.form.timeoutSeconds"),
    deliveryTo: t("cron.form.to"),
    failureAlertAfter: t("cron.form.failureAlertAfter"),
    failureAlertCooldownSeconds: t("cron.form.failureAlertCooldown"),
  };
  return labels[key];
}

function collectBlockingFields(
  errors: CronFieldErrors,
  form: CronFormState,
  deliveryMode: CronFormState["deliveryMode"],
): BlockingField[] {
  const orderedKeys: CronFieldKey[] = [
    "name",
    "scheduleAt",
    "everyAmount",
    "cronExpr",
    "staggerAmount",
    "payloadText",
    "payloadModel",
    "payloadThinking",
    "timeoutSeconds",
    "deliveryTo",
    "failureAlertAfter",
    "failureAlertCooldownSeconds",
  ];
  const fields: BlockingField[] = [];
  for (const key of orderedKeys) {
    const message = errors[key];
    if (!message) {
      continue;
    }
    fields.push({
      key,
      label: fieldLabelForKey(key, form, deliveryMode),
      message,
      inputId: inputIdForField(key),
    });
  }
  return fields;
}

function focusFormField(id: string) {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLElement)) {
    return;
  }
  if (typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  el.focus();
}

function renderFieldError(message?: string, id?: string) {
  if (!message) {
    return nothing;
  }
  return html`<div id=${ifDefined(id)} class="cron-help cron-error">${t(message)}</div>`;
}

// ── Row primitives (settings design language) ──

function renderRequiredTitle(label: string) {
  return html`
    ${label}
    <span class="cron-required-marker" aria-hidden="true">*</span>
    <span class="cron-required-sr">${t("cron.form.requiredSr")}</span>
  `;
}

// Settings row whose control keeps its own validation message underneath. Mirrors
// renderSettingsRow markup; local only so the title can be a real <label for> that gives the
// wrapped control its accessible name (including the visually-hidden required marker).
function renderFieldRow(params: {
  label: string;
  controlId: string;
  control: unknown;
  required?: boolean;
  help?: string;
  error?: string;
  errorId?: string;
  stacked?: boolean;
  wide?: boolean;
}) {
  const controlClass = params.wide ? "cron-control cron-control--wide" : "cron-control";
  const control = params.error
    ? html`<div class=${controlClass}>
        ${params.control}${renderFieldError(params.error, params.errorId)}
      </div>`
    : html`<div class=${controlClass}>${params.control}</div>`;
  return html`
    <div class=${params.stacked ? "settings-row settings-row--stacked" : "settings-row"}>
      <label class="settings-row__text" for=${params.controlId}>
        <span class="settings-row__title">
          ${params.required ? renderRequiredTitle(params.label) : params.label}
        </span>
        ${params.help ? html`<span class="settings-row__desc">${params.help}</span>` : nothing}
      </label>
      <div class="settings-row__control">${control}</div>
    </div>
  `;
}

function renderToggleRow(params: {
  label: string;
  checked: boolean;
  help?: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return renderSettingsToggleRow({
    title: params.label,
    description: params.help,
    checked: params.checked,
    disabled: params.disabled,
    onChange: params.onChange,
  });
}

// ── Main render ──

export function renderCron(props: CronProps) {
  const mode: CronPanelMode = props.editingJobId ? "job" : props.createOpen ? "create" : "overview";
  return html`
    ${mode === "overview" ? renderListView(props) : renderDetailView(props, mode)}
    ${renderSuggestionList("cron-agent-suggestions", props.agentSuggestions)}
    ${renderSuggestionList("cron-model-suggestions", props.modelSuggestions)}
    ${renderSuggestionList("cron-thinking-suggestions", props.thinkingSuggestions)}
    ${renderSuggestionList("cron-tz-suggestions", props.timezoneSuggestions)}
    ${renderSuggestionList("cron-delivery-to-suggestions", props.deliveryToSuggestions)}
    ${renderSuggestionList("cron-delivery-account-suggestions", props.accountSuggestions)}
  `;
}

// ── List view ──

const ENABLED_TABS: Array<{ value: CronJobsEnabledFilter; labelKey: string }> = [
  { value: "all", labelKey: "cron.tabs.all" },
  { value: "enabled", labelKey: "cron.tabs.active" },
  { value: "disabled", labelKey: "cron.tabs.paused" },
];

function renderListView(props: CronProps) {
  const hasAdvancedJobsFilters =
    props.jobsScheduleKindFilter !== "all" ||
    props.jobsLastStatusFilter !== "all" ||
    props.jobsSortBy !== "nextRunAtMs" ||
    props.jobsSortDir !== "asc";
  const hasAnyJobsFilters =
    hasAdvancedJobsFilters ||
    props.jobsQuery.trim().length > 0 ||
    props.jobsEnabledFilter !== "all";
  const children = [
    renderSettingsSection({}, renderCronStats(props)),
    props.status && !props.status.enabled
      ? html`
          <div class="cron-error-banner" data-test-id="cron-scheduler-banner">
            <strong>${t("cron.list.schedulerOff")}</strong> ${t("cron.runNotStarted.stopped")}
          </div>
        `
      : nothing,
    props.error ? html`<div class="cron-error-banner">${props.error}</div>` : nothing,
    renderToolbar(props, hasAdvancedJobsFilters),
    html`
      <div
        id="cron-list-panel"
        class="cron-tab-panel"
        role="tabpanel"
        aria-labelledby=${`cron-list-tab-${props.listTab}`}
      >
        ${props.listTab === "activity"
          ? renderSettingsSection(
              {},
              html`<div class="cron-activity">${renderRunsSection(props)}</div>`,
            )
          : [
              renderSettingsSection({}, renderJobsTable(props, hasAnyJobsFilters)),
              hasAnyJobsFilters ? nothing : renderSuggestions(props),
            ]}
      </div>
    `,
  ];
  return html`
    <section class="cron-page" data-panel-mode="overview">
      ${renderSettingsPage(children, { wide: true })}
    </section>
  `;
}

function renderListTabs(props: CronProps) {
  return renderSegmented<CronListTab>({
    value: props.listTab,
    options: [
      { value: "tasks", label: t("cron.list.tasksTab"), testId: "cron-list-tab-tasks" },
      { value: "activity", label: t("cron.list.activityTab"), testId: "cron-list-tab-activity" },
    ],
    ariaLabel: t("cron.list.viewLabel"),
    tabs: { idPrefix: "cron-list-tab-", panelId: "cron-list-panel" },
    onChange: props.onListTabChange,
  });
}

// One toolbar row for both list tabs: view switch left, tab filters middle, refresh + New right.
function renderToolbar(props: CronProps, hasAdvancedJobsFilters: boolean) {
  return html`
    <div class="cron-toolbar">
      ${renderListTabs(props)}
      ${props.listTab === "tasks"
        ? html`
            ${renderSegmented<CronJobsEnabledFilter>({
              value: props.jobsEnabledFilter,
              options: ENABLED_TABS.map((tab) => ({
                value: tab.value,
                label: t(tab.labelKey),
                testId: `cron-tab-${tab.value}`,
              })),
              ariaLabel: t("cron.tabs.filterLabel"),
              onChange: (value) => void props.onJobsFiltersChange({ cronJobsEnabledFilter: value }),
            })}
            <div class="cron-search-box">
              <span class="cron-search-box__icon" aria-hidden="true">${icon("search")}</span>
              <input
                type="search"
                class="settings-input"
                .value=${props.jobsQuery}
                aria-label=${t("cron.list.searchPlaceholder")}
                placeholder=${t("cron.list.searchPlaceholder")}
                @input=${(e: Event) =>
                  props.onJobsFiltersChange({
                    cronJobsQuery: (e.target as HTMLInputElement).value,
                  })}
              />
            </div>
            ${renderJobsFilterPopover(props, hasAdvancedJobsFilters)}
          `
        : nothing}
      <div class="cron-toolbar__end">
        <button
          type="button"
          class="btn btn--sm btn--ghost cron-refresh ${props.loading
            ? "cron-refresh--loading"
            : ""}"
          ?disabled=${props.loading}
          title=${props.loading ? t("cron.list.refreshing") : t("cron.list.refresh")}
          aria-label=${t("cron.list.refresh")}
          @click=${props.onRefresh}
        >
          ${icon("refresh")}
        </button>
        <button
          type="button"
          class="btn primary btn--sm cron-new-task"
          data-test-id="cron-new-task"
          @click=${() => props.onOpenCreate()}
        >
          ${icon("plus")} ${t("cron.list.newTask")}
        </button>
      </div>
    </div>
  `;
}

function renderJobsFilterPopover(props: CronProps, active: boolean) {
  return html`
    <button
      id="cron-jobs-filter-trigger"
      type="button"
      class="btn btn--sm cron-filter-popover__trigger ${active ? "active" : ""}"
      title=${t("cron.list.filters")}
      aria-label=${t("cron.list.filters")}
      aria-haspopup="dialog"
      aria-expanded="false"
    >
      ${icon("listFilter")}
    </button>
    <wa-popover
      class="cron-filter-popover"
      for="cron-jobs-filter-trigger"
      placement="bottom-end"
      without-arrow
      @wa-show=${(event: Event) => {
        (event.currentTarget as Element).previousElementSibling?.setAttribute(
          "aria-expanded",
          "true",
        );
      }}
      @wa-hide=${(event: Event) => {
        (event.currentTarget as Element).previousElementSibling?.setAttribute(
          "aria-expanded",
          "false",
        );
      }}
    >
      <div class="cron-filter-popover__panel">
        <label class="field">
          <span>${t("cron.jobs.schedule")}</span>
          <select
            class="settings-select"
            data-test-id="cron-jobs-schedule-filter"
            .value=${props.jobsScheduleKindFilter}
            @change=${(e: Event) =>
              props.onJobsFiltersChange({
                cronJobsScheduleKindFilter: (e.target as HTMLSelectElement)
                  .value as CronJobsScheduleKindFilter,
              })}
          >
            <option value="all">${t("cron.jobs.all")}</option>
            <option value="at">${t("cron.form.at")}</option>
            <option value="every">${t("cron.form.every")}</option>
            <option value="cron">${t("cron.form.cronOption")}</option>
          </select>
        </label>
        <label class="field">
          <span>${t("cron.jobs.lastRun")}</span>
          <select
            class="settings-select"
            data-test-id="cron-jobs-last-status-filter"
            .value=${props.jobsLastStatusFilter}
            @change=${(e: Event) =>
              props.onJobsFiltersChange({
                cronJobsLastStatusFilter: (e.target as HTMLSelectElement)
                  .value as CronJobsLastStatusFilter,
              })}
          >
            <option value="all">${t("cron.jobs.all")}</option>
            <option value="ok">${t("cron.runs.runStatusOk")}</option>
            <option value="error">${t("cron.runs.runStatusError")}</option>
            <option value="skipped">${t("cron.runs.runStatusSkipped")}</option>
            <option value="unknown">${t("cron.runs.runStatusUnknown")}</option>
          </select>
        </label>
        <label class="field">
          <span>${t("cron.jobs.sort")}</span>
          <select
            class="settings-select"
            .value=${props.jobsSortBy}
            @change=${(e: Event) =>
              props.onJobsFiltersChange({
                cronJobsSortBy: (e.target as HTMLSelectElement).value as CronJobsSortBy,
              })}
          >
            <option value="nextRunAtMs">${t("cron.jobs.nextRun")}</option>
            <option value="updatedAtMs">${t("cron.jobs.recentlyUpdated")}</option>
            <option value="name">${t("cron.jobs.name")}</option>
          </select>
        </label>
        <label class="field">
          <span>${t("cron.jobs.direction")}</span>
          <select
            class="settings-select"
            .value=${props.jobsSortDir}
            @change=${(e: Event) =>
              props.onJobsFiltersChange({
                cronJobsSortDir: (e.target as HTMLSelectElement).value as CronSortDir,
              })}
          >
            <option value="asc">${t("cron.jobs.ascending")}</option>
            <option value="desc">${t("cron.jobs.descending")}</option>
          </select>
        </label>
        <button
          class="btn btn--sm"
          data-test-id="cron-jobs-filters-reset"
          ?disabled=${!active}
          @click=${props.onJobsFiltersReset}
        >
          ${t("cron.jobs.reset")}
        </button>
      </div>
    </wa-popover>
  `;
}

function renderJobsTable(props: CronProps, hasAnyJobsFilters: boolean) {
  return html`
    <div class="cron-table">
      <div class="cron-table__head" role="row">
        <span>${t("cron.jobs.name")}</span>
        <span>${t("cron.jobs.schedule")}</span>
        <span>${t("cron.jobs.nextRun")}</span>
        <span>${t("cron.jobs.lastRun")}</span>
        <span aria-hidden="true"></span>
      </div>
      ${props.jobs.length === 0
        ? html`
            <div class="cron-empty-state">
              <div class="cron-empty-state__title">
                ${hasAnyJobsFilters ? t("cron.list.noMatching") : t("cron.list.emptyTitle")}
              </div>
              ${hasAnyJobsFilters
                ? nothing
                : html`<div class="cron-empty-state__copy">${t("cron.list.emptyHint")}</div>`}
            </div>
          `
        : repeat(
            props.jobs,
            (job) => job.id,
            (job) => renderJobRow(job, props),
          )}
      <div class="cron-table__footer">
        <span class="muted">
          ${t("cron.list.shownOf", {
            shown: String(props.jobs.length),
            total: String(Math.max(props.jobsTotal, props.jobs.length)),
          })}
        </span>
        ${props.jobsHasMore
          ? html`
              <button
                class="btn btn--sm cron-load-more"
                ?disabled=${props.loading || props.jobsLoadingMore}
                @click=${props.onLoadMoreJobs}
              >
                ${props.jobsLoadingMore ? t("cron.list.loading") : t("cron.list.loadMore")}
              </button>
            `
          : nothing}
      </div>
    </div>
  `;
}

function renderJobRow(job: CronJob, props: CronProps) {
  const nextRunAtMs = job.state?.nextRunAtMs;
  const hasNextRun = typeof nextRunAtMs === "number" && Number.isFinite(nextRunAtMs);
  const dotVariant = isCronJobActiveFailure(job)
    ? "cron-table__dot--error"
    : job.enabled
      ? "cron-table__dot--active"
      : "";
  return html`
    <div
      class="cron-table__row ${job.enabled ? "" : "cron-table__row--paused"}"
      role="button"
      tabindex="0"
      data-test-id=${`cron-row-${job.id}`}
      @click=${() => props.onSelectJob(job)}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onSelectJob(job);
        }
      }}
    >
      <span class="cron-table__name">
        <span class="cron-table__dot ${dotVariant}" aria-hidden="true"></span>
        <span class="cron-table__name-text">${job.name}</span>
        ${job.enabled
          ? nothing
          : html`<span class="muted cron-table__paused-note">${t("cron.list.paused")}</span>`}
      </span>
      <span class="cron-table__cell">${formatCronSchedule(job)}</span>
      <span class="cron-table__cell">
        ${hasNextRun ? formatRelativeTimestamp(nextRunAtMs) : t("common.na")}
      </span>
      <span class="cron-table__cell cron-table__last">${renderLastRunCell(job)}</span>
      <span
        class="cron-table__actions"
        @click=${(e: Event) => e.stopPropagation()}
        @keydown=${(e: Event) => e.stopPropagation()}
      >
        <button
          type="button"
          class="btn btn--sm btn--ghost cron-row-run"
          data-test-id=${`cron-row-run-${job.id}`}
          title=${t("cron.actions.runNow")}
          aria-label=${t("cron.actions.runNow")}
          ?disabled=${props.busy}
          @click=${() => props.onRun(job, "force")}
        >
          ${icon("play")}
        </button>
        ${renderEnabledSwitch(props, job, {
          compact: true,
          testId: `cron-row-toggle-${job.id}`,
        })}
        ${renderJobMenu(props, job)}
      </span>
    </div>
  `;
}

function renderLastRunCell(job: CronJob) {
  const status = resolveCronJobLastRunStatus(job);
  const lastRunAtMs = job.state?.lastRunAtMs;
  const rel =
    typeof lastRunAtMs === "number" && Number.isFinite(lastRunAtMs)
      ? formatRelativeTimestamp(lastRunAtMs)
      : null;
  if (status === "unknown" || !rel) {
    return html`<span class="muted">${t("common.na")}</span>`;
  }
  // Bare glyph + time reads calmer than a chip per row; the status word stays
  // available to hover and assistive tech via the label.
  const glyph =
    status === "ok"
      ? html`<span class="cron-last-glyph cron-last-glyph--ok">${icon("check")}</span>`
      : status === "error"
        ? html`<span class="cron-last-glyph cron-last-glyph--error">${icon("x")}</span>`
        : html`<span class="cron-last-glyph">${icon("cornerDownRight")}</span>`;
  const label = runStatusLabel(status);
  return html`
    <span class="cron-table__last-run" role="img" aria-label=${label} title=${label}>
      ${glyph}
      <span class="cron-table__last-time">${rel}</span>
    </span>
  `;
}

// Run now and pause/resume are visible controls (rows and detail header);
// the menu only carries the low-traffic actions.
function renderJobMenu(props: CronProps, job: CronJob) {
  return html`
    <wa-dropdown
      class="cron-job-menu"
      placement="bottom-end"
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
        switch (event.detail.item.value) {
          case "run-if-due":
            props.onRun(job, "due");
            break;
          case "clone":
            props.onClone(job);
            break;
          case "remove":
            props.onRemove(job);
            break;
          case undefined:
            break;
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        class="btn btn--sm btn--ghost cron-job-menu__trigger"
        aria-label=${t("cron.actions.more")}
        title=${t("cron.actions.more")}
      >
        ${icon("moreHorizontal")}
      </button>
      ${renderMenuItem(props, "run-if-due", t("cron.actions.runIfDue"))}
      ${renderMenuItem(props, "clone", t("cron.actions.clone"))}
      ${renderMenuItem(props, "remove", t("cron.actions.remove"), { danger: true })}
    </wa-dropdown>
  `;
}

function renderSuggestions(props: CronProps) {
  // Starter ideas are drill-in rows: activating one prefills the create form.
  return renderSettingsSection(
    { title: t("cron.suggestions.title") },
    CRON_SUGGESTIONS.map(
      (suggestion) => html`
        <button
          type="button"
          class="settings-row settings-row--nav cron-suggestion"
          data-suggestion=${suggestion.id}
          @click=${() => props.onOpenCreate(suggestionFormPatch(suggestion))}
        >
          <div class="settings-row__text">
            <span class="settings-row__title">
              <span aria-hidden="true">${suggestion.emoji}</span> ${t(suggestion.nameKey)}
            </span>
            <span class="settings-row__desc">${t(suggestion.taglineKey)}</span>
          </div>
          <div class="settings-row__control">
            <span class="settings-row__value">${t(suggestion.scheduleKey)}</span>
            <span class="settings-row__chevron">${icons.chevronRight}</span>
          </div>
        </button>
      `,
    ),
  );
}

// ── Detail view ──

function renderDetailView(props: CronProps, mode: CronPanelMode) {
  const selectedJob =
    mode === "job" ? props.jobs.find((job) => job.id === props.editingJobId) : undefined;
  const hasDetailTabs = mode === "job" && Boolean(selectedJob);
  const showHistory = mode === "job" && props.detailTab === "history";
  const children = [
    html`
      <div class="cron-back-row">
        <button
          type="button"
          class="cron-back"
          data-test-id="cron-back"
          ?disabled=${props.busy}
          @click=${props.onClosePanel}
        >
          ${icon("arrowLeft")} ${t("cron.detail.back")}
        </button>
      </div>
    `,
    renderDetailHeader(props, mode, selectedJob),
    hasDetailTabs ? renderDetailTabs(props) : nothing,
    props.error ? html`<div class="cron-error-banner">${props.error}</div>` : nothing,
    html`
      <div
        id="cron-detail-panel"
        class="cron-tab-panel"
        role=${hasDetailTabs ? "tabpanel" : nothing}
        aria-labelledby=${hasDetailTabs ? `cron-detail-tab-${props.detailTab}` : nothing}
      >
        ${showHistory
          ? renderSettingsSection(
              { title: t("cron.detail.historyTitle") },
              html`<div class="cron-history">${renderRunsSection(props)}</div>`,
            )
          : renderEditor(props, mode)}
      </div>
    `,
  ];
  return html`
    <section class="cron-page cron-page--detail" data-panel-mode=${mode}>
      ${renderSettingsPage(children, { wide: true })}
    </section>
  `;
}

function renderDetailHeader(props: CronProps, mode: CronPanelMode, selectedJob?: CronJob) {
  const title = mode === "job" ? (selectedJob?.name ?? props.form.name) : t("cron.detail.newTitle");
  // Header describes the SAVED job (schedule + next run); the form's live
  // summary describes unsaved edits, so the two never contradict each other.
  const nextRunAtMs = selectedJob?.state?.nextRunAtMs;
  const nextRunSuffix =
    typeof nextRunAtMs === "number" && Number.isFinite(nextRunAtMs)
      ? ` · ${t("cron.jobState.next")} ${formatRelativeTimestamp(nextRunAtMs)}`
      : "";
  const subtitle =
    mode === "job" && selectedJob
      ? `${formatCronSchedule(selectedJob)}${nextRunSuffix}`
      : t("cron.detail.newSubtitle");
  return html`
    <div class="cron-detail-header">
      <div class="cron-detail-header__copy">
        <div class="cron-detail-title">${title}</div>
        <div class="cron-detail-meta">
          ${mode === "job" && selectedJob ? renderEnabledSwitch(props, selectedJob) : nothing}
          <span class="cron-detail-sub">${subtitle}</span>
        </div>
      </div>
      <div class="cron-detail-actions">
        ${mode === "job" && selectedJob
          ? html`
              <button
                type="button"
                class="btn btn--sm"
                data-test-id="cron-run-now"
                ?disabled=${props.busy}
                @click=${() => props.onRun(selectedJob, "force")}
              >
                ${icon("play")} ${t("cron.actions.runNow")}
              </button>
              ${renderJobMenu(props, selectedJob)}
            `
          : nothing}
      </div>
    </div>
  `;
}

function renderEnabledSwitch(
  props: CronProps,
  job: CronJob,
  opts?: { compact?: boolean; testId?: string },
) {
  const stateLabel = job.enabled ? t("cron.detail.active") : t("cron.detail.paused");
  const actionLabel = job.enabled ? t("cron.actions.pause") : t("cron.actions.resume");
  return html`
    <span
      class="cron-enabled-toggle"
      data-test-id=${opts?.testId ?? "cron-toggle-enabled"}
      title=${opts?.compact ? actionLabel : nothing}
    >
      ${renderSettingsToggle({
        checked: job.enabled,
        disabled: props.busy,
        ariaLabel: opts?.compact ? actionLabel : stateLabel,
        onChange: (checked) => props.onToggle(job, checked),
      })}
      ${opts?.compact ? nothing : html`<span class="cron-detail-sub">${stateLabel}</span>`}
    </span>
  `;
}

function renderDetailTabs(props: CronProps) {
  return renderSegmented<CronDetailTab>({
    value: props.detailTab,
    options: [
      {
        value: "settings",
        label: t("cron.detail.settingsTab"),
        testId: "cron-detail-tab-settings",
      },
      { value: "history", label: t("cron.detail.historyTitle"), testId: "cron-detail-tab-history" },
    ],
    ariaLabel: t("cron.detail.tabsLabel"),
    tabs: { idPrefix: "cron-detail-tab-", panelId: "cron-detail-panel" },
    onChange: props.onDetailTabChange,
  });
}

function renderEditor(props: CronProps, mode: CronPanelMode) {
  const payloadLocked = props.form.payloadLocked;
  const isAgentTurn = !payloadLocked && props.form.payloadKind === "agentTurn";
  const supportsAnnounce =
    props.form.sessionTarget !== "main" &&
    (props.form.payloadKind === "agentTurn" || payloadLocked);
  const selectedDeliveryMode =
    props.form.deliveryMode === "announce" && !supportsAnnounce ? "none" : props.form.deliveryMode;
  const blockingFields = collectBlockingFields(props.fieldErrors, props.form, selectedDeliveryMode);
  const blockedByValidation = !props.busy && blockingFields.length > 0;
  const submitDisabledReason =
    blockedByValidation && !props.canSubmit
      ? blockingFields.length === 1
        ? t("cron.form.fixFields", { count: String(blockingFields.length) })
        : t("cron.form.fixFieldsPlural", { count: String(blockingFields.length) })
      : "";
  return html`
    <fieldset class="cron-editor" ?disabled=${props.busy} aria-busy=${String(props.busy)}>
      ${renderPromptSection(props, { payloadLocked, isAgentTurn })} ${renderGeneralSection(props)}
      ${renderScheduleSection(props)}
      ${renderDeliverySection(props, { supportsAnnounce, selectedDeliveryMode })}
      ${renderAdvanced(props, {
        mode,
        isAgentTurn,
        selectedDeliveryMode,
      })}
      ${blockedByValidation
        ? html`
            <div class="cron-form-status" role="status" aria-live="polite">
              <div class="cron-form-status__title">${t("cron.form.cantAddYet")}</div>
              <div class="cron-help">${t("cron.form.fillRequired")}</div>
              <ul class="cron-form-status__list">
                ${blockingFields.map(
                  (field) => html`
                    <li>
                      <button
                        type="button"
                        class="cron-form-status__link"
                        @click=${() => focusFormField(field.inputId)}
                      >
                        ${field.label}: ${t(field.message)}
                      </button>
                    </li>
                  `,
                )}
              </ul>
            </div>
          `
        : nothing}
      <div class="cron-editor-actions">
        <button
          class="btn primary"
          data-test-id="cron-submit"
          ?disabled=${props.busy || !props.canSubmit}
          @click=${props.onSubmit}
        >
          ${props.busy
            ? t("cron.form.saving")
            : mode === "job"
              ? t("cron.form.saveChanges")
              : t("cron.form.createTask")}
        </button>
        ${mode === "create"
          ? html`
              <button
                class="btn"
                data-test-id="cron-submit-run"
                ?disabled=${props.busy || !props.canSubmit}
                @click=${props.onSubmitRunNow}
              >
                ${t("cron.form.createAndRun")}
              </button>
            `
          : nothing}
        <button class="btn" ?disabled=${props.busy} @click=${props.onClosePanel}>
          ${t("cron.form.cancel")}
        </button>
        ${submitDisabledReason
          ? html` <div class="cron-submit-reason" aria-live="polite">${submitDisabledReason}</div> `
          : nothing}
      </div>
    </fieldset>
  `;
}

function renderMenuItem(
  props: CronProps,
  value: string,
  label: string,
  options?: { danger?: boolean },
) {
  return html`
    <wa-dropdown-item
      class=${options?.danger ? "cron-job-menu__item danger" : "cron-job-menu__item"}
      value=${value}
      variant=${options?.danger ? "danger" : "default"}
      ?disabled=${props.busy}
    >
      ${label}
    </wa-dropdown-item>
  `;
}

// ── Editor sections ──

function renderPromptSection(
  props: CronProps,
  ctx: { payloadLocked: boolean; isAgentTurn: boolean },
) {
  const promptLabel = ctx.payloadLocked
    ? t("cron.form.command")
    : props.form.payloadKind === "systemEvent"
      ? t("cron.form.mainTimelineMessage")
      : t("cron.form.assistantTaskPrompt");
  const promptHelp = ctx.payloadLocked
    ? undefined
    : props.form.payloadKind === "systemEvent"
      ? t("cron.form.systemEventHelp")
      : t("cron.form.agentTurnHelp");
  const promptRow = renderFieldRow({
    label: promptLabel,
    controlId: "cron-payload-text",
    required: true,
    help: promptHelp,
    stacked: true,
    wide: true,
    error: props.fieldErrors.payloadText,
    errorId: errorIdForField("payloadText"),
    control: html`
      <textarea
        id="cron-payload-text"
        class="settings-input"
        rows="6"
        .value=${props.form.payloadText}
        ?readonly=${ctx.payloadLocked}
        aria-required="true"
        placeholder=${t("cron.form.promptPlaceholder")}
        aria-invalid=${props.fieldErrors.payloadText ? "true" : "false"}
        aria-describedby=${ifDefined(
          props.fieldErrors.payloadText ? errorIdForField("payloadText") : undefined,
        )}
        @input=${(e: Event) =>
          props.onFormChange({ payloadText: (e.target as HTMLTextAreaElement).value })}
      ></textarea>
    `,
  });
  const actionRow = renderFieldRow({
    label: t("cron.form.action"),
    controlId: "cron-payload-kind",
    control: ctx.payloadLocked
      ? html`
          <input
            id="cron-payload-kind"
            class="settings-input"
            .value=${t("cron.form.command")}
            readonly
          />
        `
      : html`
          <select
            id="cron-payload-kind"
            class="settings-select"
            .value=${props.form.payloadKind}
            @change=${(e: Event) =>
              props.onFormChange({
                payloadKind: (e.target as HTMLSelectElement).value as CronFormState["payloadKind"],
              })}
          >
            <option value="systemEvent">${t("cron.form.systemEvent")}</option>
            <option value="agentTurn">${t("cron.form.agentTurn")}</option>
          </select>
        `,
  });
  const agentTurnRows = ctx.isAgentTurn
    ? html`
        ${renderFieldRow({
          label: t("cron.form.model"),
          controlId: "cron-payload-model",
          help: t("cron.form.modelHelp"),
          error: props.fieldErrors.payloadModel,
          errorId: errorIdForField("payloadModel"),
          control: html`
            <input
              id="cron-payload-model"
              class="settings-input"
              .value=${props.form.payloadModel}
              list="cron-model-suggestions"
              placeholder=${t("cron.form.modelPlaceholder")}
              aria-invalid=${props.fieldErrors.payloadModel ? "true" : "false"}
              @input=${(e: Event) =>
                props.onFormChange({ payloadModel: (e.target as HTMLInputElement).value })}
            />
          `,
        })}
        ${renderFieldRow({
          label: t("cron.form.thinking"),
          controlId: "cron-payload-thinking",
          help: t("cron.form.thinkingHelp"),
          error: props.fieldErrors.payloadThinking,
          errorId: errorIdForField("payloadThinking"),
          control: html`
            <input
              id="cron-payload-thinking"
              class="settings-input"
              .value=${props.form.payloadThinking}
              list="cron-thinking-suggestions"
              placeholder=${t("cron.form.thinkingPlaceholder")}
              aria-invalid=${props.fieldErrors.payloadThinking ? "true" : "false"}
              @input=${(e: Event) =>
                props.onFormChange({ payloadThinking: (e.target as HTMLInputElement).value })}
            />
          `,
        })}
      `
    : nothing;
  return renderSettingsSection({}, html`${promptRow}${actionRow}${agentTurnRows}`);
}

function renderGeneralSection(props: CronProps) {
  const sessionTarget = props.form.sessionTarget;
  const knownSessionTarget = sessionTarget === "main" || sessionTarget === "isolated";
  return renderSettingsSection(
    { title: t("cron.detail.generalSection") },
    html`
      ${renderFieldRow({
        label: t("cron.form.fieldName"),
        controlId: "cron-name",
        required: true,
        error: props.fieldErrors.name,
        errorId: errorIdForField("name"),
        control: html`
          <input
            id="cron-name"
            class="settings-input"
            aria-required="true"
            .value=${props.form.name}
            placeholder=${t("cron.form.namePlaceholder")}
            aria-invalid=${props.fieldErrors.name ? "true" : "false"}
            aria-describedby=${ifDefined(
              props.fieldErrors.name ? errorIdForField("name") : undefined,
            )}
            @input=${(e: Event) =>
              props.onFormChange({ name: (e.target as HTMLInputElement).value })}
          />
        `,
      })}
      ${renderFieldRow({
        label: t("cron.form.agentId"),
        controlId: "cron-agent-id",
        help: t("cron.form.agentHelp"),
        control: html`
          <input
            id="cron-agent-id"
            class="settings-input"
            .value=${props.form.agentId}
            list="cron-agent-suggestions"
            ?disabled=${props.form.clearAgent}
            placeholder=${t("cron.form.agentPlaceholder")}
            @input=${(e: Event) =>
              props.onFormChange({ agentId: (e.target as HTMLInputElement).value })}
          />
        `,
      })}
      ${renderFieldRow({
        label: t("cron.form.runsIn"),
        controlId: "cron-session-target",
        help: t("cron.form.sessionHelp"),
        control: html`
          <select
            id="cron-session-target"
            class="settings-select"
            .value=${sessionTarget}
            @change=${(e: Event) =>
              props.onFormChange({
                sessionTarget: (e.target as HTMLSelectElement)
                  .value as CronFormState["sessionTarget"],
              })}
          >
            <option value="main">${t("cron.form.mainSession")}</option>
            <option value="isolated">${t("cron.form.isolatedSession")}</option>
            ${knownSessionTarget
              ? nothing
              : html`<option value=${sessionTarget}>${sessionTarget}</option>`}
          </select>
        `,
      })}
    `,
  );
}

// Human-readable schedule summary; null while invalid so it never disagrees with the saved value.
function describeFormSchedule(form: CronFormState): string | null {
  if (form.scheduleKind === "every") {
    const amount = form.everyAmount.trim();
    if (parseCronEveryMs(amount, form.everyUnit) === undefined) {
      return null;
    }
    if (Number(amount) === 1) {
      const singularKey =
        form.everyUnit === "seconds"
          ? "cron.form.summaryEverySecondOne"
          : form.everyUnit === "minutes"
            ? "cron.form.summaryEveryMinuteOne"
            : form.everyUnit === "hours"
              ? "cron.form.summaryEveryHourOne"
              : "cron.form.summaryEveryDayOne";
      return t(singularKey);
    }
    const key =
      form.everyUnit === "seconds"
        ? "cron.form.summaryEverySeconds"
        : form.everyUnit === "minutes"
          ? "cron.form.summaryEveryMinutes"
          : form.everyUnit === "hours"
            ? "cron.form.summaryEveryHours"
            : "cron.form.summaryEveryDays";
    return t(key, { amount });
  }
  if (form.scheduleKind === "at") {
    const ms = Date.parse(form.scheduleAt);
    return Number.isFinite(ms) ? t("cron.form.summaryOnce", { at: formatMs(ms) }) : null;
  }
  if (form.scheduleKind === "cron") {
    const expr = form.cronExpr.trim();
    if (!expr) {
      return null;
    }
    const tz = form.cronTz.trim();
    return tz ? t("cron.form.summaryCronTz", { expr, tz }) : t("cron.form.summaryCron", { expr });
  }
  return form.scheduleKind === "on-exit" ? t("cron.form.repeatOnExit") : null;
}

function renderScheduleSection(props: CronProps) {
  const form = props.form;
  const isOnExit = form.scheduleKind === "on-exit";
  // on-exit stays selectable only while it is the current value: jobs can
  // convert to an editable schedule, but never back to a watched command.
  const kinds: Array<{ value: CronFormState["scheduleKind"]; label: string; testId: string }> = [
    ...(isOnExit
      ? [
          {
            value: "on-exit" as const,
            label: t("cron.form.repeatOnExit"),
            testId: "cron-schedule-kind-on-exit",
          },
        ]
      : []),
    { value: "every", label: t("cron.form.repeatInterval"), testId: "cron-schedule-kind-every" },
    { value: "at", label: t("cron.form.repeatOnce"), testId: "cron-schedule-kind-at" },
    { value: "cron", label: t("cron.form.cronOption"), testId: "cron-schedule-kind-cron" },
  ];
  const summary = describeFormSchedule(form);
  return renderSettingsSection(
    { title: t("cron.detail.scheduleSection") },
    html`
      ${renderSettingsRow({
        title: t("cron.form.repeat"),
        description: isOnExit ? t("cron.form.onExitHelp") : undefined,
        stacked: true,
        control: renderSegmented<CronFormState["scheduleKind"]>({
          value: form.scheduleKind,
          options: kinds,
          ariaLabel: t("cron.form.repeat"),
          onChange: (value) => props.onFormChange({ scheduleKind: value }),
        }),
      })}
      ${form.scheduleKind === "at"
        ? renderFieldRow({
            label: t("cron.form.runAt"),
            controlId: "cron-schedule-at",
            required: true,
            error: props.fieldErrors.scheduleAt,
            errorId: errorIdForField("scheduleAt"),
            control: html`
              <input
                id="cron-schedule-at"
                class="settings-input"
                type="datetime-local"
                aria-required="true"
                .value=${form.scheduleAt}
                aria-invalid=${props.fieldErrors.scheduleAt ? "true" : "false"}
                aria-describedby=${ifDefined(
                  props.fieldErrors.scheduleAt ? errorIdForField("scheduleAt") : undefined,
                )}
                @input=${(e: Event) =>
                  props.onFormChange({ scheduleAt: (e.target as HTMLInputElement).value })}
              />
            `,
          })
        : nothing}
      ${form.scheduleKind === "every"
        ? renderFieldRow({
            label: t("cron.form.every"),
            controlId: "cron-every-amount",
            required: true,
            error: props.fieldErrors.everyAmount,
            errorId: errorIdForField("everyAmount"),
            control: html`
              <div class="cron-inline-controls">
                <input
                  id="cron-every-amount"
                  class="settings-input"
                  aria-required="true"
                  .value=${form.everyAmount}
                  aria-invalid=${props.fieldErrors.everyAmount ? "true" : "false"}
                  aria-describedby=${ifDefined(
                    props.fieldErrors.everyAmount ? errorIdForField("everyAmount") : undefined,
                  )}
                  placeholder=${t("cron.form.everyAmountPlaceholder")}
                  @input=${(e: Event) =>
                    props.onFormChange({ everyAmount: (e.target as HTMLInputElement).value })}
                />
                <select
                  class="settings-select"
                  .value=${form.everyUnit}
                  aria-label=${t("cron.form.unit")}
                  @change=${(e: Event) =>
                    props.onFormChange({
                      everyUnit: (e.target as HTMLSelectElement)
                        .value as CronFormState["everyUnit"],
                    })}
                >
                  <option value="seconds">${t("cron.form.seconds")}</option>
                  <option value="minutes">${t("cron.form.minutes")}</option>
                  <option value="hours">${t("cron.form.hours")}</option>
                  <option value="days">${t("cron.form.days")}</option>
                </select>
              </div>
            `,
          })
        : nothing}
      ${form.scheduleKind === "cron"
        ? html`
            ${renderFieldRow({
              label: t("cron.form.expression"),
              controlId: "cron-cron-expr",
              required: true,
              error: props.fieldErrors.cronExpr,
              errorId: errorIdForField("cronExpr"),
              control: html`
                <input
                  id="cron-cron-expr"
                  class="settings-input mono"
                  aria-required="true"
                  .value=${form.cronExpr}
                  aria-invalid=${props.fieldErrors.cronExpr ? "true" : "false"}
                  aria-describedby=${ifDefined(
                    props.fieldErrors.cronExpr ? errorIdForField("cronExpr") : undefined,
                  )}
                  placeholder=${t("cron.form.expressionPlaceholder")}
                  @input=${(e: Event) =>
                    props.onFormChange({ cronExpr: (e.target as HTMLInputElement).value })}
                />
              `,
            })}
            ${renderFieldRow({
              label: t("cron.form.timezoneOptional"),
              controlId: "cron-cron-tz",
              help: t("cron.form.timezoneHelp"),
              control: html`
                <input
                  id="cron-cron-tz"
                  class="settings-input"
                  .value=${form.cronTz}
                  list="cron-tz-suggestions"
                  placeholder=${t("cron.form.timezonePlaceholder")}
                  @input=${(e: Event) =>
                    props.onFormChange({ cronTz: (e.target as HTMLInputElement).value })}
                />
              `,
            })}
          `
        : nothing}
      ${summary
        ? html` <div class="cron-schedule-summary">${icon("clock")}<span>${summary}</span></div> `
        : nothing}
    `,
  );
}

function renderDeliverySection(
  props: CronProps,
  ctx: {
    supportsAnnounce: boolean;
    selectedDeliveryMode: CronFormState["deliveryMode"];
  },
) {
  const channelOptions = buildChannelOptions(props);
  return renderSettingsSection(
    { title: t("cron.detail.deliverySection") },
    html`
      ${renderFieldRow({
        label: t("cron.form.deliveryModeLabel"),
        controlId: "cron-delivery-mode",
        help: t("cron.form.deliveryHelp"),
        control: html`
          <select
            id="cron-delivery-mode"
            class="settings-select"
            .value=${ctx.selectedDeliveryMode}
            @change=${(e: Event) =>
              props.onFormChange({
                deliveryMode: (e.target as HTMLSelectElement)
                  .value as CronFormState["deliveryMode"],
              })}
          >
            ${ctx.supportsAnnounce
              ? html`<option value="announce">${t("cron.form.announceDefault")}</option>`
              : nothing}
            <option value="webhook">${t("cron.form.webhookPost")}</option>
            <option value="none">${t("cron.form.noneInternal")}</option>
          </select>
        `,
      })}
      ${ctx.selectedDeliveryMode === "announce"
        ? html`
            ${renderFieldRow({
              label: t("cron.form.channel"),
              controlId: "cron-delivery-channel",
              help: t("cron.form.channelHelp"),
              control: html`
                <select
                  id="cron-delivery-channel"
                  class="settings-select"
                  .value=${props.form.deliveryChannel || "last"}
                  @change=${(e: Event) =>
                    props.onFormChange({ deliveryChannel: (e.target as HTMLSelectElement).value })}
                >
                  ${channelOptions.map(
                    (channel) =>
                      html`<option value=${channel}>
                        ${resolveChannelLabel(props, channel)}
                      </option>`,
                  )}
                </select>
              `,
            })}
            ${renderFieldRow({
              label: t("cron.form.to"),
              controlId: "cron-delivery-to",
              help: t("cron.form.toHelp"),
              control: html`
                <input
                  id="cron-delivery-to"
                  class="settings-input"
                  .value=${props.form.deliveryTo}
                  list="cron-delivery-to-suggestions"
                  placeholder=${t("cron.form.toPlaceholder")}
                  @input=${(e: Event) =>
                    props.onFormChange({ deliveryTo: (e.target as HTMLInputElement).value })}
                />
              `,
            })}
          `
        : nothing}
      ${ctx.selectedDeliveryMode === "webhook"
        ? renderFieldRow({
            label: t("cron.form.webhookUrl"),
            controlId: "cron-delivery-to",
            required: true,
            help: t("cron.form.webhookHelp"),
            error: props.fieldErrors.deliveryTo,
            errorId: errorIdForField("deliveryTo"),
            control: html`
              <input
                id="cron-delivery-to"
                class="settings-input"
                aria-required="true"
                .value=${props.form.deliveryTo}
                list="cron-delivery-to-suggestions"
                aria-invalid=${props.fieldErrors.deliveryTo ? "true" : "false"}
                aria-describedby=${ifDefined(
                  props.fieldErrors.deliveryTo ? errorIdForField("deliveryTo") : undefined,
                )}
                placeholder=${t("cron.form.webhookPlaceholder")}
                @input=${(e: Event) =>
                  props.onFormChange({ deliveryTo: (e.target as HTMLInputElement).value })}
              />
            `,
          })
        : nothing}
    `,
  );
}

function renderAdvanced(
  props: CronProps,
  ctx: {
    mode: CronPanelMode;
    isAgentTurn: boolean;
    selectedDeliveryMode: CronFormState["deliveryMode"];
  },
) {
  const isCronSchedule = props.form.scheduleKind === "cron";
  const channelOptions = buildChannelOptions(props);
  // Collapsible section: the summary stands in for the section heading, the
  // body keeps the one-group-of-rows settings shape.
  return html`
    <section class="settings-section">
      <details class="cron-advanced">
        <summary class="settings-section__heading cron-advanced__summary">
          ${t("cron.form.advanced")}
        </summary>
        <p class="settings-section__desc">${t("cron.form.advancedHelp")}</p>
        <div class="settings-group">
          ${renderFieldRow({
            label: t("cron.form.description"),
            controlId: "cron-description",
            control: html`
              <input
                id="cron-description"
                class="settings-input"
                .value=${props.form.description}
                placeholder=${t("cron.form.descriptionPlaceholder")}
                @input=${(e: Event) =>
                  props.onFormChange({ description: (e.target as HTMLInputElement).value })}
              />
            `,
          })}
          ${ctx.mode === "create"
            ? renderToggleRow({
                label: t("cron.form.startEnabled"),
                checked: props.form.enabled,
                onChange: (checked) => props.onFormChange({ enabled: checked }),
              })
            : nothing}
          ${renderFieldRow({
            label: t("cron.form.wakeMode"),
            controlId: "cron-wake-mode",
            help: t("cron.form.wakeModeHelp"),
            control: html`
              <select
                id="cron-wake-mode"
                class="settings-select"
                .value=${props.form.wakeMode}
                @change=${(e: Event) =>
                  props.onFormChange({
                    wakeMode: (e.target as HTMLSelectElement).value as CronFormState["wakeMode"],
                  })}
              >
                <option value="now">${t("cron.form.now")}</option>
                <option value="next-heartbeat">${t("cron.form.nextHeartbeat")}</option>
              </select>
            `,
          })}
          ${ctx.isAgentTurn
            ? renderFieldRow({
                label: t("cron.form.timeoutSeconds"),
                controlId: "cron-timeout-seconds",
                help: t("cron.form.timeoutHelp"),
                error: props.fieldErrors.timeoutSeconds,
                errorId: errorIdForField("timeoutSeconds"),
                control: html`
                  <input
                    id="cron-timeout-seconds"
                    class="settings-input"
                    .value=${props.form.timeoutSeconds}
                    placeholder=${t("cron.form.timeoutPlaceholder")}
                    aria-invalid=${props.fieldErrors.timeoutSeconds ? "true" : "false"}
                    aria-describedby=${ifDefined(
                      props.fieldErrors.timeoutSeconds
                        ? errorIdForField("timeoutSeconds")
                        : undefined,
                    )}
                    @input=${(e: Event) =>
                      props.onFormChange({ timeoutSeconds: (e.target as HTMLInputElement).value })}
                  />
                `,
              })
            : nothing}
          ${renderToggleRow({
            label: t("cron.form.deleteAfterRun"),
            checked: props.form.deleteAfterRun,
            help: t("cron.form.deleteAfterRunHelp"),
            onChange: (checked) => props.onFormChange({ deleteAfterRun: checked }),
          })}
          ${renderToggleRow({
            label: t("cron.form.clearAgentOverride"),
            checked: props.form.clearAgent,
            help: t("cron.form.clearAgentHelp"),
            onChange: (checked) => props.onFormChange({ clearAgent: checked }),
          })}
          ${renderFieldRow({
            label: t("cron.form.sessionKey"),
            controlId: "cron-session-key",
            help: t("cron.form.sessionKeyHelp"),
            control: html`
              <input
                id="cron-session-key"
                class="settings-input"
                .value=${props.form.sessionKey}
                placeholder="agent:main:main"
                @input=${(e: Event) =>
                  props.onFormChange({ sessionKey: (e.target as HTMLInputElement).value })}
              />
            `,
          })}
          ${isCronSchedule
            ? html`
                ${renderToggleRow({
                  label: t("cron.form.exactTiming"),
                  checked: props.form.scheduleExact,
                  help: t("cron.form.exactTimingHelp"),
                  onChange: (checked) => props.onFormChange({ scheduleExact: checked }),
                })}
                ${renderFieldRow({
                  label: t("cron.form.staggerWindow"),
                  controlId: "cron-stagger-amount",
                  error: props.fieldErrors.staggerAmount,
                  errorId: errorIdForField("staggerAmount"),
                  control: html`
                    <div class="cron-inline-controls">
                      <input
                        id="cron-stagger-amount"
                        class="settings-input"
                        .value=${props.form.staggerAmount}
                        ?disabled=${props.form.scheduleExact}
                        aria-invalid=${props.fieldErrors.staggerAmount ? "true" : "false"}
                        aria-describedby=${ifDefined(
                          props.fieldErrors.staggerAmount
                            ? errorIdForField("staggerAmount")
                            : undefined,
                        )}
                        placeholder=${t("cron.form.staggerPlaceholder")}
                        @input=${(e: Event) =>
                          props.onFormChange({
                            staggerAmount: (e.target as HTMLInputElement).value,
                          })}
                      />
                      <select
                        class="settings-select"
                        .value=${props.form.staggerUnit}
                        ?disabled=${props.form.scheduleExact}
                        aria-label=${t("cron.form.staggerUnit")}
                        @change=${(e: Event) =>
                          props.onFormChange({
                            staggerUnit: (e.target as HTMLSelectElement)
                              .value as CronFormState["staggerUnit"],
                          })}
                      >
                        <option value="seconds">${t("cron.form.seconds")}</option>
                        <option value="minutes">${t("cron.form.minutes")}</option>
                      </select>
                    </div>
                  `,
                })}
              `
            : nothing}
          ${ctx.isAgentTurn
            ? html`
                ${renderFieldRow({
                  label: t("cron.form.accountId"),
                  controlId: "cron-delivery-account-id",
                  help: t("cron.form.accountIdHelp"),
                  control: html`
                    <input
                      id="cron-delivery-account-id"
                      class="settings-input"
                      .value=${props.form.deliveryAccountId}
                      list="cron-delivery-account-suggestions"
                      ?disabled=${ctx.selectedDeliveryMode !== "announce"}
                      placeholder="default"
                      @input=${(e: Event) =>
                        props.onFormChange({
                          deliveryAccountId: (e.target as HTMLInputElement).value,
                        })}
                    />
                  `,
                })}
                ${renderToggleRow({
                  label: t("cron.form.lightContext"),
                  checked: props.form.payloadLightContext,
                  help: t("cron.form.lightContextHelp"),
                  onChange: (checked) => props.onFormChange({ payloadLightContext: checked }),
                })}
                ${renderFailureAlertRows(props, channelOptions)}
              `
            : nothing}
          ${ctx.selectedDeliveryMode !== "none"
            ? renderToggleRow({
                label: t("cron.form.bestEffortDelivery"),
                checked: props.form.deliveryBestEffort,
                help: t("cron.form.bestEffortHelp"),
                onChange: (checked) => props.onFormChange({ deliveryBestEffort: checked }),
              })
            : nothing}
        </div>
      </details>
    </section>
  `;
}

function renderFailureAlertRows(props: CronProps, channelOptions: string[]) {
  return html`
    ${renderFieldRow({
      label: t("cron.form.failureAlerts"),
      controlId: "cron-failure-alert-mode",
      help: t("cron.form.failureAlertsHelp"),
      control: html`
        <select
          id="cron-failure-alert-mode"
          class="settings-select"
          .value=${props.form.failureAlertMode}
          @change=${(e: Event) =>
            props.onFormChange({
              failureAlertMode: (e.target as HTMLSelectElement)
                .value as CronFormState["failureAlertMode"],
            })}
        >
          <option value="inherit">${t("cron.form.failureAlertInherit")}</option>
          <option value="disabled">${t("cron.form.failureAlertDisabled")}</option>
          <option value="custom">${t("cron.form.failureAlertCustom")}</option>
        </select>
      `,
    })}
    ${props.form.failureAlertMode === "custom"
      ? html`
          ${renderFieldRow({
            label: t("cron.form.failureAlertAfter"),
            controlId: "cron-failure-alert-after",
            help: t("cron.form.failureAlertAfterHelp"),
            error: props.fieldErrors.failureAlertAfter,
            errorId: errorIdForField("failureAlertAfter"),
            control: html`
              <input
                id="cron-failure-alert-after"
                class="settings-input"
                .value=${props.form.failureAlertAfter}
                aria-invalid=${props.fieldErrors.failureAlertAfter ? "true" : "false"}
                aria-describedby=${ifDefined(
                  props.fieldErrors.failureAlertAfter
                    ? errorIdForField("failureAlertAfter")
                    : undefined,
                )}
                placeholder="2"
                @input=${(e: Event) =>
                  props.onFormChange({ failureAlertAfter: (e.target as HTMLInputElement).value })}
              />
            `,
          })}
          ${renderFieldRow({
            label: t("cron.form.failureAlertCooldown"),
            controlId: "cron-failure-alert-cooldown-seconds",
            help: t("cron.form.failureAlertCooldownHelp"),
            error: props.fieldErrors.failureAlertCooldownSeconds,
            errorId: errorIdForField("failureAlertCooldownSeconds"),
            control: html`
              <input
                id="cron-failure-alert-cooldown-seconds"
                class="settings-input"
                .value=${props.form.failureAlertCooldownSeconds}
                aria-invalid=${props.fieldErrors.failureAlertCooldownSeconds ? "true" : "false"}
                aria-describedby=${ifDefined(
                  props.fieldErrors.failureAlertCooldownSeconds
                    ? errorIdForField("failureAlertCooldownSeconds")
                    : undefined,
                )}
                placeholder="3600"
                @input=${(e: Event) =>
                  props.onFormChange({
                    failureAlertCooldownSeconds: (e.target as HTMLInputElement).value,
                  })}
              />
            `,
          })}
          ${renderFieldRow({
            label: t("cron.form.failureAlertChannel"),
            controlId: "cron-failure-alert-channel",
            control: html`
              <select
                id="cron-failure-alert-channel"
                class="settings-select"
                .value=${props.form.failureAlertChannel || "last"}
                @change=${(e: Event) =>
                  props.onFormChange({
                    failureAlertChannel: (e.target as HTMLSelectElement).value,
                  })}
              >
                ${channelOptions.map(
                  (channel) =>
                    html`<option value=${channel}>${resolveChannelLabel(props, channel)}</option>`,
                )}
              </select>
            `,
          })}
          ${renderFieldRow({
            label: t("cron.form.failureAlertTo"),
            controlId: "cron-failure-alert-to",
            help: t("cron.form.failureAlertToHelp"),
            control: html`
              <input
                id="cron-failure-alert-to"
                class="settings-input"
                .value=${props.form.failureAlertTo}
                list="cron-delivery-to-suggestions"
                placeholder=${t("cron.form.failureAlertToPlaceholder")}
                @input=${(e: Event) =>
                  props.onFormChange({ failureAlertTo: (e.target as HTMLInputElement).value })}
              />
            `,
          })}
          ${renderFieldRow({
            label: t("cron.form.failureAlertMode"),
            controlId: "cron-failure-alert-delivery-mode",
            control: html`
              <select
                id="cron-failure-alert-delivery-mode"
                class="settings-select"
                .value=${props.form.failureAlertDeliveryMode || "announce"}
                @change=${(e: Event) =>
                  props.onFormChange({
                    failureAlertDeliveryMode: (e.target as HTMLSelectElement)
                      .value as CronFormState["failureAlertDeliveryMode"],
                  })}
              >
                <option value="announce">${t("cron.form.failureAlertAnnounce")}</option>
                <option value="webhook">${t("cron.form.failureAlertWebhook")}</option>
              </select>
            `,
          })}
          ${renderFieldRow({
            label: t("cron.form.failureAlertAccountId"),
            controlId: "cron-failure-alert-account-id",
            control: html`
              <input
                id="cron-failure-alert-account-id"
                class="settings-input"
                .value=${props.form.failureAlertAccountId}
                placeholder=${t("cron.form.failureAlertAccountPlaceholder")}
                @input=${(e: Event) =>
                  props.onFormChange({
                    failureAlertAccountId: (e.target as HTMLInputElement).value,
                  })}
              />
            `,
          })}
        `
      : nothing}
  `;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
