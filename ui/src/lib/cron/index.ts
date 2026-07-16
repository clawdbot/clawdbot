import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  CronJob,
  CronDeliveryStatus,
  CronJobsEnabledFilter,
  CronJobsListResult,
  CronJobsSortBy,
  CronRunResult,
  CronRunStatus,
  CronRunScope,
  CronRunLogEntry,
  CronRunsResult,
  CronRunsStatusFilter,
  CronRunsStatusValue,
  CronSortDir,
  CronStatus,
  CronPayload,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { resolveCronJobLastRunStatus } from "../cron-status.ts";
import { toNumber } from "../format.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../gateway-errors.ts";
import { normalizeLowercaseStringOrEmpty, sortUniqueStrings } from "../string-coerce.ts";
import { loadCronFailingCount } from "./scope.ts";

export { loadCronFailingCount, loadCronScopeStats } from "./scope.ts";

const CRON_CHANNEL_LAST = "last";

export type CronFormState = {
  name: string;
  description: string;
  agentId: string;
  sessionKey: string;
  clearAgent: boolean;
  enabled: boolean;
  deleteAfterRun: boolean;
  // on-exit jobs are read-only because the form cannot edit a watched command.
  // Preserve their schedule verbatim on save instead of rebuilding it.
  scheduleKind: "at" | "every" | "cron" | "on-exit";
  scheduleAt: string;
  everyAmount: string;
  everyUnit: "minutes" | "hours" | "days";
  cronExpr: string;
  cronTz: string;
  scheduleExact: boolean;
  staggerAmount: string;
  staggerUnit: "seconds" | "minutes";
  sessionTarget: "main" | "isolated" | "current" | `session:${string}`;
  wakeMode: "next-heartbeat" | "now";
  payloadKind: "systemEvent" | "agentTurn";
  payloadLocked: boolean;
  payloadText: string;
  payloadModel: string;
  payloadThinking: string;
  payloadLightContext: boolean;
  deliveryMode: "none" | "announce" | "webhook";
  deliveryChannel: string;
  deliveryTo: string;
  deliveryAccountId: string;
  deliveryBestEffort: boolean;
  failureAlertMode: "inherit" | "disabled" | "custom";
  failureAlertAfter: string;
  failureAlertCooldownSeconds: string;
  failureAlertChannel: string;
  failureAlertTo: string;
  failureAlertDeliveryMode: "announce" | "webhook";
  failureAlertAccountId: string;
  timeoutSeconds: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function isCronPayload(value: unknown): value is CronPayload {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "systemEvent") {
    return typeof value.text === "string";
  }
  if (value.kind === "agentTurn") {
    return typeof value.message === "string";
  }
  if (value.kind === "command") {
    return Array.isArray(value.argv) && value.argv.every((arg) => typeof arg === "string");
  }
  return false;
}

export function getCronJobPayload(job: CronJob): CronPayload | null {
  const payload = (job as { payload?: unknown }).payload;
  return isCronPayload(payload) ? payload : null;
}

function hasCronJobPayload(job: CronJob): boolean {
  return getCronJobPayload(job) !== null;
}

const DEFAULT_CRON_FORM: CronFormState = {
  name: "",
  description: "",
  agentId: "",
  sessionKey: "",
  clearAgent: false,
  enabled: true,
  deleteAfterRun: true,
  scheduleKind: "every",
  scheduleAt: "",
  everyAmount: "30",
  everyUnit: "minutes",
  cronExpr: "0 7 * * *",
  cronTz: "",
  scheduleExact: false,
  staggerAmount: "",
  staggerUnit: "seconds",
  sessionTarget: "isolated",
  wakeMode: "now",
  payloadKind: "agentTurn",
  payloadLocked: false,
  payloadText: "",
  payloadModel: "",
  payloadThinking: "",
  payloadLightContext: false,
  deliveryMode: "announce",
  deliveryChannel: "last",
  deliveryTo: "",
  deliveryAccountId: "",
  deliveryBestEffort: false,
  failureAlertMode: "inherit",
  failureAlertAfter: "2",
  failureAlertCooldownSeconds: "3600",
  failureAlertChannel: "last",
  failureAlertTo: "",
  failureAlertDeliveryMode: "announce",
  failureAlertAccountId: "",
  timeoutSeconds: "",
};

export type CronFieldKey =
  | "name"
  | "scheduleAt"
  | "everyAmount"
  | "cronExpr"
  | "staggerAmount"
  | "payloadText"
  | "payloadModel"
  | "payloadThinking"
  | "timeoutSeconds"
  | "deliveryTo"
  | "failureAlertAfter"
  | "failureAlertCooldownSeconds";

export type CronFieldErrors = Partial<Record<CronFieldKey, string>>;

export type CronJobsScheduleKindFilter = "all" | "at" | "every" | "cron" | "on-exit";
export type CronJobsLastStatusFilter = "all" | CronRunStatus | "unknown";
type CronRunsLoadStatus = "ok" | "error" | "skipped";

