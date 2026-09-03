import { parseStrictFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveCronTriggerMinIntervalMs } from "../../../../src/config/cron-limits.js";
import { isSystemOwnedCronPayloadKind } from "../../../../src/cron/types.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  CronJob,
  CronDeliveryStatus,
  CronJobsEnabledFilter,
  CronJobsScheduleKindFilter,
  CronJobsTriggerFilter,
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
import { formatUiError } from "../format-error.ts";
import { toNumber } from "../format.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "../gateway-errors.ts";
import { parseCronDurationMs } from "./decimal.ts";

export { loadCronScopeStats } from "./scope.ts";

const CRON_CHANNEL_LAST = "last";
type CronDelivery = NonNullable<CronJob["delivery"]>;
type CronFormAnnounceDelivery = Extract<CronDelivery, { mode: "announce" }>;

export type CronFormState = {
  name: string;
  description: string;
  agentId: string;
  sessionKey: string;
  clearAgent: boolean;
  enabled: boolean;
  deleteAfterRun: boolean;
  // Process-backed schedules are read-only because the form cannot edit their commands.
  // Preserve their schedule verbatim on save instead of rebuilding it.
  scheduleKind: "at" | "every" | "cron" | "on-exit" | "stream";
  scheduleAt: string;
  everyAmount: string;
  everyUnit: "seconds" | "minutes" | "hours" | "days";
  cronExpr: string;
  cronTz: string;
  scheduleExact: boolean;
  staggerAmount: string;
  staggerUnit: "seconds" | "minutes";
  triggerEnabled: boolean;
  triggerScript: string;
  triggerOnce: boolean;
  sessionTarget: "main" | "isolated" | "current" | `session:${string}`;
  wakeMode: "next-heartbeat" | "now";
  // System-owned payloads are always payloadLocked; the form only
  // displays it, never submits it.
  payloadKind:
    | "systemEvent"
    | "agentTurn"
    | "command"
    | "script"
    | "heartbeat"
    | "skillCollectionReview";
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
  deliveryThreadId: CronDelivery["threadId"] | undefined;
  deliveryCompletionDestination: CronFormAnnounceDelivery["completionDestination"] | undefined;
  deliveryFailureDestination: CronDelivery["failureDestination"] | undefined;
  failureAlertMode: "inherit" | "disabled" | "custom";
  failureAlertAfter: string;
  failureAlertCooldownSeconds: string;
  failureAlertChannel: string;
  failureAlertTo: string;
  failureAlertDeliveryMode: "" | "announce" | "webhook";
  failureAlertAccountId: string;
  timeoutSeconds: string;
};

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
  if (value.kind === "script") {
    return typeof value.script === "string";
  }
  if (isSystemOwnedCronPayloadKind(value.kind)) {
    return true;
  }
  return false;
}

function isCronFormSessionTarget(value: string): value is CronFormState["sessionTarget"] {
  return (
    value === "main" ||
    value === "isolated" ||
    value === "current" ||
    (value.startsWith("session:") && value.length > "session:".length)
  );
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
  deleteAfterRun: false,
  scheduleKind: "every",
  scheduleAt: "",
  everyAmount: "30",
  everyUnit: "minutes",
  cronExpr: "0 7 * * *",
  cronTz: "",
  scheduleExact: false,
  staggerAmount: "",
  staggerUnit: "seconds",
  triggerEnabled: false,
  triggerScript: "",
  triggerOnce: false,
  sessionTarget: "isolated",
  wakeMode: "now",
  payloadKind: "agentTurn",
  payloadLocked: false,
  payloadText: "",
  payloadModel: "",
  payloadThinking: "",
  payloadLightContext: false,
  deliveryMode: "none",
  deliveryChannel: "last",
  deliveryTo: "",
  deliveryAccountId: "",
  deliveryBestEffort: false,
  deliveryThreadId: undefined,
  deliveryCompletionDestination: undefined,
  deliveryFailureDestination: undefined,
  failureAlertMode: "inherit",
  failureAlertAfter: "",
  failureAlertCooldownSeconds: "",
  failureAlertChannel: "last",
  failureAlertTo: "",
  failureAlertDeliveryMode: "",
  failureAlertAccountId: "",
  timeoutSeconds: "",
};

export type CronFieldKey =
  | "name"
  | "scheduleAt"
  | "everyAmount"
  | "cronExpr"
  | "staggerAmount"
  | "triggerScript"
  | "payloadText"
  | "payloadModel"
  | "payloadThinking"
  | "timeoutSeconds"
  | "deliveryTo"
  | "failureAlertAfter"
  | "failureAlertCooldownSeconds";

