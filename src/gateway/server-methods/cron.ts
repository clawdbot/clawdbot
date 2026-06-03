import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateCronAddParams,
  validateCronGetParams,
  validateCronListParams,
  validateCronRemoveParams,
  validateCronRunParams,
  validateCronRunsParams,
  validateCronStatusParams,
  validateCronUpdateParams,
  validateWakeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronDeliveryPreviews } from "../../cron/delivery-preview.js";
import { assertCronDeliveryInputNonBlankFields } from "../../cron/delivery-target-validation.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import {
  isInvalidCronRunLogJobIdError,
  readCronRunLogEntriesPage,
  readCronRunLogEntriesPageAll,
} from "../../cron/run-log.js";
import { applyJobPatch } from "../../cron/service/jobs.js";
import { isInvalidCronSessionTargetIdError } from "../../cron/session-target.js";
import type { CronDelivery, CronJob, CronJobCreate, CronJobPatch } from "../../cron/types.js";
import { validateScheduleTimestamp } from "../../cron/validate-timestamp.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  resolveTargetPrefixedChannel,
  validateTargetProviderPrefix,
} from "../../infra/outbound/channel-target-prefix.js";
import { listConfiguredAnnounceChannelIdsForConfig } from "../../plugins/channel-plugin-ids.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

type CronJobIdParams = { id?: string; jobId?: string };

type CronRunsRequestParams = CronJobIdParams & {
  scope?: "job" | "all";
  runId?: string;
  limit?: number;
  offset?: number;
  statuses?: Array<"ok" | "error" | "skipped">;
  status?: "all" | "ok" | "error" | "skipped";
  deliveryStatuses?: Array<"delivered" | "not-delivered" | "unknown" | "not-requested">;
  deliveryStatus?: "delivered" | "not-delivered" | "unknown" | "not-requested";
  query?: string;
  sortDir?: "asc" | "desc";
};

function listConfiguredAnnounceChannelIds(cfg: OpenClawConfig): string[] {
  return listConfiguredAnnounceChannelIdsForConfig({
    config: cfg,
    env: process.env,
  });
}

function assertConfiguredAnnounceChannel(params: {
  cfg: OpenClawConfig;
  channel?: string;
  field: "delivery.channel" | "delivery.failureDestination.channel";
}) {
  // `last` defers channel selection to runtime session context; every concrete
  // announce channel must be one the gateway can actually deliver through.
  if (params.channel === "last") {
    return;
  }

  const configuredChannels = listConfiguredAnnounceChannelIds(params.cfg).toSorted();
  const normalizedChannel = normalizeMessageChannel(params.channel);
  if (!normalizedChannel) {
    if (configuredChannels.length <= 1) {
      return;
    }
    throw new Error(
      `${params.field} is required when multiple channels are configured: ${configuredChannels.join(", ")}`,
    );
  }

  if (configuredChannels.length === 0) {
    return;
  }

  if (configuredChannels.includes(normalizedChannel)) {
    return;
  }

  throw new Error(`${params.field} must be one of: ${configuredChannels.join(", ")}`);
}

function resolveAnnounceValidationChannel(params: {
  channel?: string;
  to?: string;
}): string | undefined {
  // A target like `telegram:...` is enough to validate the announce channel
  // even when the explicit channel field is omitted.
  if (params.channel && params.channel !== "last") {
    return params.channel;
  }
  return resolveTargetPrefixedChannel(params.to) ?? params.channel;
}

function assertCompatibleAnnounceTarget(params: {
  channel?: string;
  to?: string;
  field: "delivery.channel" | "delivery.failureDestination.channel";
}) {
  if (!params.channel || params.channel === "last") {
    return;
  }
  const error = validateTargetProviderPrefix({
    channel: params.channel,
    to: params.to,
  });
  if (error) {
    throw new Error(`${params.field}: ${error.message}`);
  }
}

function assertValidCronAnnounceDelivery(params: { cfg: OpenClawConfig; delivery?: CronDelivery }) {
  if (params.delivery && (params.delivery.mode ?? "announce") === "announce") {
    assertCompatibleAnnounceTarget({
      channel: params.delivery.channel,
      to: params.delivery.to,
      field: "delivery.channel",
    });
    assertConfiguredAnnounceChannel({
      cfg: params.cfg,
      channel: resolveAnnounceValidationChannel({
        channel: params.delivery.channel,
        to: params.delivery.to,
      }),
      field: "delivery.channel",
    });
  }

  const failureDestination = params.delivery?.failureDestination;
  if (failureDestination && (failureDestination.mode ?? "announce") === "announce") {
    if (
      failureDestination.channel === undefined &&
      failureDestination.to === undefined &&
      failureDestination.accountId === undefined &&
      failureDestination.mode === undefined
    ) {
      return;
    }
    assertCompatibleAnnounceTarget({
      channel: failureDestination.channel,
      to: failureDestination.to,
      field: "delivery.failureDestination.channel",
    });
    assertConfiguredAnnounceChannel({
      cfg: params.cfg,
      channel: resolveAnnounceValidationChannel({
        channel: failureDestination.channel,
        to: failureDestination.to,
      }),
      field: "delivery.failureDestination.channel",
    });
  }
}