export type CronState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  cronLoading: boolean;
  cronJobsLoadingMore: boolean;
  cronJobsReloadPending: boolean;
  cronJobsReloadPendingTableFilters: boolean;
  cronJobs: CronJob[];
  cronJobsTotal: number;
  cronJobsHasMore: boolean;
  cronJobsNextOffset: number | null;
  cronJobsLimit: number;
  cronJobsQuery: string;
  cronJobsEnabledFilter: CronJobsEnabledFilter;
  cronJobsScheduleKindFilter: CronJobsScheduleKindFilter;
  cronJobsLastStatusFilter: CronJobsLastStatusFilter;
  cronJobsSortBy: CronJobsSortBy;
  cronJobsSortDir: CronSortDir;
  cronAgentId: string | null;
  cronStatus: CronStatus | null;
  cronScopedTotal: number | null;
  cronScopedNextWakeAtMs: number | null;
  // Global enabled+error job count for the stats card; null until loaded.
  // Kept separate from cronJobs, which only holds the filtered/paged table.
  cronFailingCount: number | null;
  cronError: string | null;
  cronForm: CronFormState;
  // True while the create panel owns the detail pane; job selection (editing)
  // always wins over it when deriving the visible panel.
  cronCreateOpen: boolean;
  cronFieldErrors: CronFieldErrors;
  cronEditingJobId: string | null;
  cronRunsJobId: string | null;
  cronRunsLoadingMore: boolean;
  cronRuns: CronRunLogEntry[];
  cronRunsTotal: number;
  cronRunsHasMore: boolean;
  cronRunsNextOffset: number | null;
  cronRunsLimit: number;
  cronRunsScope: CronRunScope;
  cronRunsStatuses: CronRunsStatusValue[];
  cronRunsDeliveryStatuses: CronDeliveryStatus[];
  cronRunsStatusFilter: CronRunsStatusFilter;
  cronRunsQuery: string;
  cronRunsSortDir: CronSortDir;
  cronBusy: boolean;
};

export type CronModelSuggestionsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  cronModelSuggestions: string[];
};

export function createInitialCronState(
  snapshot: Partial<Pick<CronState, "client" | "connected">> = {},
): CronState {
  return {
    client: snapshot.client ?? null,
    connected: snapshot.connected ?? false,
    cronLoading: false,
    cronJobsLoadingMore: false,
    cronJobsReloadPending: false,
    cronJobsReloadPendingTableFilters: false,
    cronJobs: [],
    cronJobsTotal: 0,
    cronJobsHasMore: false,
    cronJobsNextOffset: null,
    cronJobsLimit: 50,
    cronJobsQuery: "",
    cronJobsEnabledFilter: "all",
    cronJobsScheduleKindFilter: "all",
    cronJobsLastStatusFilter: "all",
    cronJobsSortBy: "nextRunAtMs",
    cronJobsSortDir: "asc",
    cronAgentId: null,
    cronStatus: null,
    cronScopedTotal: null,
    cronScopedNextWakeAtMs: null,
    cronFailingCount: null,
    cronError: null,
    cronForm: { ...DEFAULT_CRON_FORM },
    cronCreateOpen: false,
    cronFieldErrors: {},
    cronEditingJobId: null,
    cronRunsJobId: null,
    cronRunsLoadingMore: false,
    cronRuns: [],
    cronRunsTotal: 0,
    cronRunsHasMore: false,
    cronRunsNextOffset: null,
    cronRunsLimit: 50,
    cronRunsScope: "all",
    cronRunsStatuses: [],
    cronRunsDeliveryStatuses: [],
    cronRunsStatusFilter: "all",
    cronRunsQuery: "",
    cronRunsSortDir: "desc",
    cronBusy: false,
  };
}

function supportsAnnounceDelivery(
  form: Pick<CronFormState, "sessionTarget" | "payloadKind" | "payloadLocked">,
) {
  return form.sessionTarget !== "main" && (form.payloadKind === "agentTurn" || form.payloadLocked);
}

export function normalizeCronFormState(form: CronFormState): CronFormState {
  if (form.deliveryMode !== "announce") {
    return form;
  }
  if (supportsAnnounceDelivery(form)) {
    return form;
  }
  return {
    ...form,
    deliveryMode: "none",
  };
}

export function validateCronForm(form: CronFormState): CronFieldErrors {
  const errors: CronFieldErrors = {};
  if (!form.name.trim()) {
    errors.name = "cron.errors.nameRequired";
  }
  if (form.scheduleKind === "at") {
    const ms = Date.parse(form.scheduleAt);
    if (!Number.isFinite(ms)) {
      errors.scheduleAt = "cron.errors.scheduleAtInvalid";
    }
  } else if (form.scheduleKind === "every") {
    const amount = toNumber(form.everyAmount, 0);
    if (amount <= 0) {
      errors.everyAmount = "cron.errors.everyAmountInvalid";
    }
  } else if (form.scheduleKind === "cron") {
    if (!form.cronExpr.trim()) {
      errors.cronExpr = "cron.errors.cronExprRequired";
    }
    if (!form.scheduleExact) {
      const staggerAmount = form.staggerAmount.trim();
      if (staggerAmount) {
        const stagger = toNumber(staggerAmount, 0);
        if (stagger <= 0) {
          errors.staggerAmount = "cron.errors.staggerAmountInvalid";
        }
      }
    }
  }
  if (!form.payloadLocked && !form.payloadText.trim()) {
    errors.payloadText =
      form.payloadKind === "systemEvent"
        ? "cron.errors.systemTextRequired"
        : "cron.errors.agentMessageRequired";
  }
  if (!form.payloadLocked && form.payloadKind === "agentTurn") {
    const timeoutRaw = form.timeoutSeconds.trim();
    if (timeoutRaw) {
      const timeout = toNumber(timeoutRaw, 0);
      if (timeout <= 0) {
        errors.timeoutSeconds = "cron.errors.timeoutInvalid";
      }
    }
  }
  if (form.deliveryMode === "webhook") {
    const target = form.deliveryTo.trim();
    if (!target) {
      errors.deliveryTo = "cron.errors.webhookUrlRequired";
    } else if (!/^https?:\/\//i.test(target)) {
      errors.deliveryTo = "cron.errors.webhookUrlInvalid";
    }
  }
  if (form.failureAlertMode === "custom") {
    const afterRaw = form.failureAlertAfter.trim();
    if (afterRaw) {
      const after = toNumber(afterRaw, 0);
      if (!Number.isFinite(after) || after <= 0) {
        errors.failureAlertAfter = "Failure alert threshold must be greater than 0.";
      }
    }
    const cooldownRaw = form.failureAlertCooldownSeconds.trim();
    if (cooldownRaw) {
      const cooldown = toNumber(cooldownRaw, -1);
      if (!Number.isFinite(cooldown) || cooldown < 0) {
        errors.failureAlertCooldownSeconds = "Cooldown must be 0 or greater.";
      }
    }
  }
  return errors;
}

