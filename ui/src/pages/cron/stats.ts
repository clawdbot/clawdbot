import { html } from "lit";
import type { CronJob, CronStatus } from "../../api/types.ts";
import { icon } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatNextRun } from "../../lib/presenter.ts";

export function renderCronStats(props: {
  status: CronStatus | null;
  failingCount: number | null;
  agentScoped: boolean;
  scopedTotal: number | null;
  scopedNextWakeAtMs: number | null;
  jobs: CronJob[];
  jobsTotal: number;
  onListTabChange: (tab: "activity") => void;
  onRunsFiltersChange: (patch: { cronRunsStatuses?: Array<"error"> }) => void | Promise<void>;
}) {
  // Scoped summaries use dedicated unfiltered queries; the visible jobs array
  // may hold only one filtered page and cannot represent global totals.
  const total = props.agentScoped
    ? (props.scopedTotal ?? t("common.na"))
    : (props.status?.jobs ?? Math.max(props.jobsTotal, props.jobs.length));
  const nextWakeAtMs =
    props.status?.enabled !== false
      ? props.agentScoped
        ? props.scopedNextWakeAtMs
        : (props.status?.nextWakeAtMs ?? null)
      : null;
  const failing = props.failingCount;
  return html`
    <div class="cron-stats">
      <div class="cron-stat">
        <span class="cron-stat__label">${t("cron.stats.tasks")}</span>
        <span class="cron-stat__value">${total}</span>
      </div>
      <button
        type="button"
        class="cron-stat cron-stat--action"
        data-test-id="cron-stat-failing"
        title=${t("cron.list.activityTab")}
        @click=${() => {
          // Drill into run history pre-filtered to errors.
          props.onListTabChange("activity");
          void props.onRunsFiltersChange({ cronRunsStatuses: ["error"] });
        }}
      >
        <span class="cron-stat__label">${t("cron.stats.failing")}</span>
        <span
          class="cron-stat__value ${typeof failing === "number" && failing > 0
            ? "cron-stat__value--danger"
            : ""}"
        >
          ${failing ?? t("common.na")}
        </span>
        <span class="cron-stat__go" aria-hidden="true">${icon("chevronRight")}</span>
      </button>
      <div class="cron-stat">
        <span class="cron-stat__label">${t("cron.stats.nextWake")}</span>
        <span class="cron-stat__value cron-stat__value--time">
          ${formatNextRun(nextWakeAtMs)}
        </span>
      </div>
    </div>
  `;
}