function assertValidCronCreateDelivery(cfg: OpenClawConfig, jobCreate: CronJobCreate) {
  assertValidCronAnnounceDelivery({
    cfg,
    delivery: jobCreate.delivery,
  });
}

function assertValidCronUpdatePatch(params: {
  cfg: OpenClawConfig;
  defaultAgentId?: string;
  currentJob: CronJob;
  patch: CronJobPatch;
}) {
  // Apply the full patch so service-owned payload/session constraints are
  // checked before mutation; configured-channel checks stay delivery-scoped so
  // stale existing delivery does not block unrelated updates like disabling.
  const nextJob = structuredClone(params.currentJob);
  applyJobPatch(nextJob, params.patch, {
    defaultAgentId: params.defaultAgentId,
  });
  if ("delivery" in params.patch) {
    assertValidCronAnnounceDelivery({
      cfg: params.cfg,
      delivery: nextJob.delivery,
    });
  }
}

function resolveCronJobId(params: CronJobIdParams): string | undefined {
  return params.id ?? params.jobId;
}

function respondInvalidCronParams(respond: RespondFn, method: string, reason: string): void {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${method} params: ${reason}`),
  );
}

function respondMissingCronJobId(respond: RespondFn, method: string): void {
  respondInvalidCronParams(respond, method, "missing id");
}

function cronRunLogPageFilters(params: CronRunsRequestParams) {
  return {
    limit: params.limit,
    offset: params.offset,
    statuses: params.statuses,
    status: params.status,
    runId: params.runId,
    deliveryStatuses: params.deliveryStatuses,
    deliveryStatus: params.deliveryStatus,
    query: params.query,
    sortDir: params.sortDir,
  };
}

function isCronInvalidRequestError(err: unknown): boolean {
  const message = formatErrorMessage(err);
  return (
    message.startsWith("unknown cron job id:") ||
    message.includes("cron job is missing sessionTarget") ||
    message.includes("invalid cron sessionTarget session id") ||
    message.includes('main cron jobs require payload.kind="systemEvent"') ||
    message.includes('isolated/current/session cron jobs require payload.kind="agentTurn"') ||
    message.includes('sessionTarget "main" is only valid for the default agent') ||
    message.includes('cron.update payload.kind="systemEvent" requires text') ||
    message.includes('cron.update payload.kind="agentTurn" requires message') ||
    message.includes("cron webhook delivery requires") ||
    message.includes("cron completion destination webhook requires") ||
    message.includes("cron failure destination webhook requires") ||
    message.includes("cron channel delivery config is only supported") ||
    message.includes("cron delivery.failureDestination is only supported")
  );
}

export const cronHandlers: GatewayRequestHandlers = {
  wake: ({ params, respond, context }) => {
    if (!validateWakeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid wake params: ${formatValidationErrors(validateWakeParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      mode: "now" | "next-heartbeat";
      text: string;
      sessionKey?: string;
    };
    const sessionKey = p.sessionKey?.trim() || undefined;
    if (sessionKey && isSubagentSessionKey(sessionKey)) {
      // Wake requests resume user-visible sessions only; subagent sessions are
      // internal task execution targets and should not receive operator wakes.
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "wake sessionKey cannot target a subagent session"),
      );
      return;
    }
    const result = context.cron.wake({
      mode: p.mode,
      text: p.text,
      ...(sessionKey ? { sessionKey } : {}),
    });
    respond(true, result, undefined);
  },
  "cron.list": async ({ params, respond, context }) => {
    if (!validateCronListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.list params: ${formatValidationErrors(validateCronListParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      includeDisabled?: boolean;
      limit?: number;
      offset?: number;
      query?: string;
      enabled?: "all" | "enabled" | "disabled";
      scheduleKind?: "all" | "at" | "every" | "cron";
      lastRunStatus?: "all" | "ok" | "error" | "skipped" | "unknown";
      sortBy?: "nextRunAtMs" | "updatedAtMs" | "name";
      sortDir?: "asc" | "desc";
      agentId?: string;
    };
    const page = await context.cron.listPage({
      includeDisabled: p.includeDisabled,
      limit: p.limit,
      offset: p.offset,
      query: p.query,
      enabled: p.enabled,
      scheduleKind: p.scheduleKind,
      lastRunStatus: p.lastRunStatus,
      sortBy: p.sortBy,
      sortDir: p.sortDir,
      agentId: p.agentId,
    });
    const deliveryPreviews = await resolveCronDeliveryPreviews({
      cfg: context.getRuntimeConfig(),
      defaultAgentId: context.cron.getDefaultAgentId(),
      jobs: page.jobs,
    });
    respond(true, { ...page, deliveryPreviews }, undefined);
  },
  "cron.status": async ({ params, respond, context }) => {
    if (!validateCronStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.status params: ${formatValidationErrors(validateCronStatusParams.errors)}`,
        ),
      );
      return;
    }
    const status = await context.cron.status();
    respond(true, status, undefined);
  },
  "cron.get": async ({ params, respond, context }) => {
    if (!validateCronGetParams(params)) {
      respondInvalidCronParams(
        respond,
        "cron.get",
        formatValidationErrors(validateCronGetParams.errors),
      );
      return;
    }
    const jobId = resolveCronJobId(params as CronJobIdParams);
    if (!jobId) {
      respondMissingCronJobId(respond, "cron.get");
      return;
    }
    const job = await context.cron.readJob(jobId);
    if (!job) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `cron job not found: ${jobId}`),
      );
      return;
    }
    respond(true, job, undefined);
  },
  "cron.add": async ({ params, respond, context }) => {
    const sessionKey =
      typeof (params as { sessionKey?: unknown } | null)?.sessionKey === "string"
        ? (params as { sessionKey: string }).sessionKey
        : undefined;
    let normalized: unknown;
    try {
      assertCronDeliveryInputNonBlankFields((params as { delivery?: unknown } | null)?.delivery);
      normalized =
        normalizeCronJobCreate(params, {
          sessionContext: { sessionKey },
        }) ?? params;
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.add params: ${formatErrorMessage(err)}`,
        ),
      );
      return;
    }
    if (!validateCronAddParams(normalized)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.add params: ${formatValidationErrors(validateCronAddParams.errors)}`,
        ),
      );
      return;
    }
    const jobCreate = normalized as unknown as CronJobCreate;
    const cfg = context.getRuntimeConfig();
    const timestampValidation = validateScheduleTimestamp(jobCreate.schedule);
    if (!timestampValidation.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message),
      );
      return;
    }
    try {
      assertValidCronCreateDelivery(cfg, jobCreate);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.add params: ${formatErrorMessage(err)}`,
        ),
      );
      return;
    }
    let job: Awaited<ReturnType<typeof context.cron.add>>;
    try {
      job = await context.cron.add(jobCreate);
    } catch (err) {
      if (
        !(err instanceof TypeError) &&
        !(err instanceof RangeError) &&
        !isCronInvalidRequestError(err)
      ) {
        throw err;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.add params: ${formatErrorMessage(err)}`,
        ),
      );
      return;
    }
    context.logGateway.info("cron: job created", { jobId: job.id, schedule: jobCreate.schedule });
    respond(true, job, undefined);
  },
  "cron.update": async ({ params, respond, context }) => {
    let normalizedPatch: ReturnType<typeof normalizeCronJobPatch>;
    try {
      const rawPatch = (params as { patch?: unknown } | null)?.patch;
      assertCronDeliveryInputNonBlankFields(
        rawPatch && typeof rawPatch === "object"
          ? (rawPatch as { delivery?: unknown }).delivery
          : undefined,
      );
      normalizedPatch = normalizeCronJobPatch(rawPatch);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.update params: ${formatErrorMessage(err)}`,
        ),
      );
      return;
    }
    const candidate =
      normalizedPatch && typeof params === "object" && params !== null
        ? { ...params, patch: normalizedPatch }
        : params;
    if (!validateCronUpdateParams(candidate)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.update params: ${formatValidationErrors(validateCronUpdateParams.errors)}`,
        ),
      );
      return;
    }
    const p = candidate as {
      id?: string;
      jobId?: string;
      patch: Record<string, unknown>;
    };
    const jobId = p.id ?? p.jobId;
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.update params: missing id"),
      );
      return;
    }
    const patch = p.patch as unknown as CronJobPatch;
    const cfg = context.getRuntimeConfig();
    const currentJob = await context.cron.readJob(jobId);
    if (!currentJob) {
      respondInvalidCronParams(respond, "cron.update", "id not found");
      return;
    }
    if (patch.schedule) {
      const timestampValidation = validateScheduleTimestamp(patch.schedule);
      if (!timestampValidation.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message),
        );
        return;
      }
    }
    try {
      assertValidCronUpdatePatch({
        cfg,
        defaultAgentId: context.cron.getDefaultAgentId(),
        currentJob,
        patch,
      });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.update params: ${formatErrorMessage(err)}`,
        ),
      );
      return;
    }
    let job: Awaited<ReturnType<typeof context.cron.update>>;
    try {
      job = await context.cron.update(jobId, patch);
    } catch (err) {
      if (
        !(err instanceof TypeError) &&
        !(err instanceof RangeError) &&
        !isCronInvalidRequestError(err)
      ) {
        throw err;
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.update params: ${formatErrorMessage(err)}`,
        ),
      );
      return;
    }
    context.logGateway.info("cron: job updated", { jobId });
    respond(true, job, undefined);
  },
  "cron.remove": async ({ params, respond, context }) => {
    if (!validateCronRemoveParams(params)) {
      respondInvalidCronParams(
        respond,
        "cron.remove",
        formatValidationErrors(validateCronRemoveParams.errors),
      );
      return;
    }
    const jobId = resolveCronJobId(params as CronJobIdParams);
    if (!jobId) {
      respondMissingCronJobId(respond, "cron.remove");
      return;
    }
    const result = await context.cron.remove(jobId);
    if (!result.removed) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.remove params: id not found"),
      );
      return;
    }
    context.logGateway.info("cron: job removed", { jobId });
    respond(true, result, undefined);
  },
  "cron.run": async ({ params, respond, context }) => {
    if (!validateCronRunParams(params)) {
      respondInvalidCronParams(
        respond,
        "cron.run",
        formatValidationErrors(validateCronRunParams.errors),
      );
      return;
    }
    const p = params as CronJobIdParams & { mode?: "due" | "force" };
    const jobId = resolveCronJobId(p);
    if (!jobId) {
      respondMissingCronJobId(respond, "cron.run");
      return;
    }
    let result: Awaited<ReturnType<typeof context.cron.enqueueRun>>;
    try {
      result = await context.cron.enqueueRun(jobId, p.mode ?? "force");
    } catch (error) {
      if (isInvalidCronSessionTargetIdError(error)) {
        respond(true, { ok: true, ran: false, reason: "invalid-spec" }, undefined);
        return;
      }
      if (isCronInvalidRequestError(error)) {
        respondInvalidCronParams(respond, "cron.run", formatErrorMessage(error));
        return;
      }
      throw error;
    }
    respond(true, result, undefined);
  },
  "cron.runs": async ({ params, respond, context }) => {
    if (!validateCronRunsParams(params)) {
      respondInvalidCronParams(
        respond,
        "cron.runs",
        formatValidationErrors(validateCronRunsParams.errors),
      );
      return;
    }
    const p = params as CronRunsRequestParams;
    const explicitScope = p.scope;
    const jobId = resolveCronJobId(p);
    const scope: "job" | "all" = explicitScope ?? (jobId ? "job" : "all");
    if (scope === "job" && !jobId) {
      respondMissingCronJobId(respond, "cron.runs");
      return;
    }
    if (scope === "all") {
      const jobs = await context.cron.list({ includeDisabled: true });
      const jobNameById = Object.fromEntries(
        jobs
          .filter((job) => typeof job.id === "string" && typeof job.name === "string")
          .map((job) => [job.id, job.name]),
      );
      const page = await readCronRunLogEntriesPageAll({
        storePath: context.cronStorePath,
        ...cronRunLogPageFilters(p),
        jobNameById,
      });
      respond(true, page, undefined);
      return;
    }
    try {
      const jobs = await context.cron.list({ includeDisabled: true });
      const matchedJob = jobs.find((job) => job.id === jobId);
      const jobNameById =
        matchedJob && typeof matchedJob.name === "string"
          ? { [jobId as string]: matchedJob.name }
          : undefined;
      const page = await readCronRunLogEntriesPage({
        storePath: context.cronStorePath,
        jobId: jobId as string,
        ...cronRunLogPageFilters(p),
        jobNameById,
      });
      respond(true, page, undefined);
    } catch (err) {
      if (!isInvalidCronRunLogJobIdError(err)) {
        throw err;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.runs params: invalid id"),
      );
    }
  },
};