export function hasCronFormErrors(errors: CronFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

export async function loadCronStatus(state: CronState) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const res = await state.client.request<CronStatus>("cron.status", {});
    state.cronStatus = res;
  } catch (err) {
    if (isMissingOperatorReadScopeError(err)) {
      state.cronStatus = null;
      state.cronError = formatMissingOperatorReadScopeMessage("cron status");
    } else {
      state.cronError = String(err);
    }
  }
}

export async function loadCronModelSuggestions(state: CronModelSuggestionsState) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const res = await state.client.request("models.list", { view: "configured" });
    const models = (res as { models?: unknown[] } | null)?.models;
    if (!Array.isArray(models)) {
      state.cronModelSuggestions = [];
      return;
    }
    const ids = models
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return "";
        }
        const id = (entry as { id?: unknown }).id;
        return typeof id === "string" ? id.trim() : "";
      })
      .filter(Boolean);
    state.cronModelSuggestions = sortUniqueStrings(ids);
  } catch {
    state.cronModelSuggestions = [];
  }
}

function addModelId(target: Set<string>, value: unknown) {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed) {
    target.add(trimmed);
  }
}

function addModelConfigIds(target: Set<string>, modelConfig: unknown) {
  if (!modelConfig) {
    return;
  }
  if (typeof modelConfig === "string") {
    addModelId(target, modelConfig);
    return;
  }
  if (typeof modelConfig !== "object") {
    return;
  }
  const record = modelConfig as Record<string, unknown>;
  addModelId(target, record.primary);
  addModelId(target, record.model);
  addModelId(target, record.id);
  addModelId(target, record.value);
  const fallbacks = Array.isArray(record.fallbacks)
    ? record.fallbacks
    : Array.isArray(record.fallback)
      ? record.fallback
      : [];
  for (const fallback of fallbacks) {
    addModelId(target, fallback);
  }
}

export function resolveConfiguredCronModelSuggestions(
  configForm: Record<string, unknown> | null | undefined,
): string[] {
  if (!configForm || typeof configForm !== "object") {
    return [];
  }
  const agents = configForm.agents;
  if (!agents || typeof agents !== "object") {
    return [];
  }
  const out = new Set<string>();
  const defaults = (agents as { defaults?: unknown }).defaults;
  if (defaults && typeof defaults === "object") {
    const defaultsRecord = defaults as Record<string, unknown>;
    addModelConfigIds(out, defaultsRecord.model);
    const defaultsModels = defaultsRecord.models;
    if (defaultsModels && typeof defaultsModels === "object") {
      for (const modelId of Object.keys(defaultsModels as Record<string, unknown>)) {
        addModelId(out, modelId);
      }
    }
  }
  const list = (agents as { list?: unknown }).list;
  if (list && typeof list === "object") {
    for (const entry of Object.values(list as Record<string, unknown>)) {
      if (entry && typeof entry === "object") {
        addModelConfigIds(out, (entry as Record<string, unknown>).model);
      }
    }
  }
  return sortUniqueStrings([...out]);
}

async function withCronBusy(
  state: CronState,
  run: (client: GatewayBrowserClient) => Promise<void>,
) {
  const client = state.client;
  if (!client || !state.connected || state.cronBusy) {
    return;
  }
  state.cronBusy = true;
  state.cronError = null;
  try {
    await run(client);
  } catch (err) {
    state.cronError = String(err);
  } finally {
    state.cronBusy = false;
  }
}

function normalizeCronPageMeta(params: {
  totalRaw: unknown;
  offsetRaw: unknown;
  nextOffsetRaw: unknown;
  hasMoreRaw: unknown;
  pageCount: number;
}) {
  const total =
    typeof params.totalRaw === "number" && Number.isFinite(params.totalRaw)
      ? Math.max(0, Math.floor(params.totalRaw))
      : params.pageCount;
  const offset =
    typeof params.offsetRaw === "number" && Number.isFinite(params.offsetRaw)
      ? Math.max(0, Math.floor(params.offsetRaw))
      : 0;
  const hasMore =
    typeof params.hasMoreRaw === "boolean"
      ? params.hasMoreRaw
      : offset + params.pageCount < Math.max(total, offset + params.pageCount);
  const nextOffset =
    typeof params.nextOffsetRaw === "number" && Number.isFinite(params.nextOffsetRaw)
      ? Math.max(0, Math.floor(params.nextOffsetRaw))
      : hasMore
        ? offset + params.pageCount
        : null;
  return { total, hasMore, nextOffset };
}

async function drainPendingCronJobsReload(state: CronState) {
  if (!state.cronJobsReloadPending) {
    return;
  }
  const tableFilters = state.cronJobsReloadPendingTableFilters;
  state.cronJobsReloadPending = false;
  state.cronJobsReloadPendingTableFilters = false;
  await loadCronJobsPage(state, { tableFilters });
}