export type CronFieldErrors = Partial<Record<CronFieldKey, string>>;

export type CronJobsLastStatusFilter = "all" | CronRunStatus | "unknown";
type CronRunsLoadStatus = "ok" | "error" | "skipped";

export type CronState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  cronLoading: boolean;
  cronJobsError: string | null;
  cronJobsLoadingMore: boolean;
  cronJobsReloadPending: boolean;
  cronJobsReloadPendingTableFilters: boolean;
  cronJobs: CronJob[];
  cronJobsSnapshotRevision: string | null;
  cronJobsTotal: number;
  cronJobsHasMore: boolean;
  cronJobsNextOffset: number | null;
  cronJobsLimit: number;
  cronJobsQuery: string;
  cronJobsEnabledFilter: CronJobsEnabledFilter;
  cronJobsScheduleKindFilter: CronJobsScheduleKindFilter;
  cronJobsLastStatusFilter: CronJobsLastStatusFilter;
  cronJobsTriggerFilter: CronJobsTriggerFilter;
  cronJobsSortBy: CronJobsSortBy;
  cronJobsSortDir: CronSortDir;
  cronAgentId: string | null;
  cronStatus: CronStatus | null;
  cronScopedTotal: number | null;
  cronScopedNextWakeAtMs: number | null;
  cronError: string | null;
  cronForm: CronFormState;
  // True while the create panel owns the detail pane; job selection (editing)
  // always wins over it when deriving the visible panel.
  cronCreateOpen: boolean;
  cronFieldErrors: CronFieldErrors;
  // Exact definition the editor was opened or refreshed against; cronJobs is
  // only the current filtered/paged table cache.
  cronEditingJob: CronJob | null;
  cronCloningJob: CronJob | null;
  cronEditingJobId: string | null;
  cronEditingConfigRevision: string | null;
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
    cronJobsError: null,
    cronJobsLoadingMore: false,
    cronJobsReloadPending: false,
    cronJobsReloadPendingTableFilters: false,
    cronJobs: [],
    cronJobsSnapshotRevision: null,
    cronJobsTotal: 0,
    cronJobsHasMore: false,
    cronJobsNextOffset: null,
    cronJobsLimit: 50,
    cronJobsQuery: "",
    cronJobsEnabledFilter: "all",
    cronJobsScheduleKindFilter: "all",
    cronJobsLastStatusFilter: "all",
    cronJobsTriggerFilter: "all",
    cronJobsSortBy: "nextRunAtMs",
    cronJobsSortDir: "asc",
    cronAgentId: null,
    cronStatus: null,
    cronScopedTotal: null,
    cronScopedNextWakeAtMs: null,
    cronError: null,
    cronForm: { ...DEFAULT_CRON_FORM },
    cronCreateOpen: false,
    cronFieldErrors: {},
    cronEditingJob: null,
    cronCloningJob: null,
    cronEditingJobId: null,
    cronEditingConfigRevision: null,
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

