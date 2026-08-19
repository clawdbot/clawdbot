import { render } from "lit";
import type { CronJob } from "../../api/types.ts";
import { DEFAULT_CRON_FORM } from "../../test-helpers/cron.ts";
import { renderCron } from "./view.ts";

type CronProps = Parameters<typeof renderCron>[0];

export function createCronViewJob(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: "Daily ping",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "cron", expr: "0 9 * * *" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "ping" },
    ...overrides,
  } as CronJob;
}

function createCronViewProps(overrides: Partial<CronProps> = {}): CronProps {
  return {
    basePath: "",
    agentId: "main",
    loading: false,
    canManage: true,
    jobsLoadingMore: false,
    status: null,
    failingCount: null,
    agentScoped: false,
    scopedTotal: null,
    scopedNextWakeAtMs: null,
    jobs: [],
    jobsTotal: 0,
    jobsHasMore: false,
    jobsQuery: "",
    jobsEnabledFilter: "all",
    jobsScheduleKindFilter: "all",
    jobsLastStatusFilter: "all",
    jobsSortBy: "nextRunAtMs",
    jobsSortDir: "asc",
    error: null,
    busy: false,
    form: { ...DEFAULT_CRON_FORM },
    fieldErrors: {},
    canSubmit: true,
    editingJob: null,
    createOpen: false,
    listTab: "tasks",
    detailTab: "settings",
    channels: [],
    channelLabels: {},
    runs: [],
    runsTotal: 0,
    runsHasMore: false,
    runsLoadingMore: false,
    runsStatuses: [],
    runsDeliveryStatuses: [],
    runsQuery: "",
    runsSortDir: "desc",
    agentSuggestions: [],
    modelSuggestions: [],
    thinkingSuggestions: [],
    timezoneSuggestions: [],
    deliveryToSuggestions: [],
    accountSuggestions: [],
    onListTabChange: () => undefined,
    onDetailTabChange: () => undefined,
    onFormChange: () => undefined,
    onRefresh: () => undefined,
    onSubmit: () => undefined,
    onSubmitRunNow: () => undefined,
    onSelectJob: () => undefined,
    onOpenCreate: () => undefined,
    onClosePanel: () => undefined,
    onClone: () => undefined,
    onToggle: () => undefined,
    onRun: () => undefined,
    onRemove: () => undefined,
    onLoadMoreJobs: () => undefined,
    onJobsFiltersChange: () => undefined,
    onJobsFiltersReset: () => undefined,
    onLoadMoreRuns: () => undefined,
    onRunsFiltersChange: () => undefined,
    ...overrides,
  };
}

export function renderCronView(overrides: Partial<CronProps> = {}) {
  const container = document.createElement("div");
  render(renderCron(createCronViewProps(overrides)), container);
  return container;
}