export async function loadCronJobsPage(
  state: CronState,
  opts?: { append?: boolean; tableFilters?: boolean },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const append = opts?.append === true;
  if (state.cronLoading || state.cronJobsLoadingMore) {
    if (!append) {
      state.cronJobsReloadPending = true;
      state.cronJobsReloadPendingTableFilters = opts?.tableFilters === true;
    }
    return;
  }
  if (append && !state.cronJobsHasMore) {
    return;
  }
  if (append) {
    state.cronJobsLoadingMore = true;
  } else {
    state.cronLoading = true;
  }
  state.cronError = null;
  try {
    const offset = append ? Math.max(0, state.cronJobsNextOffset ?? state.cronJobs.length) : 0;
    const res = await state.client.request<CronJobsListResult>("cron.list", {
      ...(state.cronAgentId ? { agentId: state.cronAgentId } : {}),
      includeDisabled: state.cronJobsEnabledFilter === "all",
      limit: state.cronJobsLimit,
      offset,
      query: state.cronJobsQuery.trim() || undefined,
      enabled: state.cronJobsEnabledFilter,
      ...(opts?.tableFilters
        ? {
            scheduleKind: state.cronJobsScheduleKindFilter,
            lastRunStatus: state.cronJobsLastStatusFilter,
          }
        : {}),
      sortBy: state.cronJobsSortBy,
      sortDir: state.cronJobsSortDir,
    });
    const rawJobs = Array.isArray(res.jobs) ? res.jobs : [];
    const jobs = rawJobs.filter(hasCronJobPayload);
    state.cronJobs = append ? [...state.cronJobs, ...jobs] : jobs;
    const meta = normalizeCronPageMeta({
      totalRaw: res.total,
      offsetRaw: res.offset,
      nextOffsetRaw: res.nextOffset,
      hasMoreRaw: res.hasMore,
      pageCount: rawJobs.length,
    });
    state.cronJobsTotal = Math.max(meta.total, state.cronJobs.length);
    state.cronJobsHasMore = meta.hasMore;
    state.cronJobsNextOffset = meta.nextOffset;
    if (
      state.cronEditingJobId &&
      !state.cronJobs.some((job) => job.id === state.cronEditingJobId)
    ) {
      clearCronEditState(state);
    }
  } catch (err) {
    state.cronError = String(err);
  } finally {
    if (append) {
      state.cronJobsLoadingMore = false;
    } else {
      state.cronLoading = false;
    }
    await drainPendingCronJobsReload(state);
  }
}

export function updateCronJobsFilter(
  state: CronState,
  patch: Partial<
    Pick<
      CronState,
      | "cronJobsQuery"
      | "cronJobsEnabledFilter"
      | "cronJobsScheduleKindFilter"
      | "cronJobsLastStatusFilter"
      | "cronJobsSortBy"
      | "cronJobsSortDir"
    >
  >,
) {
  if (typeof patch.cronJobsQuery === "string") {
    state.cronJobsQuery = patch.cronJobsQuery;
  }
  state.cronJobsEnabledFilter = patch.cronJobsEnabledFilter ?? state.cronJobsEnabledFilter;
  state.cronJobsScheduleKindFilter =
    patch.cronJobsScheduleKindFilter ?? state.cronJobsScheduleKindFilter;
  state.cronJobsLastStatusFilter = patch.cronJobsLastStatusFilter ?? state.cronJobsLastStatusFilter;
  state.cronJobsSortBy = patch.cronJobsSortBy ?? state.cronJobsSortBy;
  state.cronJobsSortDir = patch.cronJobsSortDir ?? state.cronJobsSortDir;
}

export function getVisibleCronJobs(
  state: Pick<CronState, "cronJobs" | "cronJobsScheduleKindFilter" | "cronJobsLastStatusFilter">,
): CronJob[] {
  return state.cronJobs.filter((job) => {
    const scheduleKind = resolveCronJobScheduleKind(job);
    if (!scheduleKind) {
      return false;
    }
    if (
      state.cronJobsScheduleKindFilter !== "all" &&
      scheduleKind !== state.cronJobsScheduleKindFilter
    ) {
      return false;
    }
    if (
      state.cronJobsLastStatusFilter !== "all" &&
      resolveCronJobLastRunStatus(job) !== state.cronJobsLastStatusFilter
    ) {
      return false;
    }
    return true;
  });
}

function resolveCronJobScheduleKind(job: CronJob): string | null {
  const scheduleKind = (job.schedule as { kind?: unknown } | null | undefined)?.kind;
  if (
    scheduleKind === "at" ||
    scheduleKind === "every" ||
    scheduleKind === "cron" ||
    scheduleKind === "on-exit"
  ) {
    return scheduleKind;
  }
  return null;
}

function clearCronEditState(state: CronState) {
  state.cronEditingJobId = null;
}

function clearCronRunsPage(state: CronState) {
  state.cronRuns = [];
  state.cronRunsTotal = 0;
  state.cronRunsHasMore = false;
  state.cronRunsNextOffset = null;
}

function resetCronFormToDefaults(state: CronState) {
  state.cronForm = { ...DEFAULT_CRON_FORM };
  // A fresh form starts visually clean; validation re-arms on the first change
  // or submit so required-field errors do not greet the user immediately.
  state.cronFieldErrors = {};
}

function formatDateTimeLocal(input: string): string {
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) {
    return "";
  }
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function parseEverySchedule(everyMs: number): Pick<CronFormState, "everyAmount" | "everyUnit"> {
  if (everyMs % 86_400_000 === 0) {
    return { everyAmount: String(Math.max(1, everyMs / 86_400_000)), everyUnit: "days" };
  }
  if (everyMs % 3_600_000 === 0) {
    return { everyAmount: String(Math.max(1, everyMs / 3_600_000)), everyUnit: "hours" };
  }
  const minutes = Math.max(1, Math.ceil(everyMs / 60_000));
  return { everyAmount: String(minutes), everyUnit: "minutes" };
}