export function normalizeCronFormState(
  form: CronFormState,
  changed: Partial<CronFormState> = {},
): CronFormState {
  let normalized = form;
  if (!form.payloadLocked) {
    if (changed.sessionTarget !== undefined) {
      const payloadKind = form.sessionTarget === "main" ? "systemEvent" : "agentTurn";
      if (form.payloadKind !== payloadKind) {
        normalized = { ...normalized, payloadKind };
      }
    } else if (form.payloadKind === "systemEvent" && form.sessionTarget !== "main") {
      normalized = { ...normalized, sessionTarget: "main" };
    } else if (form.payloadKind === "agentTurn" && form.sessionTarget === "main") {
      normalized = { ...normalized, sessionTarget: "isolated" };
    }
  }
  if (normalized.deliveryMode !== "announce" || supportsAnnounceDelivery(normalized)) {
    return normalized;
  }
  return {
    ...normalized,
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
    const everyMs = parseCronDurationMs(form.everyAmount, form.everyUnit);
    if (everyMs === undefined) {
      errors.everyAmount = "cron.errors.everyAmountInvalid";
    } else if (form.triggerEnabled && everyMs < resolveCronTriggerMinIntervalMs()) {
      errors.everyAmount = "cron.errors.triggerIntervalTooShort";
    }
  } else if (form.scheduleKind === "cron") {
    if (!form.cronExpr.trim()) {
      errors.cronExpr = "cron.errors.cronExprRequired";
    }
    if (!form.scheduleExact) {
      const staggerAmount = form.staggerAmount.trim();
      if (staggerAmount && !parseCronDurationMs(staggerAmount, form.staggerUnit, true)) {
        errors.staggerAmount = "cron.errors.staggerAmountInvalid";
      }
    }
  }
  if (form.triggerEnabled) {
    if (form.payloadKind === "script") {
      errors.triggerScript = "cron.errors.triggerScriptPayloadUnsupported";
    } else if (
      form.scheduleKind !== "every" &&
      form.scheduleKind !== "cron" &&
      form.scheduleKind !== "stream"
    ) {
      errors.triggerScript = "cron.errors.triggerScheduleUnsupported";
    } else if (!form.triggerScript.trim()) {
      errors.triggerScript = "cron.errors.triggerScriptRequired";
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
      const timeout = toNumber(timeoutRaw, Number.NaN);
      if (!Number.isFinite(timeout) || timeout < 0) {
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
      if (!Number.isFinite(after) || after < 1) {
        errors.failureAlertAfter = "Failure alert threshold must be at least 1.";
      }
    }
    const cooldownRaw = form.failureAlertCooldownSeconds.trim();
    if (cooldownRaw && parseFailureAlertCooldownMs(cooldownRaw) === undefined) {
      errors.failureAlertCooldownSeconds = "Cooldown must be finite and 0 or greater.";
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
      state.cronError = formatUiError(err);
    }
  }
}

export async function loadCronModelSuggestions(
  state: CronModelSuggestionsState,
  agentId: string | null,
) {
  if (!state.client || !state.connected || !agentId) {
    return;
  }
  try {
    const res = await state.client.request("models.list", {
      agentId,
      view: "configured",
      preparedOnly: true,
    });
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
  const entries = (agents as { entries?: unknown }).entries;
  if (entries && typeof entries === "object" && !Array.isArray(entries)) {
    for (const entry of Object.values(entries as Record<string, unknown>)) {
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
    state.cronError = formatUiError(err);
  } finally {
    state.cronBusy = false;
  }
}

function requireCronConfigRevision(revision: string | null | undefined): string {
  if (revision) {
    return revision;
  }
  throw new Error("This automation is missing its configuration revision. Refresh and try again.");
}

function replaceLocalCronJob(state: CronState, updatedJob: CronJob) {
  state.cronJobs = state.cronJobs.map((job) => (job.id === updatedJob.id ? updatedJob : job));
}

function isCronJobChangedError(error: unknown): boolean {
  const details = isRecord(error) && isRecord(error.details) ? error.details : null;
  return details?.code === "CRON_JOB_CHANGED";
}

function normalizeCronRunsPageMeta(params: {
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

type CanonicalCronJobsPage = {
  jobs: CronJob[];
  snapshotRevision: string;
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
};

function readCanonicalCronJobsPage(value: unknown, requestedLimit: number): CanonicalCronJobsPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.jobs) ||
    typeof value.snapshotRevision !== "string" ||
    value.snapshotRevision.length === 0 ||
    typeof value.total !== "number" ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0 ||
    typeof value.offset !== "number" ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    typeof value.limit !== "number" ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.limit > requestedLimit ||
    value.jobs.length > value.limit ||
    typeof value.hasMore !== "boolean" ||
    (value.nextOffset !== null &&
      (typeof value.nextOffset !== "number" ||
        !Number.isSafeInteger(value.nextOffset) ||
        value.nextOffset < 0))
  ) {
    throw new Error("cron.list returned an invalid inventory page");
  }
  return value as CanonicalCronJobsPage;
}

function assertCanonicalCronJobsCursor(page: CanonicalCronJobsPage, requestedOffset: number) {
  const nextOffset = requestedOffset + page.jobs.length;
  if (
    page.offset !== requestedOffset ||
    !Number.isSafeInteger(nextOffset) ||
    nextOffset > page.total ||
    (page.hasMore
      ? page.nextOffset !== nextOffset || nextOffset <= requestedOffset || nextOffset >= page.total
      : page.nextOffset !== null || nextOffset !== page.total)
  ) {
    throw new Error("cron.list returned an invalid inventory page");
  }
}

function queueCronJobsSnapshotRecovery(state: CronState, tableFilters: boolean) {
  if (state.cronJobsReloadPending) {
    return;
  }
  state.cronJobsReloadPending = true;
  state.cronJobsReloadPendingTableFilters = tableFilters;
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
  state.cronJobsError = null;
  try {
    const offset = append ? Math.max(0, state.cronJobsNextOffset ?? state.cronJobs.length) : 0;
    const res = await state.client.request<CronJobsListResult>("cron.list", {
      ...(state.cronAgentId ? { agentId: state.cronAgentId } : {}),
      includeDisabled: state.cronJobsEnabledFilter === "all",
      includeDeliveryPreviews: false,
      limit: state.cronJobsLimit,
      offset,
      query: state.cronJobsQuery.trim() || undefined,
      enabled: state.cronJobsEnabledFilter,
      ...(opts?.tableFilters
        ? {
            scheduleKind: state.cronJobsScheduleKindFilter,
            lastRunStatus: state.cronJobsLastStatusFilter,
            trigger: state.cronJobsTriggerFilter,
          }
        : {}),
      sortBy: state.cronJobsSortBy,
      sortDir: state.cronJobsSortDir,
    });
    const page = readCanonicalCronJobsPage(res, state.cronJobsLimit);
    if (
      append &&
      (page.snapshotRevision !== state.cronJobsSnapshotRevision ||
        page.total !== state.cronJobsTotal)
    ) {
      // A changed snapshot can move rows behind the append boundary. Preserve
      // the coherent table and let one serialized page-zero reload recover it.
      queueCronJobsSnapshotRecovery(state, opts?.tableFilters === true);
      return;
    }
    assertCanonicalCronJobsCursor(page, offset);
    const jobs = page.jobs.filter(hasCronJobPayload);
    const nextJobs = append ? [...state.cronJobs, ...jobs] : jobs;
    state.cronJobs = nextJobs;
    state.cronJobsSnapshotRevision = page.snapshotRevision;
    state.cronJobsTotal = page.total;
    state.cronJobsHasMore = page.hasMore;
    state.cronJobsNextOffset = page.nextOffset;
    // A filtered/paged list is not deletion authority. Only an explicit remove
    // may clear an editor opened from an exact job definition.
  } catch (err) {
    state.cronJobsError = formatUiError(err);
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
      | "cronJobsTriggerFilter"
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
  state.cronJobsTriggerFilter = patch.cronJobsTriggerFilter ?? state.cronJobsTriggerFilter;
  state.cronJobsSortBy = patch.cronJobsSortBy ?? state.cronJobsSortBy;
  state.cronJobsSortDir = patch.cronJobsSortDir ?? state.cronJobsSortDir;
}

function clearCronEditState(state: CronState) {
  state.cronError = null;
  state.cronEditingJob = null;
  state.cronCloningJob = null;
  state.cronEditingJobId = null;
  state.cronEditingConfigRevision = null;
}

function clearCronRunsPage(state: CronState) {
  state.cronRuns = [];
  state.cronRunsTotal = 0;
  state.cronRunsHasMore = false;
  state.cronRunsNextOffset = null;
}

function resetCronFormToDefaults(state: CronState, agentId: string | null) {
  state.cronCloningJob = null;
  state.cronForm = { ...DEFAULT_CRON_FORM, agentId: agentId ?? "" };
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

// Render everyMs back to the largest unit that divides it exactly, falling through
// to decimal seconds. Sub-second remainders are built from BigInt quotient/remainder,
// not float division, so every accepted millisecond round-trips losslessly
// through parseCronDurationMs when the job is resaved.
function parseEverySchedule(everyMs: number): Pick<CronFormState, "everyAmount" | "everyUnit"> {
  if (everyMs % 86_400_000 === 0) {
    return { everyAmount: String(everyMs / 86_400_000), everyUnit: "days" };
  }
  if (everyMs % 3_600_000 === 0) {
    return { everyAmount: String(everyMs / 3_600_000), everyUnit: "hours" };
  }
  if (everyMs % 60_000 === 0) {
    return { everyAmount: String(everyMs / 60_000), everyUnit: "minutes" };
  }
  return { everyAmount: durationMsToSecondsString(everyMs), everyUnit: "seconds" };
}

function durationMsToSecondsString(ms: number): string {
  const value = BigInt(ms);
  const whole = value / 1_000n;
  const remainder = value % 1_000n;
  if (remainder === 0n) {
    return String(whole);
  }
  const fractional = remainder.toString().padStart(3, "0").replace(/0+$/u, "");
  return `${whole}.${fractional}`;
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
      staggerAmount: String(staggerMs / 60_000),
      staggerUnit: "minutes",
    };
  }
  return {
    scheduleExact: false,
    staggerAmount: durationMsToSecondsString(staggerMs),
    staggerUnit: "seconds",
  };
}

function isReadOnlyCronPayload(payload: CronPayload | null): boolean {
  return (
    payload?.kind === "command" ||
    payload?.kind === "script" ||
    isSystemOwnedCronPayloadKind(payload?.kind)
  );
}

function jobToForm(job: CronJob, prev: CronFormState): CronFormState {
  const failureAlert = typeof job.failureAlert === "object" ? job.failureAlert : undefined;
  const payload = getCronJobPayload(job);
  const payloadLocked = isReadOnlyCronPayload(payload);
  if (!isCronFormSessionTarget(job.sessionTarget)) {
    throw new TypeError(`Invalid cron session target: ${job.sessionTarget}`);
  }
  const next: CronFormState = {
    ...prev,
    name: job.name,
    description: job.description ?? "",
    agentId: job.agentId ?? "",
    sessionKey: job.sessionKey ?? "",
    clearAgent: false,
    enabled: job.enabled,
    deleteAfterRun: job.deleteAfterRun ?? job.schedule.kind === "at",
    scheduleKind: job.schedule.kind,
    scheduleAt: "",
    everyAmount: prev.everyAmount,
    everyUnit: prev.everyUnit,
    cronExpr: prev.cronExpr,
    cronTz: "",
    scheduleExact: false,
    staggerAmount: "",
    staggerUnit: "seconds",
    triggerEnabled: job.trigger !== undefined,
    triggerScript: job.trigger?.script ?? "",
    triggerOnce: job.trigger?.once === true,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    payloadKind: payload?.kind ?? DEFAULT_CRON_FORM.payloadKind,
    payloadLocked,
    payloadText:
      payload?.kind === "systemEvent"
        ? payload.text
        : payload?.kind === "agentTurn"
          ? payload.message
          : payload?.kind === "command"
            ? payload.argv.join(" ")
            : payload?.kind === "script"
              ? payload.script
              : "",
    payloadModel: payload?.kind === "agentTurn" ? (payload.model ?? "") : "",
    payloadThinking: payload?.kind === "agentTurn" ? (payload.thinking ?? "") : "",
    payloadLightContext: payload?.kind === "agentTurn" ? payload.lightContext === true : false,
    deliveryMode: job.delivery?.mode ?? "none",
    deliveryChannel: job.delivery?.channel ?? CRON_CHANNEL_LAST,
    deliveryTo: job.delivery?.to ?? "",
    deliveryAccountId: job.delivery?.accountId ?? "",
    deliveryBestEffort: job.delivery?.bestEffort ?? false,
    deliveryThreadId: job.delivery?.threadId,
    deliveryCompletionDestination:
      job.delivery?.mode === "announce" ? job.delivery.completionDestination : undefined,
    deliveryFailureDestination: job.delivery?.failureDestination,
    failureAlertMode: job.failureAlert === false ? "disabled" : failureAlert ? "custom" : "inherit",
    failureAlertAfter: typeof failureAlert?.after === "number" ? String(failureAlert.after) : "",
    failureAlertCooldownSeconds:
      typeof failureAlert?.cooldownMs === "number"
        ? durationMsToSecondsString(failureAlert.cooldownMs)
        : "",
    failureAlertChannel: failureAlert?.channel ?? CRON_CHANNEL_LAST,
    failureAlertTo: failureAlert?.to ?? "",
    failureAlertDeliveryMode: failureAlert?.mode ?? "",
    failureAlertAccountId: failureAlert?.accountId ?? "",
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
  // Process-backed schedule kinds are shown read-only in the list and have no
  // editable schedule form fields; leave the cron/at/every fields at their defaults.

  return normalizeCronFormState(next);
}

function hasUnchangedCronSchedule(form: CronFormState, job: CronJob): boolean {
  const schedule = job.schedule;
  if (form.scheduleKind !== schedule.kind) {
    return false;
  }
  if (schedule.kind === "at") {
    return form.scheduleAt === formatDateTimeLocal(schedule.at);
  }
  if (schedule.kind === "every") {
    return parseCronDurationMs(form.everyAmount, form.everyUnit) === schedule.everyMs;
  }
  if (schedule.kind === "cron") {
    const stagger = parseStaggerSchedule(schedule.staggerMs);
    return (
      form.cronExpr.trim() === schedule.expr &&
      form.cronTz.trim() === (schedule.tz ?? "") &&
      form.scheduleExact === stagger.scheduleExact &&
      form.staggerAmount.trim() === stagger.staggerAmount &&
      form.staggerUnit === stagger.staggerUnit
    );
  }
  return true;
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
    const everyMs = parseCronDurationMs(form.everyAmount, form.everyUnit);
    if (everyMs === undefined) {
      throw new Error(t("cron.errors.invalidIntervalAmount"));
    }
    return { kind: "every" as const, everyMs };
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
  const staggerMs = parseCronDurationMs(staggerAmount, form.staggerUnit, true);
  if (staggerMs === undefined) {
    throw new Error(t("cron.errors.invalidStaggerAmount"));
  }
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
  if (form.payloadKind !== "agentTurn") {
    throw new Error(`Cron ${form.payloadKind} payloads are read-only in Control UI.`);
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
  const timeoutRaw = form.timeoutSeconds.trim();
  if (timeoutRaw) {
    const timeoutSeconds = toNumber(timeoutRaw, Number.NaN);
    if (Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0) {
      payload.timeoutSeconds = timeoutSeconds;
    }
  }
  if (form.payloadLightContext) {
    payload.lightContext = true;
  }
  return payload;
}

function normalizePersistedDeliveryChannel(
  value: string,
  options: { preserveLast?: boolean } = {},
) {
  const channel = value.trim();
  if (!channel) {
    return undefined;
  }
  if (channel === CRON_CHANNEL_LAST) {
    return options.preserveLast ? CRON_CHANNEL_LAST : undefined;
  }
  return channel;
}

function parseFailureAlertCooldownMs(value: string): number | undefined {
  const raw = value.trim();
  const seconds = toNumber(raw, Number.NaN);
  if (!raw || !Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  // Keep decimal precision; normalize other accepted Number spellings before the same scale.
  const decimal =
    seconds === 0 || parseStrictFiniteNumber(raw) === undefined ? String(seconds) : raw;
  const [coefficient, exponent = "0"] = decimal.split(/[eE]/u);
  const ms = Number(`${coefficient}e${Number(exponent) + 3}`);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : undefined;
}

function buildFailureAlert(
  form: CronFormState,
  source?: CronJob["failureAlert"],
  isUpdate = false,
) {
  if (form.failureAlertMode === "disabled") {
    return false as const;
  }
  if (form.failureAlertMode !== "custom") {
    return isUpdate && source !== undefined ? null : undefined;
  }
  const sourceConfig = source && typeof source === "object" ? source : undefined;
  const existingConfig = isUpdate ? sourceConfig : undefined;
  const after = toNumber(form.failureAlertAfter.trim(), 0);
  const cooldownMs = parseFailureAlertCooldownMs(form.failureAlertCooldownSeconds);
  const accountId = form.failureAlertAccountId.trim();
  const to = form.failureAlertTo.trim();
  return {
    after: after > 0 ? Math.floor(after) : existingConfig?.after !== undefined ? null : undefined,
    channel: normalizePersistedDeliveryChannel(form.failureAlertChannel, {
      preserveLast: Boolean(sourceConfig?.channel),
    }),
    to: to || (existingConfig?.to ? null : undefined),
    ...(cooldownMs !== undefined
      ? { cooldownMs }
      : existingConfig?.cooldownMs !== undefined
        ? { cooldownMs: null }
        : {}),
    mode: form.failureAlertDeliveryMode || (existingConfig?.mode !== undefined ? null : undefined),
    accountId: accountId || (existingConfig?.accountId ? null : undefined),
    includeSkipped: sourceConfig?.includeSkipped,
  };
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

    const editingJob = state.cronEditingJob;
    const expectedConfigRevision = editingJob
      ? requireCronConfigRevision(state.cronEditingConfigRevision)
      : undefined;
    const editingPayload = editingJob ? getCronJobPayload(editingJob) : null;
    const sourceJob = editingJob ?? state.cronCloningJob;
    // Form fields cannot represent process commands, anchors, or full timestamp precision.
    const schedule =
      sourceJob && hasUnchangedCronSchedule(form, sourceJob)
        ? editingJob
          ? undefined
          : sourceJob.schedule
        : buildCronSchedule(form);
    const preserveLockedPayload = Boolean(
      editingJob && form.payloadLocked && isReadOnlyCronPayload(editingPayload),
    );
    const payload = preserveLockedPayload ? undefined : buildCronPayload(form);
    if (payload?.kind === "agentTurn" && editingJob && editingPayload?.kind === "agentTurn") {
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
                    preserveLast: Boolean(editingJob?.delivery?.channel),
                  })
                : undefined,
            to:
              form.deliveryTo.trim() ||
              (selectedDeliveryMode === "announce" && editingJob?.delivery?.to ? null : undefined),
            accountId: deliveryAccountId,
            bestEffort: form.deliveryBestEffort,
            ...(form.deliveryThreadId !== undefined ? { threadId: form.deliveryThreadId } : {}),
            ...(selectedDeliveryMode === "announce" && form.deliveryCompletionDestination
              ? { completionDestination: form.deliveryCompletionDestination }
              : {}),
            ...(form.deliveryFailureDestination
              ? { failureDestination: form.deliveryFailureDestination }
              : {}),
          }
        : selectedDeliveryMode === "none"
          ? ({
              mode: "none",
              ...(form.deliveryBestEffort ? { bestEffort: true } : {}),
              ...(form.deliveryThreadId !== undefined ? { threadId: form.deliveryThreadId } : {}),
              ...(form.deliveryFailureDestination
                ? { failureDestination: form.deliveryFailureDestination }
                : {}),
            } as const)
          : undefined;
    const failureAlert = buildFailureAlert(form, sourceJob?.failureAlert, Boolean(editingJob));
    const triggerScript = form.triggerScript.trim();
    const trigger = form.triggerEnabled
      ? editingJob?.trigger?.script === triggerScript &&
        (editingJob.trigger.once === true) === form.triggerOnce
        ? undefined
        : { script: triggerScript, once: form.triggerOnce }
      : editingJob?.trigger
        ? null
        : undefined;
    const agentId = form.clearAgent ? null : form.agentId.trim();
    const sessionKeyRaw = form.sessionKey.trim();
    const sessionKey = sessionKeyRaw || (editingJob?.sessionKey ? null : undefined);
    const job: Record<string, unknown> = {
      name: form.name.trim(),
      description: form.description.trim(),
      agentId: agentId === null ? null : agentId || undefined,
      sessionKey,
      enabled: form.enabled,
      ...(form.scheduleKind === "at" || form.scheduleKind === "on-exit"
        ? { deleteAfterRun: form.deleteAfterRun }
        : {}),
      sessionTarget: form.sessionTarget,
      wakeMode: form.wakeMode,
      trigger,
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
    if (editingJob) {
      const editedJobId = editingJob.id;
      try {
        const updatedJob = await client.request<CronJob>("cron.update", {
          id: editedJobId,
          expectedConfigRevision,
          patch: job,
        });
        replaceLocalCronJob(state, updatedJob);
        startCronEdit(state, updatedJob);
      } catch (error) {
        if (!isCronJobChangedError(error)) {
          throw error;
        }
        await reloadCronJobsSnapshot(state);
        try {
          const latestJob = await client.request<CronJob>("cron.get", { id: editedJobId });
          startCronEdit(state, latestJob);
          state.cronError =
            "This automation changed on the Gateway. The latest definition is loaded; review it before retrying.";
        } catch {
          state.cronError =
            "This automation changed on the Gateway, but the latest definition could not be loaded. Refresh before retrying.";
        }
        return;
      }
      result = { saved: true, jobId: editedJobId };
    } else {
      const response = await client.request("cron.add", job);
      resetCronFormToDefaults(state, agentId);
      result = { saved: true, jobId: extractSavedCronJobId(response) };
    }
    await reloadCronJobsSnapshot(state);
  });
  return result;
}

// Mutations reload the list and scheduler status so both canonical views stay current.
async function reloadCronJobsSnapshot(state: CronState) {
  await loadCronJobsPage(state, { tableFilters: true });
  await loadCronStatus(state);
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
    const updatedJob = await client.request<CronJob>("cron.update", {
      id: job.id,
      expectedConfigRevision: requireCronConfigRevision(job.configRevision),
      patch: { enabled },
    });
    replaceLocalCronJob(state, updatedJob);
    if (state.cronEditingJob?.id === updatedJob.id) {
      setCronEditState(state, updatedJob, {
        ...state.cronForm,
        enabled: updatedJob.enabled,
      });
    }
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
    if ("enqueued" in result && result.enqueued) {
      state.cronError = `Run queued. Run ID: ${result.runId}`;
    }
  });
}

