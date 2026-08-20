import {
  normalizeStringEntries,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
// Control UI view renders the Automations (cron) screen: a full-width list (stats, task table,
// starter ideas) and a full-page detail view for creating or editing a single automation.
import { html, nothing } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import "../../styles/chat/text.css";
import "../../styles/cron.css";
import type {
  ChannelUiMetaEntry,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  CronDeliveryStatus,
  CronJobsEnabledFilter,
  CronJobsTriggerFilter,
  CronRunsStatusValue,
  CronJobsSortBy,
  CronSortDir,
} from "../../api/types.ts";
import { renderChannelPicker, type ChannelPickerOption } from "../../components/channel-picker.ts";
import { renderCronJobsPagination } from "../../components/cron-jobs-pagination.ts";
import { icon, icons } from "../../components/icons.ts";
import { highlightCodeHtml } from "../../components/markdown-code-blocks.ts";
import { renderModelPicker } from "../../components/model-picker.ts";
import { providerIdFromModelRef } from "../../components/provider-icon.ts";
import { renderPicker, type PickerOption } from "../../components/select-picker.ts";
import "../../components/tooltip.ts";
import "../../components/web-awesome.ts";
import "../../components/web-awesome-popover.ts";
import {
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsToggle,
  renderSettingsToggleRow,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import {
  isCronJobActiveFailure,
  isCronJobRunning,
  resolveCronJobLastRunStatus,
} from "../../lib/cron-status.ts";
import { parseCronEveryMs } from "../../lib/cron/decimal.ts";
import type {
  CronFieldErrors,
  CronFieldKey,
  CronFormState,
  CronJobsLastStatusFilter,
  CronJobsScheduleKindFilter,
} from "../../lib/cron/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatRelativeTimestamp, formatMs } from "../../lib/format.ts";
import { formatCronSchedule } from "../../lib/presenter.ts";
import { renderSegmented } from "./segmented-control.ts";
import { renderCronStats } from "./stats.ts";
import { CRON_SUGGESTIONS, suggestionFormPatch } from "./suggestions.ts";
import { renderRunsSection, runStatusLabel } from "./view-runs.ts";

type CronPanelMode = "overview" | "create" | "job";

export type CronListTab = "tasks" | "activity";
export type CronDetailTab = "settings" | "history";

type CronProps = {
  basePath: string;
  agentId: string;
  loading: boolean;
  /** Canonical gateway capability for every mutation-capable cron control. */
  canManage: boolean;
  triggersEnabled: boolean;
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
  jobsTriggerFilter: CronJobsTriggerFilter;
  jobsSortBy: CronJobsSortBy;
  jobsSortDir: CronSortDir;
  error: string | null;
  busy: boolean;
  form: CronFormState;
  fieldErrors: CronFieldErrors;
  canSubmit: boolean;
  editingJob: CronJob | null;
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
    cronJobsTriggerFilter?: CronJobsTriggerFilter;
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

function buildChannelOptions(props: CronProps): ChannelPickerOption[] {
  return [
    { value: "last", label: "last", kind: "neutral" },
    ...uniqueStrings(props.channels.filter(Boolean)).map((value) => ({
      value,
      label:
        props.channelMeta?.find((entry) => entry.id === value)?.label ||
        props.channelLabels?.[value] ||
        value,
    })),
  ];
}

function renderSuggestionList(id: string, options: string[]) {
  const clean = uniqueStrings(normalizeStringEntries(options));
  return clean.length === 0
    ? nothing
    : html`<datalist id=${id}>
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

const CRON_FIELD_LABEL_KEYS: Record<CronFieldKey, string> = {
  name: "cron.form.fieldName",
  scheduleAt: "cron.form.runAt",
  everyAmount: "cron.form.every",
  cronExpr: "cron.form.expression",
  staggerAmount: "cron.form.staggerWindow",
  triggerScript: "cron.form.triggerScript",
  payloadText: "cron.form.assistantTaskPrompt",
  payloadModel: "cron.form.model",
  payloadThinking: "cron.form.thinking",
  timeoutSeconds: "cron.form.timeoutSeconds",
  deliveryTo: "cron.form.to",
  failureAlertAfter: "cron.form.failureAlertAfter",
  failureAlertCooldownSeconds: "cron.form.failureAlertCooldown",
};

function errorIdForField(key: CronFieldKey) {
  return `cron-error-${key}`;
}

function inputIdForField(key: string) {
  return `cron-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

function fieldLabelForKey(
  key: CronFieldKey,
  form: CronFormState,
  deliveryMode: CronFormState["deliveryMode"],
) {
  if (key === "payloadText" && form.payloadKind === "systemEvent") {
    return t("cron.form.mainTimelineMessage");
  }
  if (key === "deliveryTo" && deliveryMode === "webhook") {
    return t("cron.form.webhookUrl");
  }
  return t(CRON_FIELD_LABEL_KEYS[key]);
}

function collectBlockingFields(
  errors: CronFieldErrors,
  form: CronFormState,
  deliveryMode: CronFormState["deliveryMode"],
): BlockingField[] {
  return (Object.keys(CRON_FIELD_LABEL_KEYS) as CronFieldKey[]).flatMap((key) => {
    const message = errors[key];
    return message
      ? [
          {
            key,
            label: fieldLabelForKey(key, form, deliveryMode),
            message,
            inputId: inputIdForField(key),
          },
        ]
      : [];
  });
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
  // Blank when the control is not labelable (e.g. a code block); the label then
  // has no `for` target and the control carries its own aria-label.
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
      <label class="settings-row__text" for=${ifDefined(params.controlId || undefined)}>
        <span class="settings-row__title">
          ${params.required ? renderRequiredTitle(params.label) : params.label}
        </span>
        ${params.help ? html`<span class="settings-row__desc">${params.help}</span>` : nothing}
      </label>
      <div class="settings-row__control">${control}</div>
    </div>
  `;
}

type CronStringFormField = {
  [Field in keyof CronFormState]: CronFormState[Field] extends string ? Field : never;
}[keyof CronFormState];

type CronBooleanFormField = {
  [Field in keyof CronFormState]: CronFormState[Field] extends boolean ? Field : never;
}[keyof CronFormState];

type CronInputOptions = {
  label: string;
  help?: string;
  placeholder?: string;
  list?: string;
  type?: string;
  required?: boolean;
  disabled?: boolean;
  mono?: boolean;
  errorKey?: CronFieldKey;
  describeError?: boolean;
};

function renderCronInput(props: CronProps, field: CronStringFormField, options: CronInputOptions) {
  const error = options.errorKey ? props.fieldErrors[options.errorKey] : undefined;
  const describedBy =
    error && options.errorKey && options.describeError !== false
      ? errorIdForField(options.errorKey)
      : undefined;
  return html`
    <input
      id=${inputIdForField(field)}
      class=${options.mono ? "settings-input mono" : "settings-input"}
      type=${ifDefined(options.type)}
      aria-required=${ifDefined(options.required ? "true" : undefined)}
      .value=${props.form[field]}
      list=${ifDefined(options.list)}
      ?disabled=${options.disabled ?? false}
      aria-invalid=${ifDefined(options.errorKey ? (error ? "true" : "false") : undefined)}
      aria-describedby=${ifDefined(describedBy)}
      placeholder=${ifDefined(options.placeholder)}
      @input=${(event: Event) =>
        props.onFormChange({ [field]: (event.currentTarget as HTMLInputElement).value })}
    />
  `;
}

function renderCronInputField(
  props: CronProps,
  field: CronStringFormField,
  options: CronInputOptions,
) {
  const errorKey = options.errorKey;
  return renderFieldRow({
    label: options.label,
    controlId: inputIdForField(field),
    required: options.required,
    help: options.help,
    error: errorKey ? props.fieldErrors[errorKey] : undefined,
    errorId: errorKey ? errorIdForField(errorKey) : undefined,
    control: renderCronInput(props, field, options),
  });
}

type CronSelectOption = PickerOption;

type CronSelectOptions = {
  label: string;
  options: readonly CronSelectOption[];
  help?: string;
  value?: string;
  disabled?: boolean;
  standalone?: boolean;
  channel?: boolean;
};

function renderCronSelect(
  props: CronProps,
  field: CronStringFormField,
  options: CronSelectOptions,
) {
  const selected = options.value ?? props.form[field];
  const picker = options.channel ? renderChannelPicker : renderPicker;
  return picker({
    id: options.standalone ? undefined : inputIdForField(field),
    label: options.label,
    value: options.channel ? selected || "last" : selected,
    options: options.options,
    disabled: options.disabled,
    onChange: (value) => props.onFormChange({ [field]: value }),
  });
}

function renderCronSelectField(
  props: CronProps,
  field: CronStringFormField,
  options: CronSelectOptions,
) {
  return renderFieldRow({
    label: options.label,
    controlId: inputIdForField(field),
    help: options.help,
    control: renderCronSelect(props, field, options),
  });
}

function renderToggleRow(
  props: CronProps,
  field: CronBooleanFormField,
  params: { label: string; help?: string },
) {
  return renderSettingsToggleRow({
    title: params.label,
    description: params.help,
    checked: props.form[field],
    onChange: (checked) => props.onFormChange({ [field]: checked }),
  });
}

// ── Main render ──

export function renderCron(props: CronProps) {
  const mode: CronPanelMode = props.editingJob ? "job" : props.createOpen ? "create" : "overview";
  return html`
    ${mode === "overview" ? renderListView(props) : renderDetailView(props, mode)}
    ${renderSuggestionList("cron-agent-suggestions", props.agentSuggestions)}
    ${renderSuggestionList("cron-thinking-suggestions", props.thinkingSuggestions)}
    ${renderSuggestionList("cron-tz-suggestions", props.timezoneSuggestions)}
    ${renderSuggestionList("cron-delivery-to-suggestions", props.deliveryToSuggestions)}
    ${renderSuggestionList("cron-delivery-account-suggestions", props.accountSuggestions)}
  `;
}

function renderAdminRequired(props: CronProps) {
  return props.canManage
    ? nothing
    : html`<div class="callout warning" role="note">${t("cron.adminRequired")}</div>`;
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
    props.jobsTriggerFilter !== "all" ||
    props.jobsSortBy !== "nextRunAtMs" ||
    props.jobsSortDir !== "asc";
  const hasAnyJobsFilters =
    hasAdvancedJobsFilters ||
    props.jobsQuery.trim().length > 0 ||
    props.jobsEnabledFilter !== "all";
  const showStarterAutomations =
    !props.loading &&
    !props.error &&
    props.jobsTotal === 0 &&
    !hasAnyJobsFilters &&
    props.canManage;
  const children = [
    renderSettingsSection({}, renderCronStats(props)),
    renderAdminRequired(props),
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
              showStarterAutomations ? renderSuggestions(props) : nothing,
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
    tabs: { id: "cron-list", panelId: "cron-list-panel" },
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
        ${props.canManage
          ? html`
              <button
                type="button"
                class="btn primary btn--sm cron-new-task"
                data-test-id="cron-new-task"
                @click=${() => props.onOpenCreate()}
              >
                ${icon("plus")} ${t("cron.list.newTask")}
              </button>
            `
          : nothing}
      </div>
    </div>
  `;
}

function renderJobsFilter(
  props: CronProps,
  field: keyof Parameters<CronProps["onJobsFiltersChange"]>[0],
  params: {
    label: string;
    value: string;
    options: readonly CronSelectOption[];
    testId?: string;
  },
) {
  return html`
    <label class="field">
      <span>${params.label}</span>
      <select
        class="settings-select"
        data-test-id=${ifDefined(params.testId)}
        .value=${params.value}
        @change=${(event: Event) =>
          props.onJobsFiltersChange({ [field]: (event.currentTarget as HTMLSelectElement).value })}
      >
        ${params.options.map(
          // Same first-option fallback as renderCronSelect: mark the bound value.
          ({ value, label }) =>
            html`<option value=${value} ?selected=${value === params.value}>${label}</option>`,
        )}
      </select>
    </label>
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
        ${renderJobsFilter(props, "cronJobsScheduleKindFilter", {
          label: t("cron.jobs.schedule"),
          value: props.jobsScheduleKindFilter,
          testId: "cron-jobs-schedule-filter",
          options: [
            { value: "all", label: t("cron.jobs.all") },
            { value: "at", label: t("cron.form.at") },
            { value: "every", label: t("cron.form.every") },
            { value: "cron", label: t("cron.form.cronOption") },
          ],
        })}
        ${renderJobsFilter(props, "cronJobsLastStatusFilter", {
          label: t("cron.jobs.lastRun"),
          value: props.jobsLastStatusFilter,
          testId: "cron-jobs-last-status-filter",
          options: [
            { value: "all", label: t("cron.jobs.all") },
            { value: "ok", label: t("cron.runs.runStatusOk") },
            { value: "error", label: t("cron.runs.runStatusError") },
            { value: "skipped", label: t("cron.runs.runStatusSkipped") },
            { value: "unknown", label: t("cron.runs.runStatusUnknown") },
          ],
        })}
        ${renderJobsFilter(props, "cronJobsTriggerFilter", {
          label: t("cron.jobs.condition"),
          value: props.jobsTriggerFilter,
          testId: "cron-jobs-trigger-filter",
          options: [
            { value: "all", label: t("cron.jobs.all") },
            { value: "conditional", label: t("cron.jobs.conditional") },
            { value: "unconditional", label: t("cron.jobs.unconditional") },
          ],
        })}
        ${renderJobsFilter(props, "cronJobsSortBy", {
          label: t("cron.jobs.sort"),
          value: props.jobsSortBy,
          options: [
            { value: "nextRunAtMs", label: t("cron.jobs.nextRun") },
            { value: "updatedAtMs", label: t("cron.jobs.recentlyUpdated") },
            { value: "name", label: t("cron.jobs.name") },
          ],
        })}
        ${renderJobsFilter(props, "cronJobsSortDir", {
          label: t("cron.jobs.direction"),
          value: props.jobsSortDir,
          options: [
            { value: "asc", label: t("cron.jobs.ascending") },
            { value: "desc", label: t("cron.jobs.descending") },
          ],
        })}
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
      ${renderCronJobsPagination({
        jobsShown: props.jobs.length,
        jobsTotal: props.jobsTotal,
        hasMore: props.jobsHasMore,
        loading: props.loading,
        loadingMore: props.jobsLoadingMore,
        onLoadMore: props.onLoadMoreJobs,
      })}
    </div>
  `;
}

function renderJobRow(job: CronJob, props: CronProps) {
  const description = job.description?.trim();
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
        ${description
          ? html`
              <span
                class="cron-table__description"
                data-test-id=${`cron-row-description-${job.id}`}
                title=${`${t("cron.form.description")}: ${description}`}
                >· ${description}</span
              >
            `
          : nothing}
        ${job.trigger ? renderTriggerIndicator() : nothing}
        ${job.enabled ? nothing : renderDisabledNote(job)}
      </span>
      <span class="cron-table__cell">${formatCronSchedule(job)}</span>
      <span class="cron-table__cell">
        ${isCronJobRunning(job)
          ? html`<span class="cron-table__running">${t("cron.runs.runStatusRunning")}</span>`
          : hasNextRun
            ? formatRelativeTimestamp(nextRunAtMs)
            : t("common.na")}
      </span>
      <span class="cron-table__cell cron-table__last">${renderLastRunCell(job)}</span>
      <span
        class="cron-table__actions"
        @click=${(e: Event) => e.stopPropagation()}
        @keydown=${(e: Event) => e.stopPropagation()}
      >
        ${props.canManage
          ? html`
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
            `
          : nothing}
      </span>
    </div>
  `;
}

function renderTriggerIndicator() {
  const label = t("cron.form.triggerConfigured");
  return html`<span class="cron-trigger-icon" role="img" aria-label=${label} title=${label}
    >${icon("gitBranch")}</span
  >`;
}

/** Auto-disabled is the escalated failure state, not an operator pause: the
 * recorded fact (state.autoDisabled) must stay visible or the job silently
 * drops out of every failure surface the moment the problem became permanent. */
function renderDisabledNote(job: CronJob) {
  const autoDisabled = job.state?.autoDisabled;
  if (!autoDisabled) {
    return html`<span class="muted cron-table__paused-note">${t("cron.list.paused")}</span>`;
  }
  const label = t(
    autoDisabled.reason === "schedule-errors"
      ? "cron.list.autoDisabledScheduleErrors"
      : "cron.list.autoDisabledRunFailures",
    { count: String(autoDisabled.consecutiveErrors) },
  );
  const lastError = job.state?.lastError?.trim();
  return html`<span
    class="cron-table__paused-note cron-table__auto-disabled"
    data-test-id=${`cron-row-auto-disabled-${job.id}`}
    title=${lastError ? formatUiExternalText(lastError) : label}
    >${label}</span
  >`;
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
  if (!props.canManage) {
    return nothing;
  }
  return html`
    <wa-dropdown
      class="cron-job-menu"
      placement="bottom-end"
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
        if (!props.canManage) {
          return;
        }
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
  const selectedJob = mode === "job" ? (props.editingJob ?? undefined) : undefined;
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
    renderAdminRequired(props),
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
  const description = mode === "job" ? selectedJob?.description?.trim() : undefined;
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
        ${description
          ? html`<div class="cron-detail-description" data-test-id="cron-detail-description">
              <span class="cron-detail-description__label">${t("cron.form.description")}:</span>
              ${description}
            </div>`
          : nothing}
        <div class="cron-detail-meta">
          ${mode === "job" && selectedJob && props.canManage
            ? renderEnabledSwitch(props, selectedJob)
            : nothing}
          <span class="cron-detail-sub">${subtitle}</span>
          ${selectedJob?.trigger ? renderTriggerIndicator() : nothing}
        </div>
      </div>
      <div class="cron-detail-actions">
        ${mode === "job" && selectedJob && props.canManage
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
        disabled: props.busy || !props.canManage,
        ariaLabel: opts?.compact ? actionLabel : stateLabel,
        onChange: (checked) => {
          if (props.canManage) {
            props.onToggle(job, checked);
          }
        },
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
    tabs: { id: "cron-detail", panelId: "cron-detail-panel", variant: "sub" },
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
  const blockedByValidation = props.canManage && !props.busy && blockingFields.length > 0;
  const submitDisabledReason =
    blockedByValidation && !props.canSubmit
      ? blockingFields.length === 1
        ? t("cron.form.fixFields", { count: String(blockingFields.length) })
        : t("cron.form.fixFieldsPlural", { count: String(blockingFields.length) })
      : "";
  return html`
    <fieldset
      class="cron-editor"
      ?disabled=${props.busy || !props.canManage}
      aria-busy=${String(props.busy)}
    >
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
      ${props.canManage
        ? html`
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
                ? html`<div class="cron-submit-reason" aria-live="polite">
                    ${submitDisabledReason}
                  </div>`
                : nothing}
            </div>
          `
        : nothing}
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
      ?disabled=${props.busy || !props.canManage}
    >
      ${label}
    </wa-dropdown-item>
  `;
}

// ── Editor sections ──

// Only the read-only payload kinds carry source text; the rest are prose prompts,
// so an empty language keeps them on the plain editable textarea.
const CRON_PAYLOAD_CODE_LANGUAGES: Record<CronFormState["payloadKind"], string> = {
  script: "javascript",
  command: "bash",
  heartbeat: "",
  systemEvent: "",
  agentTurn: "",
};

function renderPromptSection(
  props: CronProps,
  ctx: { payloadLocked: boolean; isAgentTurn: boolean },
) {
  const lockedPayloadLabel =
    props.form.payloadKind === "script" ? t("cron.form.script") : t("cron.form.command");
  const promptLabel = ctx.payloadLocked
    ? lockedPayloadLabel
    : props.form.payloadKind === "systemEvent"
      ? t("cron.form.mainTimelineMessage")
      : t("cron.form.assistantTaskPrompt");
  const promptHelp = ctx.payloadLocked
    ? t("cron.form.readOnlyPayloadHelp")
    : props.form.payloadKind === "systemEvent"
      ? t("cron.form.systemEventHelp")
      : t("cron.form.agentTurnHelp");
  // Script/command payloads are always read-only here, so they render as a highlighted
  // code block instead of a textarea; every other kind stays an editable field. The code
  // block carries no aria-invalid/describedby because validateCronForm skips payloadText
  // for locked payloads, so this branch can never render a payload error.
  const codeLanguage = ctx.payloadLocked ? CRON_PAYLOAD_CODE_LANGUAGES[props.form.payloadKind] : "";
  const promptRow = renderFieldRow({
    label: promptLabel,
    controlId: codeLanguage ? "" : "cron-payload-text",
    required: true,
    help: promptHelp,
    stacked: true,
    wide: true,
    error: props.fieldErrors.payloadText,
    errorId: errorIdForField("payloadText"),
    control: codeLanguage
      ? html`
          <pre
            id="cron-payload-text"
            class="code-block cron-payload-code"
            data-test-id="cron-payload-code"
            tabindex="0"
            aria-label=${promptLabel}
          ><code class="hljs">${unsafeHTML(
            highlightCodeHtml(props.form.payloadText, codeLanguage),
          )}</code></pre>
        `
      : html`
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
  const actionLabel = t("cron.form.action");
  const actionRow = ctx.payloadLocked
    ? renderFieldRow({
        label: actionLabel,
        controlId: inputIdForField("payloadKind"),
        control: html`
          <input
            id=${inputIdForField("payloadKind")}
            class="settings-input"
            .value=${lockedPayloadLabel}
            readonly
          />
        `,
      })
    : renderCronSelectField(props, "payloadKind", {
        label: actionLabel,
        options: [
          { value: "systemEvent", label: t("cron.form.systemEvent") },
          { value: "agentTurn", label: t("cron.form.agentTurn") },
        ],
      });
  const modelLabel = t("cron.form.model");
  const modelError = props.fieldErrors.payloadModel;
  const modelOptions = uniqueStrings(props.modelSuggestions).map((value) => {
    const provider = providerIdFromModelRef(value);
    return { value, label: value, provider: provider ?? undefined };
  });
  const agentTurnRows = ctx.isAgentTurn
    ? html`
        ${renderFieldRow({
          label: modelLabel,
          controlId: "",
          help: t("cron.form.modelHelp"),
          error: modelError,
          errorId: errorIdForField("payloadModel"),
          control: renderModelPicker({
            id: "cron-payload-model-picker",
            label: modelLabel,
            value: props.form.payloadModel,
            options: [{ value: "", label: t("quickSettings.model.default") }, ...modelOptions],
            custom: {
              id: inputIdForField("payloadModel"),
              label: t("cron.form.customModel"),
              placeholder: t("cron.form.modelPlaceholder"),
              invalid: Boolean(modelError),
              describedBy: modelError ? errorIdForField("payloadModel") : undefined,
            },
            onChange: (payloadModel) => props.onFormChange({ payloadModel }),
          }),
        })}
        ${renderCronInputField(props, "payloadThinking", {
          label: t("cron.form.thinking"),
          help: t("cron.form.thinkingHelp"),
          errorKey: "payloadThinking",
          describeError: false,
          list: "cron-thinking-suggestions",
          placeholder: t("cron.form.thinkingPlaceholder"),
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
      ${renderCronInputField(props, "name", {
        label: t("cron.form.fieldName"),
        required: true,
        errorKey: "name",
        placeholder: t("cron.form.namePlaceholder"),
      })}
      ${renderCronInputField(props, "agentId", {
        label: t("cron.form.agentId"),
        help: t("cron.form.agentHelp"),
        list: "cron-agent-suggestions",
        disabled: props.form.clearAgent,
        placeholder: t("cron.form.agentPlaceholder"),
      })}
      ${renderCronSelectField(props, "sessionTarget", {
        label: t("cron.form.runsIn"),
        help: t("cron.form.sessionHelp"),
        options: [
          { value: "main", label: t("cron.form.mainSession") },
          { value: "isolated", label: t("cron.form.isolatedSession") },
          ...(knownSessionTarget ? [] : [{ value: sessionTarget, label: sessionTarget }]),
        ],
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
  if (form.scheduleKind === "on-exit") {
    return t("cron.form.repeatOnExit");
  }
  return form.scheduleKind === "stream" ? t("cron.form.repeatStream") : null;
}

function renderScheduleSection(props: CronProps) {
  const form = props.form;
  const isOnExit = form.scheduleKind === "on-exit";
  const isStream = form.scheduleKind === "stream";
  // Process-backed schedules stay selectable only while current: jobs can
  // convert to an editable schedule, but never synthesize a command in the UI.
  const processSchedule = isOnExit
    ? { value: "on-exit" as const, label: t("cron.form.repeatOnExit") }
    : isStream
      ? { value: "stream" as const, label: t("cron.form.repeatStream") }
      : null;
  const kinds: Array<{ value: CronFormState["scheduleKind"]; label: string; testId: string }> = [
    ...(processSchedule
      ? [{ ...processSchedule, testId: `cron-schedule-kind-${processSchedule.value}` }]
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
          onChange: (value) =>
            props.onFormChange({
              scheduleKind: value,
              ...(value === "at" && (form.scheduleKind === "every" || form.scheduleKind === "cron")
                ? { deleteAfterRun: true }
                : value === "every" || value === "cron"
                  ? { deleteAfterRun: false }
                  : {}),
            }),
        }),
      })}
      ${form.scheduleKind === "at"
        ? renderCronInputField(props, "scheduleAt", {
            label: t("cron.form.runAt"),
            required: true,
            errorKey: "scheduleAt",
            type: "datetime-local",
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
                ${renderCronInput(props, "everyAmount", {
                  label: t("cron.form.every"),
                  required: true,
                  errorKey: "everyAmount",
                  placeholder: t("cron.form.everyAmountPlaceholder"),
                })}
                ${renderCronSelect(props, "everyUnit", {
                  label: t("cron.form.unit"),
                  standalone: true,
                  options: [
                    { value: "seconds", label: t("cron.form.seconds") },
                    { value: "minutes", label: t("cron.form.minutes") },
                    { value: "hours", label: t("cron.form.hours") },
                    { value: "days", label: t("cron.form.days") },
                  ],
                })}
              </div>
            `,
          })
        : nothing}
      ${form.scheduleKind === "cron"
        ? html`
            ${renderCronInputField(props, "cronExpr", {
              label: t("cron.form.expression"),
              required: true,
              errorKey: "cronExpr",
              mono: true,
              placeholder: t("cron.form.expressionPlaceholder"),
            })}
            ${renderCronInputField(props, "cronTz", {
              label: t("cron.form.timezoneOptional"),
              help: t("cron.form.timezoneHelp"),
              list: "cron-tz-suggestions",
              placeholder: t("cron.form.timezonePlaceholder"),
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
      ${renderCronSelectField(props, "deliveryMode", {
        label: t("cron.form.deliveryModeLabel"),
        help: t("cron.form.deliveryHelp"),
        value: ctx.selectedDeliveryMode,
        options: [
          ...(ctx.supportsAnnounce
            ? [{ value: "announce", label: t("cron.form.announceDefault") }]
            : []),
          { value: "webhook", label: t("cron.form.webhookPost") },
          { value: "none", label: t("cron.form.noneInternal") },
        ],
      })}
      ${ctx.selectedDeliveryMode === "announce"
        ? html`
            ${renderCronSelectField(props, "deliveryChannel", {
              label: t("cron.form.channel"),
              help: t("cron.form.channelHelp"),
              value: props.form.deliveryChannel || "last",
              options: channelOptions,
              channel: true,
            })}
            ${renderCronInputField(props, "deliveryTo", {
              label: t("cron.form.to"),
              help: t("cron.form.toHelp"),
              list: "cron-delivery-to-suggestions",
              placeholder: t("cron.form.toPlaceholder"),
            })}
          `
        : nothing}
      ${ctx.selectedDeliveryMode === "webhook"
        ? renderCronInputField(props, "deliveryTo", {
            label: t("cron.form.webhookUrl"),
            required: true,
            help: t("cron.form.webhookHelp"),
            errorKey: "deliveryTo",
            list: "cron-delivery-to-suggestions",
            placeholder: t("cron.form.webhookPlaceholder"),
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
          ${props.form.triggerEnabled
            ? html`<span class="cron-trigger-summary">
                ${icon("gitBranch")} ${t("cron.form.triggerConfigured")}
              </span>`
            : nothing}
        </summary>
        <p class="settings-section__desc">${t("cron.form.advancedHelp")}</p>
        <div class="settings-group">
          ${renderTriggerRows(props)}
          ${renderCronInputField(props, "description", {
            label: t("cron.form.description"),
            placeholder: t("cron.form.descriptionPlaceholder"),
          })}
          ${ctx.mode === "create"
            ? renderToggleRow(props, "enabled", {
                label: t("cron.form.startEnabled"),
              })
            : nothing}
          ${renderCronSelectField(props, "wakeMode", {
            label: t("cron.form.wakeMode"),
            help: t("cron.form.wakeModeHelp"),
            options: [
              { value: "now", label: t("cron.form.now") },
              { value: "next-heartbeat", label: t("cron.form.nextHeartbeat") },
            ],
          })}
          ${ctx.isAgentTurn
            ? renderCronInputField(props, "timeoutSeconds", {
                label: t("cron.form.timeoutSeconds"),
                help: t("cron.form.timeoutHelp"),
                errorKey: "timeoutSeconds",
                placeholder: t("cron.form.timeoutPlaceholder"),
              })
            : nothing}
          ${props.form.scheduleKind === "at" || props.form.scheduleKind === "on-exit"
            ? renderToggleRow(props, "deleteAfterRun", {
                label: t("cron.form.deleteAfterRun"),
                help: t("cron.form.deleteAfterRunHelp"),
              })
            : nothing}
          ${renderToggleRow(props, "clearAgent", {
            label: t("cron.form.clearAgentOverride"),
            help: t("cron.form.clearAgentHelp"),
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
                ${renderToggleRow(props, "scheduleExact", {
                  label: t("cron.form.exactTiming"),
                  help: t("cron.form.exactTimingHelp"),
                })}
                ${renderFieldRow({
                  label: t("cron.form.staggerWindow"),
                  controlId: "cron-stagger-amount",
                  error: props.fieldErrors.staggerAmount,
                  errorId: errorIdForField("staggerAmount"),
                  control: html`
                    <div class="cron-inline-controls">
                      ${renderCronInput(props, "staggerAmount", {
                        label: t("cron.form.staggerWindow"),
                        disabled: props.form.scheduleExact,
                        errorKey: "staggerAmount",
                        placeholder: t("cron.form.staggerPlaceholder"),
                      })}
                      ${renderCronSelect(props, "staggerUnit", {
                        label: t("cron.form.staggerUnit"),
                        standalone: true,
                        disabled: props.form.scheduleExact,
                        options: [
                          { value: "seconds", label: t("cron.form.seconds") },
                          { value: "minutes", label: t("cron.form.minutes") },
                        ],
                      })}
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
                ${renderToggleRow(props, "payloadLightContext", {
                  label: t("cron.form.lightContext"),
                  help: t("cron.form.lightContextHelp"),
                })}
                ${renderFailureAlertRows(props, channelOptions)}
              `
            : nothing}
          ${ctx.selectedDeliveryMode !== "none"
            ? renderToggleRow(props, "deliveryBestEffort", {
                label: t("cron.form.bestEffortDelivery"),
                help: t("cron.form.bestEffortHelp"),
              })
            : nothing}
        </div>
      </details>
    </section>
  `;
}

function renderTriggerRows(props: CronProps) {
  if (!props.triggersEnabled) {
    return renderSettingsRow({
      title: t("cron.form.conditionTrigger"),
      description: props.form.triggerEnabled
        ? t("cron.form.triggerDisabledConfigured")
        : t("cron.form.triggerDisabled"),
      control: props.form.triggerEnabled
        ? html`<button
            type="button"
            class="btn btn--sm"
            @click=${() => props.onFormChange({ triggerEnabled: false })}
          >
            ${t("cron.form.clearTrigger")}
          </button>`
        : nothing,
    });
  }
  return html`
    ${renderToggleRow(props, "triggerEnabled", {
      label: t("cron.form.conditionTrigger"),
      help: t("cron.form.conditionTriggerHelp"),
    })}
    ${props.form.triggerEnabled
      ? html`
          ${renderFieldRow({
            label: t("cron.form.triggerScript"),
            controlId: "cron-trigger-script",
            required: true,
            help: t("cron.form.triggerScriptHelp"),
            error: props.fieldErrors.triggerScript,
            errorId: errorIdForField("triggerScript"),
            stacked: true,
            wide: true,
            control: html`<textarea
              id="cron-trigger-script"
              class="settings-input cron-trigger-script mono"
              rows="8"
              spellcheck="false"
              aria-invalid=${props.fieldErrors.triggerScript ? "true" : "false"}
              aria-describedby=${ifDefined(
                props.fieldErrors.triggerScript ? errorIdForField("triggerScript") : undefined,
              )}
              .value=${props.form.triggerScript}
              @input=${(event: Event) => {
                const target = event.currentTarget;
                if (target instanceof HTMLTextAreaElement) {
                  props.onFormChange({ triggerScript: target.value });
                }
              }}
            ></textarea>`,
          })}
          ${renderToggleRow(props, "triggerOnce", {
            label: t("cron.form.triggerOnce"),
            help: t("cron.form.triggerOnceHelp"),
          })}
        `
      : nothing}
  `;
}

function renderFailureAlertRows(props: CronProps, channelOptions: readonly ChannelPickerOption[]) {
  return html`
    ${renderCronSelectField(props, "failureAlertMode", {
      label: t("cron.form.failureAlerts"),
      help: t("cron.form.failureAlertsHelp"),
      options: [
        { value: "inherit", label: t("cron.form.failureAlertInherit") },
        { value: "disabled", label: t("cron.form.failureAlertDisabled") },
        { value: "custom", label: t("cron.form.failureAlertCustom") },
      ],
    })}
    ${props.form.failureAlertMode === "custom"
      ? html`
          ${renderCronInputField(props, "failureAlertAfter", {
            label: t("cron.form.failureAlertAfter"),
            help: t("cron.form.failureAlertAfterHelp"),
            errorKey: "failureAlertAfter",
            placeholder: "2",
          })}
          ${renderCronInputField(props, "failureAlertCooldownSeconds", {
            label: t("cron.form.failureAlertCooldown"),
            help: t("cron.form.failureAlertCooldownHelp"),
            errorKey: "failureAlertCooldownSeconds",
            placeholder: "3600",
          })}
          ${renderCronSelectField(props, "failureAlertChannel", {
            label: t("cron.form.failureAlertChannel"),
            value: props.form.failureAlertChannel || "last",
            options: channelOptions,
            channel: true,
          })}
          ${renderCronInputField(props, "failureAlertTo", {
            label: t("cron.form.failureAlertTo"),
            help: t("cron.form.failureAlertToHelp"),
            list: "cron-delivery-to-suggestions",
            placeholder: t("cron.form.failureAlertToPlaceholder"),
          })}
          ${renderCronSelectField(props, "failureAlertDeliveryMode", {
            label: t("cron.form.failureAlertMode"),
            value: props.form.failureAlertDeliveryMode || "announce",
            options: [
              { value: "announce", label: t("cron.form.failureAlertAnnounce") },
              { value: "webhook", label: t("cron.form.failureAlertWebhook") },
            ],
          })}
          ${renderCronInputField(props, "failureAlertAccountId", {
            label: t("cron.form.failureAlertAccountId"),
            placeholder: t("cron.form.failureAlertAccountPlaceholder"),
          })}
        `
      : nothing}
  `;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