function parseStaggerSchedule(
  staggerMs?: number,
): Pick<CronFormState, "scheduleExact" | "staggerAmount" | "staggerUnit"> {
  if (staggerMs === 0) {
    return { scheduleExact: true, staggerAmount: "", staggerUnit: "seconds" };
  }
  if (typeof staggerMs !== "number" || !Number.isFinite(staggerMs) || staggerMs < 0) {
    return { scheduleExact: false, staggerAmount: "", staggerUnit: "seconds" };
  }
  if (staggerMs % 60_000 === 0) {
    return {
      scheduleExact: false,
      staggerAmount: String(Math.max(1, staggerMs / 60_000)),
      staggerUnit: "minutes",
    };
  }
  return {
    scheduleExact: false,
    staggerAmount: String(Math.max(1, Math.ceil(staggerMs / 1_000))),
    staggerUnit: "seconds",
  };
}

function jobToForm(job: CronJob, prev: CronFormState): CronFormState {
  const failureAlert = job.failureAlert;
  const payload = getCronJobPayload(job);
  const payloadLocked = payload?.kind === "command";
  const next: CronFormState = {
    ...prev,
    name: job.name,
    description: job.description ?? "",
    agentId: job.agentId ?? "",
    sessionKey: job.sessionKey ?? "",
    clearAgent: false,
    enabled: job.enabled,
    deleteAfterRun: job.deleteAfterRun ?? false,
    scheduleKind: job.schedule.kind,
    scheduleAt: "",
    everyAmount: prev.everyAmount,
    everyUnit: prev.everyUnit,
    cronExpr: prev.cronExpr,
    cronTz: "",
    scheduleExact: false,
    staggerAmount: "",
    staggerUnit: "seconds",
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payloadKind:
      payload?.kind === "systemEvent" || payload?.kind === "agentTurn"
        ? payload.kind
        : DEFAULT_CRON_FORM.payloadKind,
    payloadLocked,
    payloadText:
      payload?.kind === "systemEvent"
        ? payload.text
        : payload?.kind === "agentTurn"
          ? payload.message
          : payload?.kind === "command"
            ? payload.argv.join(" ")
            : "",
    payloadModel: payload?.kind === "agentTurn" ? (payload.model ?? "") : "",
    payloadThinking: payload?.kind === "agentTurn" ? (payload.thinking ?? "") : "",
    payloadLightContext: payload?.kind === "agentTurn" ? payload.lightContext === true : false,
    deliveryMode: job.delivery?.mode ?? "none",
    deliveryChannel: job.delivery?.channel ?? CRON_CHANNEL_LAST,
    deliveryTo: job.delivery?.to ?? "",
    deliveryAccountId: job.delivery?.accountId ?? "",
    deliveryBestEffort: job.delivery?.bestEffort ?? false,
    failureAlertMode:
      failureAlert === false
        ? "disabled"
        : failureAlert && typeof failureAlert === "object"
          ? "custom"
          : "inherit",
    failureAlertAfter:
      failureAlert && typeof failureAlert === "object" && typeof failureAlert.after === "number"
        ? String(failureAlert.after)
        : DEFAULT_CRON_FORM.failureAlertAfter,
    failureAlertCooldownSeconds:
      failureAlert &&
      typeof failureAlert === "object" &&
      typeof failureAlert.cooldownMs === "number"
        ? String(Math.floor(failureAlert.cooldownMs / 1000))
        : DEFAULT_CRON_FORM.failureAlertCooldownSeconds,
    failureAlertChannel:
      failureAlert && typeof failureAlert === "object"
        ? (failureAlert.channel ?? CRON_CHANNEL_LAST)
        : CRON_CHANNEL_LAST,
    failureAlertTo: failureAlert && typeof failureAlert === "object" ? (failureAlert.to ?? "") : "",
    failureAlertDeliveryMode:
      failureAlert && typeof failureAlert === "object"
        ? (failureAlert.mode ?? "announce")
        : "announce",
    failureAlertAccountId:
      failureAlert && typeof failureAlert === "object" ? (failureAlert.accountId ?? "") : "",
    timeoutSeconds:
      payload?.kind === "agentTurn" && typeof payload.timeoutSeconds === "number"
        ? String(payload.timeoutSeconds)
        : "",
  };

  if (job.schedule.kind === "at") {
    next.scheduleAt = formatDateTimeLocal(job.schedule.at);
  } else if (job.schedule.kind === "every") {
    const parsed = parseEverySchedule(job.schedule.everyMs);
    next.everyAmount = parsed.everyAmount;
    next.everyUnit = parsed.everyUnit;
  } else if (job.schedule.kind === "cron") {
    next.cronExpr = job.schedule.expr;
    next.cronTz = job.schedule.tz ?? "";
    const staggerFields = parseStaggerSchedule(job.schedule.staggerMs);
    next.scheduleExact = staggerFields.scheduleExact;
    next.staggerAmount = staggerFields.staggerAmount;
    next.staggerUnit = staggerFields.staggerUnit;
  }
  // Other schedule kinds (e.g. on-exit) are shown read-only in the list and have no
  // editable schedule form fields; leave the cron/at/every fields at their defaults.

  return normalizeCronFormState(next);
}