export async function removeCronJob(state: CronState, job: CronJob) {
  await withCronBusy(state, async (client) => {
    await client.request("cron.remove", { id: job.id });
    const previousLength = state.cronJobs.length;
    state.cronJobs = state.cronJobs.filter((candidate) => candidate.id !== job.id);
    if (state.cronJobs.length !== previousLength) {
      state.cronJobsTotal = Math.max(0, state.cronJobsTotal - 1);
    }
    if (state.cronEditingJob?.id === job.id) {
      clearCronEditState(state);
    }
    if (state.cronRunsJobId === job.id) {
      state.cronRunsJobId = null;
      clearCronRunsPage(state);
    }
    await reloadCronJobsSnapshot(state);
  });
}

type CronRunsRequestIdentity = {
  client: GatewayBrowserClient;
  agentId: string | null;
  scope: CronRunScope;
  jobId: string | null;
  limit: number;
  offset: number;
  statuses: CronRunsStatusValue[];
  status: CronRunsStatusFilter;
  deliveryStatuses: CronDeliveryStatus[];
  query: string;
  sortDir: CronSortDir;
  append: boolean;
};

// The same state owns overview, per-job, filtered, and paginated requests.
// Only its latest exact request may replace the history, error, or load state.
const activeCronRunsRequests = new WeakMap<CronState, CronRunsRequestIdentity>();

