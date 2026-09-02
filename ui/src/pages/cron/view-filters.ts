import { html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import type {
  CronJobsScheduleKindFilter,
  CronJobsSortBy,
  CronJobsTriggerFilter,
  CronSortDir,
} from "../../api/types.ts";
import { icon } from "../../components/icons.ts";
import type { PickerOption } from "../../components/select-picker.ts";
import { t } from "../../i18n/index.ts";
import type { CronJobsLastStatusFilter } from "../../lib/cron/index.ts";

type CronSelectOption = PickerOption;

type CronJobsFilterProps = {
  jobsScheduleKindFilter: CronJobsScheduleKindFilter;
  jobsLastStatusFilter: CronJobsLastStatusFilter;
  jobsTriggerFilter: CronJobsTriggerFilter;
  jobsGroupFilter: string;
  jobsTagFilter: string;
  jobsGroupBy: "none" | "group" | "type";
  jobsSortBy: CronJobsSortBy;
  jobsSortDir: CronSortDir;
  onJobsFiltersChange: (patch: {
    cronJobsScheduleKindFilter?: CronJobsScheduleKindFilter;
    cronJobsLastStatusFilter?: CronJobsLastStatusFilter;
    cronJobsTriggerFilter?: CronJobsTriggerFilter;
    cronJobsGroupFilter?: string;
    cronJobsTagFilter?: string;
    cronJobsGroupBy?: "none" | "group" | "type";
    cronJobsSortBy?: CronJobsSortBy;
    cronJobsSortDir?: CronSortDir;
  }) => void | Promise<void>;
  onJobsFiltersReset: () => void | Promise<void>;
};

const SCHEDULE_KIND_FILTER_LABELS: Record<CronJobsScheduleKindFilter, string> = {
  all: "cron.jobs.all",
  at: "cron.form.at",
  every: "cron.form.every",
  cron: "cron.form.cronOption",
  "on-exit": "cron.form.repeatOnExit",
  stream: "cron.form.repeatStream",
};

function renderJobsFilter(
  props: CronJobsFilterProps,
  field: keyof Parameters<CronJobsFilterProps["onJobsFiltersChange"]>[0],
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
          void props.onJobsFiltersChange({
            [field]: (event.currentTarget as HTMLSelectElement).value,
          })}
      >
        ${params.options.map(
          ({ value, label }) =>
            html`<option value=${value} ?selected=${value === params.value}>${label}</option>`,
        )}
      </select>
    </label>
  `;
}

export function renderJobsFilterPopover(props: CronJobsFilterProps, active: boolean) {
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
          options: Object.entries(SCHEDULE_KIND_FILTER_LABELS).map(([value, labelKey]) => ({
            value,
            label: t(labelKey),
          })),
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
        <label class="field">
          <span>${t("cron.jobs.group")}</span>
          <input
            class="settings-input"
            data-test-id="cron-jobs-group-filter"
            .value=${props.jobsGroupFilter}
            placeholder=${t("cron.jobs.groupPlaceholder")}
            @input=${(event: Event) => {
              const target = event.currentTarget;
              if (target instanceof HTMLInputElement) {
                void props.onJobsFiltersChange({ cronJobsGroupFilter: target.value });
              }
            }}
          />
        </label>
        <label class="field">
          <span>${t("cron.jobs.tag")}</span>
          <input
            class="settings-input"
            data-test-id="cron-jobs-tag-filter"
            .value=${props.jobsTagFilter}
            placeholder=${t("cron.jobs.tagPlaceholder")}
            @input=${(event: Event) => {
              const target = event.currentTarget;
              if (target instanceof HTMLInputElement) {
                void props.onJobsFiltersChange({ cronJobsTagFilter: target.value });
              }
            }}
          />
        </label>
        ${renderJobsFilter(props, "cronJobsGroupBy", {
          label: t("cron.jobs.groupBy"),
          value: props.jobsGroupBy,
          testId: "cron-jobs-group-by",
          options: [
            { value: "none", label: t("cron.jobs.groupByNone") },
            { value: "group", label: t("cron.jobs.groupByGroup") },
            { value: "type", label: t("cron.jobs.groupByType") },
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
          @click=${() => void props.onJobsFiltersReset()}
        >
          ${t("cron.jobs.reset")}
        </button>
      </div>
    </wa-popover>
  `;
}