function buildCronSchedule(form: CronFormState) {
  if (form.scheduleKind === "at") {
    const ms = Date.parse(form.scheduleAt);
    if (!Number.isFinite(ms)) {
      throw new Error(t("cron.errors.invalidRunTime"));
    }
    return { kind: "at" as const, at: new Date(ms).toISOString() };
  }
  if (form.scheduleKind === "every") {
    const amount = toNumber(form.everyAmount, 0);
    if (amount <= 0) {
      throw new Error(t("cron.errors.invalidIntervalAmount"));
    }
    const unit = form.everyUnit;
    const mult = unit === "minutes" ? 60_000 : unit === "hours" ? 3_600_000 : 86_400_000;
    return { kind: "every" as const, everyMs: amount * mult };
  }
  const expr = form.cronExpr.trim();
  if (!expr) {
    throw new Error(t("cron.errors.cronExprRequiredShort"));
  }
  if (form.scheduleExact) {
    return { kind: "cron" as const, expr, tz: form.cronTz.trim() || undefined, staggerMs: 0 };
  }
  const staggerAmount = form.staggerAmount.trim();
  if (!staggerAmount) {
    return { kind: "cron" as const, expr, tz: form.cronTz.trim() || undefined };
  }
  const staggerValue = toNumber(staggerAmount, 0);
  if (staggerValue <= 0) {
    throw new Error(t("cron.errors.invalidStaggerAmount"));
  }
  const staggerMs = form.staggerUnit === "minutes" ? staggerValue * 60_000 : staggerValue * 1_000;
  return { kind: "cron" as const, expr, tz: form.cronTz.trim() || undefined, staggerMs };
}

function buildCronPayload(form: CronFormState) {
  if (form.payloadKind === "systemEvent") {
    const text = form.payloadText.trim();
    if (!text) {
      throw new Error(t("cron.errors.systemEventTextRequired"));
    }
    return { kind: "systemEvent" as const, text };
  }
  const message = form.payloadText.trim();
  if (!message) {
    throw new Error(t("cron.errors.agentMessageRequiredShort"));
  }
  const payload: {
    kind: "agentTurn";
    message: string;
    model?: string | null;
    thinking?: string | null;
    timeoutSeconds?: number;
    lightContext?: boolean;
  } = { kind: "agentTurn", message };
  const model = form.payloadModel.trim();
  if (model) {
    payload.model = model;
  }
  const thinking = form.payloadThinking.trim();
  if (thinking) {
    payload.thinking = thinking;
  }
  const timeoutSeconds = toNumber(form.timeoutSeconds, 0);
  if (timeoutSeconds > 0) {
    payload.timeoutSeconds = timeoutSeconds;
  }
  if (form.payloadLightContext) {
    payload.lightContext = true;
  }
  return payload;
}

function normalizePersistedDeliveryChannel(
  value: string,
  options: { preserveLastOnUpdate?: boolean } = {},
) {
  const channel = value.trim();
  if (!channel) {
    return undefined;
  }
  if (channel === CRON_CHANNEL_LAST) {
    return options.preserveLastOnUpdate ? CRON_CHANNEL_LAST : undefined;
  }
  return channel;
}

function buildFailureAlert(form: CronFormState, existingChannel?: string) {
  if (form.failureAlertMode === "disabled") {
    return false as const;
  }
  if (form.failureAlertMode !== "custom") {
    return undefined;
  }
  const after = toNumber(form.failureAlertAfter.trim(), 0);
  const cooldownRaw = form.failureAlertCooldownSeconds.trim();
  const cooldownSeconds = cooldownRaw.length > 0 ? toNumber(cooldownRaw, 0) : undefined;
  const cooldownMs =
    cooldownSeconds !== undefined && Number.isFinite(cooldownSeconds) && cooldownSeconds >= 0
      ? Math.floor(cooldownSeconds * 1000)
      : undefined;
  const deliveryMode = form.failureAlertDeliveryMode;
  const accountId = form.failureAlertAccountId.trim();
  const patch: Record<string, unknown> = {
    after: after > 0 ? Math.floor(after) : undefined,
    channel: normalizePersistedDeliveryChannel(form.failureAlertChannel, {
      preserveLastOnUpdate: Boolean(existingChannel),
    }),
    to: form.failureAlertTo.trim() || undefined,
    ...(cooldownMs !== undefined ? { cooldownMs } : {}),
  };
  if (deliveryMode) {
    patch.mode = deliveryMode;
  }
  patch.accountId = accountId || undefined;
  return patch;
}

type CronSaveResult = { saved: false } | { saved: true; jobId: string | null };