function ownsCronRunsRequest(state: CronState, request: CronRunsRequestIdentity): boolean {
  return (
    activeCronRunsRequests.get(state) === request &&
    state.connected &&
    state.client === request.client &&
    state.cronAgentId === request.agentId &&
    state.cronRunsScope === request.scope &&
    (request.scope !== "job" || state.cronRunsJobId === request.jobId) &&
    state.cronRunsLimit === request.limit &&
    state.cronRunsStatusFilter === request.status &&
    state.cronRunsQuery.trim() === request.query &&
    state.cronRunsSortDir === request.sortDir &&
    state.cronRunsStatuses.length === request.statuses.length &&
    state.cronRunsStatuses.every((status, index) => status === request.statuses[index]) &&
    state.cronRunsDeliveryStatuses.length === request.deliveryStatuses.length &&
    state.cronRunsDeliveryStatuses.every(
      (status, index) => status === request.deliveryStatuses[index],
    ) &&
    (!request.append ||
      Math.max(0, state.cronRunsNextOffset ?? state.cronRuns.length) === request.offset)
  );
}

export async function loadCronRuns(
  state: CronState,
  jobId: string | null,
  opts?: { append?: boolean },
): Promise<CronRunsLoadStatus> {
  const client = state.client;
  if (!client || !state.connected) {
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
  const request: CronRunsRequestIdentity = {
    client,
    agentId: state.cronAgentId,
    scope,
    jobId: scope === "job" ? activeJobId : null,
    limit: state.cronRunsLimit,
    offset: append ? Math.max(0, state.cronRunsNextOffset ?? state.cronRuns.length) : 0,
    statuses: [...state.cronRunsStatuses],
    status: state.cronRunsStatusFilter,
    deliveryStatuses: [...state.cronRunsDeliveryStatuses],
    query: state.cronRunsQuery.trim(),
    sortDir: state.cronRunsSortDir,
    append,
  };
  activeCronRunsRequests.set(state, request);
  state.cronRunsLoadingMore = append;
  try {
    const res = await client.request<CronRunsResult>("cron.runs", {
      // An exact job owns its history; the overview's agent filter may select another owner.
      ...(request.scope === "all" && request.agentId ? { agentId: request.agentId } : {}),
      scope: request.scope,
      id: request.jobId ?? undefined,
      limit: request.limit,
      offset: request.offset,
      statuses: request.statuses.length > 0 ? request.statuses : undefined,
      status: request.status,
      deliveryStatuses: request.deliveryStatuses.length > 0 ? request.deliveryStatuses : undefined,
      query: request.query || undefined,
      sortDir: request.sortDir,
    });
    if (!ownsCronRunsRequest(state, request)) {
      return "skipped";
    }
    const entries = Array.isArray(res.entries) ? res.entries : [];
    state.cronRuns = append ? [...state.cronRuns, ...entries] : entries;
    const meta = normalizeCronRunsPageMeta({
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
    if (!ownsCronRunsRequest(state, request)) {
      return "skipped";
    }
    state.cronError = formatUiError(err);
    return "error";
  } finally {
    if (append && activeCronRunsRequests.get(state) === request) {
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

function setCronEditState(state: CronState, job: CronJob, form: CronFormState) {
  state.cronError = null;
  state.cronEditingJob = job;
  state.cronCloningJob = null;
  state.cronEditingJobId = job.id;
  state.cronEditingConfigRevision = job.configRevision ?? null;
  state.cronRunsJobId = job.id;
  state.cronForm = form;
  state.cronFieldErrors = validateCronForm(form);
}

export function startCronEdit(state: CronState, job: CronJob) {
  setCronEditState(state, job, jobToForm(job, state.cronForm));
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
  state.cronCloningJob = job;
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
  state.cronForm = normalizeCronFormState(cloned, { payloadKind: cloned.payloadKind });
  state.cronFieldErrors = validateCronForm(state.cronForm);
}

export function cancelCronEdit(state: CronState, agentId: string | null) {
  clearCronEditState(state);
  resetCronFormToDefaults(state, agentId);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