// cron.add responds with either { created, job } or the bare job read view.
function extractSavedCronJobId(response: unknown): string | null {
  if (!response || typeof response !== "object") {
    return null;
  }
  const container = "job" in response ? (response as { job?: unknown }).job : response;
  if (!container || typeof container !== "object") {
    return null;
  }
  const id = (container as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export async function addCronJob(state: CronState): Promise<CronSaveResult> {
  let result: CronSaveResult = { saved: false };
  await withCronBusy(state, async (client) => {
    const form = normalizeCronFormState(state.cronForm);
    if (form !== state.cronForm) {
      state.cronForm = form;
    }
    const fieldErrors = validateCronForm(form);
    state.cronFieldErrors = fieldErrors;
    if (hasCronFormErrors(fieldErrors)) {
      return;
    }

    const editingJob = state.cronEditingJobId
      ? state.cronJobs.find((job) => job.id === state.cronEditingJobId)
      : undefined;
    const editingPayload = editingJob ? getCronJobPayload(editingJob) : null;
    // Preserve on-exit only while the edit form still points at on-exit; if the
    // user selects an editable schedule kind, the update must apply it.
    const preserveSchedule = Boolean(
      state.cronEditingJobId &&
      (editingJob?.schedule as { kind?: string } | undefined)?.kind === "on-exit" &&
      form.scheduleKind === "on-exit",
    );
    const schedule = preserveSchedule ? undefined : buildCronSchedule(form);
    const preserveLockedPayload = Boolean(
      state.cronEditingJobId && form.payloadLocked && editingPayload?.kind === "command",
    );
    const payload = preserveLockedPayload ? undefined : buildCronPayload(form);
    if (
      payload?.kind === "agentTurn" &&
      state.cronEditingJobId &&
      editingPayload?.kind === "agentTurn"
    ) {
      // When editing, a blanked field that previously held a stored override must
      // send an explicit clear; an omitted key means "leave unchanged" on merge.
      // The form only shows stored overrides (not inherited defaults), so a blank
      // input with a stored value is an intentional clear.
      if (!form.payloadModel.trim() && editingPayload.model !== undefined) {
        payload.model = null;
      }
      if (!form.payloadThinking.trim() && editingPayload.thinking !== undefined) {
        payload.thinking = null;
      }
      if (!form.payloadLightContext && editingPayload.lightContext !== undefined) {
        payload.lightContext = false;
      }
    }
    const selectedDeliveryMode = form.deliveryMode;
    const normalizedDeliveryAccountId = form.deliveryAccountId.trim();
    // Update patches need null to clear stored routing; create payloads must
    // omit blanks because the Gateway accountId schema rejects empty strings.
    const deliveryAccountId =
      selectedDeliveryMode === "announce"
        ? normalizedDeliveryAccountId || (editingJob?.delivery?.accountId ? null : undefined)
        : undefined;
    const delivery =
      selectedDeliveryMode && selectedDeliveryMode !== "none"
        ? {
            mode: selectedDeliveryMode,
            channel:
              selectedDeliveryMode === "announce"
                ? normalizePersistedDeliveryChannel(form.deliveryChannel, {
                    preserveLastOnUpdate: Boolean(editingJob?.delivery?.channel),
                  })
                : undefined,
            to: form.deliveryTo.trim() || undefined,
            accountId: deliveryAccountId,
            bestEffort: form.deliveryBestEffort,
          }
        : selectedDeliveryMode === "none"
          ? ({ mode: "none" } as const)
          : undefined;
    const failureAlert = buildFailureAlert(
      form,
      editingJob?.failureAlert && typeof editingJob.failureAlert === "object"
        ? editingJob.failureAlert.channel
        : undefined,
    );
    const agentId = form.clearAgent ? null : form.agentId.trim();
    const sessionKeyRaw = form.sessionKey.trim();
    const sessionKey = sessionKeyRaw || (editingJob?.sessionKey ? null : undefined);
    const job: Record<string, unknown> = {
      name: form.name.trim(),
      description: form.description.trim(),
      agentId: agentId === null ? null : agentId || undefined,
      sessionKey,
      enabled: form.enabled,
      deleteAfterRun: form.deleteAfterRun,
      sessionTarget: form.sessionTarget,
      wakeMode: form.wakeMode,
      delivery,
      failureAlert,
    };
    if (schedule) {
      job.schedule = schedule;
    }
    if (payload) {
      job.payload = payload;
    }
    if (!job.name) {
      throw new Error(t("cron.errors.nameRequiredShort"));
    }
    if (state.cronEditingJobId) {
      const editedJobId = state.cronEditingJobId;
      await client.request("cron.update", {
        id: editedJobId,
        patch: job,
      });
      clearCronEditState(state);
      result = { saved: true, jobId: editedJobId };
    } else {
      const response = await client.request("cron.add", job);
      resetCronFormToDefaults(state);
      result = { saved: true, jobId: extractSavedCronJobId(response) };
    }
    await reloadCronJobsSnapshot(state);
  });
  return result;
}

// Every mutation reloads the same trio so the table, scheduler status, and
// the failing-count stat card can never drift apart after add/toggle/remove.
async function reloadCronJobsSnapshot(state: CronState) {
  await loadCronJobsPage(state, { tableFilters: true });
  await loadCronStatus(state);
  await loadCronFailingCount(state);
}

export async function toggleCronJob(
  state: CronState,
  job: CronJob,
  enabled: boolean,
): Promise<boolean> {
  // Report whether the update RPC itself succeeded; the follow-up list reload
  // can be queued or fail without invalidating the confirmed toggle.
  let updated = false;
  await withCronBusy(state, async (client) => {
    await client.request("cron.update", { id: job.id, patch: { enabled } });
    updated = true;
    await reloadCronJobsSnapshot(state);
  });
  return updated;
}

function cronRunNotStartedMessage(result: CronRunResult): string {
  if (!("reason" in result)) {
    return t("cron.runNotStarted.unknown");
  }
  switch (result.reason) {
    case "not-due":
      return t("cron.runNotStarted.notDue");
    case "already-running":
      return t("cron.runNotStarted.alreadyRunning");
    case "restart-recovery-pending":
      return t("cron.runNotStarted.recoveryPending");
    case "invalid-spec":
      return t("cron.runNotStarted.invalidSpec");
    case "stopped":
      return t("cron.runNotStarted.stopped");
  }
  return t("cron.runNotStarted.unknown");
}

export async function runCronJob(state: CronState, jobId: string, mode: "force" | "due" = "force") {
  await withCronBusy(state, async (client) => {
    const result = await client.request<CronRunResult>("cron.run", { id: jobId, mode });
    if (!result.ok || ("ran" in result && !result.ran)) {
      state.cronError = cronRunNotStartedMessage(result);
      // Invalid persisted specs create a skipped history entry with diagnostics;
      // true no-op outcomes have no new history to fetch.
      if ("reason" in result && result.reason === "invalid-spec") {
        await loadCronRuns(state, state.cronRunsScope === "all" ? null : jobId);
      }
      return;
    }
    await loadCronRuns(state, state.cronRunsScope === "all" ? null : jobId);
  });
}

export async function removeCronJob(state: CronState, job: CronJob) {
  await withCronBusy(state, async (client) => {
    await client.request("cron.remove", { id: job.id });
    if (state.cronEditingJobId === job.id) {
      clearCronEditState(state);
    }
    if (state.cronRunsJobId === job.id) {
      state.cronRunsJobId = null;
      clearCronRunsPage(state);
    }
    await reloadCronJobsSnapshot(state);
  });
}

export async function loadCronRuns(
  state: CronState,
  jobId: string | null,
  opts?: { append?: boolean },
): Promise<CronRunsLoadStatus> {
  if (!state.client || !state.connected) {
    return "skipped";
  }
  const scope = state.cronRunsScope;
  const activeJobId = jobId ?? state.cronRunsJobId;
  if (scope === "job" && !activeJobId) {
    clearCronRunsPage(state);
    return "skipped";
  }
  const append = opts?.append === true;
  if (append && !state.cronRunsHasMore) {
    return "skipped";
  }
  try {
    if (append) {
      state.cronRunsLoadingMore = true;
    }
    const offset = append ? Math.max(0, state.cronRunsNextOffset ?? state.cronRuns.length) : 0;
    const res = await state.client.request<CronRunsResult>("cron.runs", {
      ...(state.cronAgentId ? { agentId: state.cronAgentId } : {}),
      scope,
      id: scope === "job" ? (activeJobId ?? undefined) : undefined,
      limit: state.cronRunsLimit,
      offset,
      statuses: state.cronRunsStatuses.length > 0 ? state.cronRunsStatuses : undefined,
      status: state.cronRunsStatusFilter,
      deliveryStatuses:
        state.cronRunsDeliveryStatuses.length > 0 ? state.cronRunsDeliveryStatuses : undefined,
      query: state.cronRunsQuery.trim() || undefined,
      sortDir: state.cronRunsSortDir,
    });
    // A slower response for a previously selected job (or one arriving after
    // the pane switched back to all-scope) must not overwrite the current run
    // pane; callers claim cronRunsJobId/scope before awaiting.
    const staleJobResponse =
      scope === "job" && (state.cronRunsScope !== "job" || state.cronRunsJobId !== activeJobId);
    if (staleJobResponse) {
      return "skipped";
    }
    const entries = Array.isArray(res.entries) ? res.entries : [];
    state.cronRuns =
      append && (scope === "all" || state.cronRunsJobId === activeJobId)
        ? [...state.cronRuns, ...entries]
        : entries;
    const meta = normalizeCronPageMeta({
      totalRaw: res.total,
      offsetRaw: res.offset,
      nextOffsetRaw: res.nextOffset,
      hasMoreRaw: res.hasMore,
      pageCount: entries.length,
    });
    state.cronRunsTotal = Math.max(meta.total, state.cronRuns.length);
    state.cronRunsHasMore = meta.hasMore;
    state.cronRunsNextOffset = meta.nextOffset;
    return "ok";
  } catch (err) {
    state.cronError = String(err);
    return "error";
  } finally {
    if (append) {
      state.cronRunsLoadingMore = false;
    }
  }
}

export async function loadMoreCronRuns(state: CronState) {
  if (state.cronRunsScope === "job" && !state.cronRunsJobId) {
    return;
  }
  await loadCronRuns(state, state.cronRunsJobId, { append: true });
}

export function updateCronRunsFilter(
  state: CronState,
  patch: Partial<
    Pick<
      CronState,
      | "cronRunsScope"
      | "cronRunsStatuses"
      | "cronRunsDeliveryStatuses"
      | "cronRunsStatusFilter"
      | "cronRunsQuery"
      | "cronRunsSortDir"
    >
  >,
) {
  state.cronRunsScope = patch.cronRunsScope ?? state.cronRunsScope;
  if (Array.isArray(patch.cronRunsStatuses)) {
    state.cronRunsStatuses = patch.cronRunsStatuses;
    state.cronRunsStatusFilter = patch.cronRunsStatuses[0] ?? "all";
  }
  if (Array.isArray(patch.cronRunsDeliveryStatuses)) {
    state.cronRunsDeliveryStatuses = patch.cronRunsDeliveryStatuses;
  }
  if (patch.cronRunsStatusFilter) {
    state.cronRunsStatusFilter = patch.cronRunsStatusFilter;
    state.cronRunsStatuses =
      patch.cronRunsStatusFilter === "all" ? [] : [patch.cronRunsStatusFilter];
  }
  if (typeof patch.cronRunsQuery === "string") {
    state.cronRunsQuery = patch.cronRunsQuery;
  }
  state.cronRunsSortDir = patch.cronRunsSortDir ?? state.cronRunsSortDir;
}

export function startCronEdit(state: CronState, job: CronJob) {
  state.cronEditingJobId = job.id;
  state.cronRunsJobId = job.id;
  state.cronForm = jobToForm(job, state.cronForm);
  state.cronFieldErrors = validateCronForm(state.cronForm);
}

function buildCloneName(name: string, existingNames: Set<string>) {
  const base = name.trim() || "Job";
  const first = `${base} copy`;
  if (!existingNames.has(normalizeLowercaseStringOrEmpty(first))) {
    return first;
  }
  let index = 2;
  while (index < 1000) {
    const next = `${base} copy ${index}`;
    if (!existingNames.has(normalizeLowercaseStringOrEmpty(next))) {
      return next;
    }
    index += 1;
  }
  return `${base} copy ${Date.now()}`;
}

export function startCronClone(state: CronState, job: CronJob) {
  clearCronEditState(state);
  state.cronRunsJobId = job.id;
  const existingNames = new Set(
    state.cronJobs.map((entry) => normalizeLowercaseStringOrEmpty(entry.name)),
  );
  const cloned = jobToForm(job, state.cronForm);
  cloned.name = buildCloneName(job.name, existingNames);
  if (cloned.payloadLocked) {
    cloned.payloadLocked = false;
    cloned.payloadKind = DEFAULT_CRON_FORM.payloadKind;
    cloned.payloadText = "";
  }
  state.cronForm = cloned;
  state.cronFieldErrors = validateCronForm(state.cronForm);
}

export function cancelCronEdit(state: CronState) {
  clearCronEditState(state);
  resetCronFormToDefaults(state);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
