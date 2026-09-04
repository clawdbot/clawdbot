// Gateway RPC handlers for cron job CRUD, run logs, wake, and delivery previews.
import { parseBoolean } from "@openclaw/normalization-core/boolean-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  type CronListParams,
  ErrorCodes,
  errorShape,
  GatewayErrorDetailCodes,
  validateCronAddParams,
  validateCronGetParams,
  validateCronListParams,
  validateCronRemoveParams,
  validateCronRunParams,
  validateCronRunsParams,
  validateCronScratchGetParams,
  validateCronScratchSetParams,
  validateCronStatusParams,
  validateCronUpdateParams,
  validateWakeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronJobConfigRevision } from "../../cron/config-revision.js";
import {
  assertValidCronAnnounceDelivery,
  assertValidCronCreateDelivery,
  assertValidCronFailureAlert,
} from "../../cron/delivery-channel-validation.js";
import {
  resolveCronDeliveryPreview,
  resolveCronDeliveryPreviews,
} from "../../cron/delivery-preview.js";
import { assertCronDeliveryInputNonBlankFields } from "../../cron/delivery-target-validation.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import { toPublicCronJob } from "../../cron/public-job.js";
import type { CronRuntimeAuthority } from "../../cron/runtime-authority.js";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "../../cron/scratch-contract.js";
import { resolveFailureAlert } from "../../cron/service/failure-alerts.js";
import { applyJobPatch } from "../../cron/service/jobs.js";
import {
  isInvalidCronSessionTargetIdError,
  resolveCronSessionTargetSessionKey,
} from "../../cron/session-target.js";
import { cronStoreKey } from "../../cron/store/key.js";
import {
  isInvalidCronTaskRunJobIdError,
  readCronTaskRunHistoryPage,
} from "../../cron/task-run-history.js";
import { cronJobUsesToolRuntime } from "../../cron/tools-allow.js";
import type {
  CronDeliveryPreview,
  CronJob,
  CronJobCreate,
  CronJobPatch,
} from "../../cron/types.js";
import { validateScheduleTimestamp } from "../../cron/validate-timestamp.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveTargetPrefixedChannel } from "../../infra/outbound/channel-target-prefix.js";
import { isSubagentSessionKey, normalizeAgentId } from "../../routing/session-key.js";
import {
  AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
  AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
  isAgentHarnessSessionKey,
  resolveAgentHarnessSessionStoreEntryError,
} from "../../sessions/agent-harness-session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  consumeCronCreatorAuthorityGrant,
  getCronManagementAuthority,
  withCronManagementGrant,
} from "../cron-creator-authority-grant.js";
import { authorizeGatewaySessionCreation, operatorSessionCap } from "../operator-role-policy.js";
import { getGatewayProcessInstanceId } from "../process-instance.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { createSessionListEntryFilter } from "../session-sharing.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import { assertActiveAgentRuntimeAuthority } from "./agent-runtime-authority.js";
import {
  applyCronCreateCallerScopeDefault,
  cronCreateMatchesCallerScope,
  cronJobMatchesDeclarationScope,
  cronJobMatchesCallerScope,
  cronPatchSessionRefsMatchCaller,
  readCronCallerScope,
  resolveCronScheduledToolPolicyForCaller,
  type CronCallerScope,
} from "./cron-caller-scope.js";
import { isCronInvalidRequestError } from "./cron-error-classification.js";
import { listCronPageWithVisibility } from "./cron-list-caller-scope.js";
import { cronRunLogPageFilters, filterCronRunLogJobsByAgent } from "./cron-run-log-filters.js";
import { resolveOperatorSessionCreation } from "./session-creation-provenance.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { assertValidParams } from "./validation.js";

type CronJobIdParams = { id?: string; jobId?: string };

function resolveCronCreatorAuthorityCapture(
  callerScope: CronCallerScope | undefined,
): (() => CronRuntimeAuthority | undefined) | undefined {
  const grant = callerScope?.cronCreatorAuthorityGrant;
  if (!grant) {
    return undefined;
  }
  if (!callerScope.toolsAllowProvenance) {
    throw new TypeError("cron creator authority grant is missing tool-surface provenance");
  }
  return () => consumeCronCreatorAuthorityGrant(grant);
}

function resolveCronMutationCommitGuard(
  client: GatewayClient | null,
  context: GatewayRequestContext,
  jobScope?: {
    callerScope: CronCallerScope | undefined;
    jobId: string;
    allowCurrentJob?: boolean;
    expectedConfigRevision?: string;
  },
): (() => void) | undefined {
  const validatesAuthority =
    client?.internal?.agentRuntimeIdentity && context.validateAgentRuntimeApprovalAuthority;
  const identity = client?.internal?.agentRuntimeIdentity;
  const manageAll = identity ? getCronManagementAuthority(identity) : undefined;
  if (!validatesAuthority && !jobScope?.callerScope && !manageAll) {
    return undefined;
  }
  return () => {
    manageAll?.();
    if (validatesAuthority) {
      assertActiveAgentRuntimeAuthority(client, context);
    }
    if (!jobScope?.callerScope) {
      return;
    }
    // The capability can expire, or the same id can acquire another owner while
    // this request waits for the cron lock. Re-read both at the commit owner.
    const callerScope = readCronCallerScope(client);
    const job = context.cron.getJob(jobScope.jobId);
    if (
      !callerScope ||
      !job ||
      (jobScope.expectedConfigRevision !== undefined &&
        resolveCronJobConfigRevision(job) !== jobScope.expectedConfigRevision) ||
      !cronJobMatchesCallerScope({
        job,
        callerScope,
        defaultAgentId: context.cron.getDefaultAgentId(),
        allowCurrentJob: jobScope.allowCurrentJob,
      })
    ) {
      throw new TypeError(`unknown cron job id: ${jobScope.jobId}`);
    }
  };
}

type CronRunsRequestParams = CronJobIdParams & {
  agentId?: string;
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

class CronJobConfigRevisionConflictError extends Error {
  constructor(
    readonly expectedConfigRevision: string,
    readonly actualConfigRevision: string,
  ) {
    super("cron job definition no longer matches the loaded version");
  }
}

// Migration provenance (sourceSha256) stays internal; the closed result schema
// exposes only content/revision/updatedAtMs.
function publicCronScratch(
  scratch: { content: string; revision: number; updatedAtMs: number } | undefined,
) {
  if (!scratch) {
    return null;
  }
  return {
    content: scratch.content,
    revision: scratch.revision,
    updatedAtMs: scratch.updatedAtMs,
  };
}

function cronJobReadView(job: CronJob) {
  const publicJob = toPublicCronJob(job);
  return {
    ...publicJob,
    configRevision: resolveCronJobConfigRevision(job),
    nextRunAtMs: job.state.nextRunAtMs,
    lastRunAtMs: job.state.lastRunAtMs,
    lastRunStatus: job.state.lastRunStatus ?? job.state.lastStatus,
    lastRunError: job.state.lastError,
    lastDelivered: job.state.lastDelivered,
    lastDeliveryStatus: job.state.lastDeliveryStatus,
    lastDeliveryError: job.state.lastDeliveryError,
    deliverySuppressionReason: job.state.deliverySuppressionReason,
    lastFailureNotificationDelivered: job.state.lastFailureNotificationDelivered,
    lastFailureNotificationDeliveryStatus: job.state.lastFailureNotificationDeliveryStatus,
    lastFailureNotificationDeliveryError: job.state.lastFailureNotificationDeliveryError,
  };
}

function cronAddPayloadWithDeliveryPreview(params: {
  result: CronJob | { created: boolean; updated?: boolean; job: CronJob };
  deliveryPreview: CronDeliveryPreview;
}) {
  const job = "job" in params.result ? params.result.job : params.result;
  if ("job" in params.result) {
    return {
      created: params.result.created,
      ...(params.result.updated === undefined ? {} : { updated: params.result.updated }),
      job: cronJobReadView(job),
      deliveryPreview: params.deliveryPreview,
    };
  }
  return {
    ...cronJobReadView(job),
    deliveryPreview: params.deliveryPreview,
  };
}

function compactCronListJob(job: CronJob) {
  // Optional declaration/delivery fields are omitted when unset so compact
  // rows stay lean for the common undeclared job.
  return {
    id: job.id,
    name: job.name,
    ...(job.declarationKey ? { declarationKey: job.declarationKey } : {}),
    ...(job.displayName ? { displayName: job.displayName } : {}),
    ...(job.owner ? { owner: job.owner } : {}),
    enabled: job.enabled,
    nextRunAtMs: job.state.nextRunAtMs ?? null,
    scheduleKind: job.schedule.kind,
    ...(job.trigger ? { trigger: true } : {}),
    lastRunAtMs: job.state.lastRunAtMs ?? null,
    lastRunStatus: job.state.lastRunStatus ?? job.state.lastStatus ?? null,
    lastRunError: job.state.lastError ?? null,
    ...(job.state.lastDelivered !== undefined ? { lastDelivered: job.state.lastDelivered } : {}),
    ...(job.state.lastDeliveryStatus !== undefined
      ? { lastDeliveryStatus: job.state.lastDeliveryStatus }
      : {}),
    ...(job.state.lastDeliveryError !== undefined
      ? { lastDeliveryError: job.state.lastDeliveryError }
      : {}),
    ...(job.state.deliverySuppressionReason !== undefined
      ? { deliverySuppressionReason: job.state.deliverySuppressionReason }
      : {}),
    ...(job.state.lastFailureNotificationDelivered !== undefined
      ? { lastFailureNotificationDelivered: job.state.lastFailureNotificationDelivered }
      : {}),
    ...(job.state.lastFailureNotificationDeliveryStatus !== undefined
      ? { lastFailureNotificationDeliveryStatus: job.state.lastFailureNotificationDeliveryStatus }
      : {}),
    ...(job.state.lastFailureNotificationDeliveryError !== undefined
      ? { lastFailureNotificationDeliveryError: job.state.lastFailureNotificationDeliveryError }
      : {}),
  };
}

async function assertValidCronUpdatePatch(params: {
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
    cronConfig: params.cfg.cron,
  });
  if (
    "agentId" in params.patch ||
    "sessionTarget" in params.patch ||
    "sessionKey" in params.patch
  ) {
    assertCronDoesNotTargetAgentHarness(nextJob);
  }
  // Clearing a concrete channel (channel: null) while keeping a bare announce `to`
  // intentionally falls back to "last" in multi-channel configs. Use the same
  // adjusted delivery for both the delivery check and the inherited-alert check so
  // an alert that inherits the route is judged identically to the delivery itself.
  const effectiveDelivery =
    params.patch.delivery?.channel === null &&
    nextJob.delivery &&
    (nextJob.delivery.mode ?? "announce") === "announce" &&
    nextJob.delivery.channel === undefined &&
    resolveTargetPrefixedChannel(nextJob.delivery.to) === undefined
      ? { ...nextJob.delivery, channel: "last" as const }
      : nextJob.delivery;
  if ("delivery" in params.patch) {
    await assertValidCronAnnounceDelivery({
      cfg: params.cfg,
      delivery: effectiveDelivery,
    });
  }
  // Compare the canonical before/after policy so route-changing edits are
  // validated without blocking threshold-only edits on legacy stored channels.
  const failureAlertPatch = params.patch.failureAlert;
  const failureAlertRoutingPatched =
    failureAlertPatch &&
    ("channel" in failureAlertPatch || "to" in failureAlertPatch || "mode" in failureAlertPatch);
  const currentAlert = resolveFailureAlert(
    { deps: { cronConfig: params.cfg.cron } },
    params.currentJob,
  );
  const nextAlert = resolveFailureAlert(
    { deps: { cronConfig: params.cfg.cron } },
    { ...nextJob, delivery: effectiveDelivery },
  );
  const alertNewlyEnabled = currentAlert === null && nextAlert !== null;
  const alertRouteChanged =
    currentAlert?.mode !== nextAlert?.mode ||
    currentAlert?.channel !== nextAlert?.channel ||
    currentAlert?.to !== nextAlert?.to ||
    currentAlert?.accountId !== nextAlert?.accountId ||
    currentAlert?.threadId !== nextAlert?.threadId;
  if (
    failureAlertRoutingPatched ||
    alertNewlyEnabled ||
    (alertRouteChanged && (params.patch.delivery !== undefined || failureAlertPatch === null))
  ) {
    await assertValidCronFailureAlert({
      cfg: params.cfg,
      failureAlert: nextJob.failureAlert,
      delivery: effectiveDelivery,
    });
  }
  return nextJob;
}

function requiresExplicitAgentRuntimeToolsAllow(params: {
  job: Pick<CronJob, "payload" | "trigger">;
  callerScope: CronCallerScope | undefined;
}): boolean {
  return (
    params.callerScope !== undefined &&
    !params.callerScope.manageAll &&
    cronJobUsesToolRuntime(params.job) &&
    params.job.payload.toolsAllow === undefined
  );
}

function cronPatchTouchesToolRuntime(patch: CronJobPatch): boolean {
  return patch.payload !== undefined || Object.hasOwn(patch, "trigger");
}

function assertCronDoesNotTargetAgentHarness(input: {
  agentId?: string | null;
  sessionTarget?: string | null;
  sessionKey?: string | null;
}): void {
  const targetSessionKey =
    resolveCronSessionTargetSessionKey(input.sessionTarget) ??
    (input.sessionTarget === "current" ? input.sessionKey?.trim() : undefined);
  if (!targetSessionKey) {
    return;
  }

  const loaded = loadGatewaySessionEntryReadOnly(
    targetSessionKey,
    input.agentId?.trim() ? { agentId: input.agentId.trim() } : {},
  );
  const reservedKey =
    isAgentHarnessSessionKey(targetSessionKey) || isAgentHarnessSessionKey(loaded.canonicalKey);
  if (loaded.entry?.modelSelectionLocked === true) {
    // Detached cron execution is a generic model path and cannot preserve a
    // harness-owned runtime lock, even when the durable row uses an ordinary key.
    throw new Error(
      reservedKey
        ? AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE
        : AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
    );
  }
  if (!reservedKey || loaded.entry) {
    // `harness:*` was historically a valid public key. Preserve an existing
    // unlocked row while reserving missing keys for trusted harness creation.
    return;
  }

  // Cron's detached runner does not carry the owning harness lock. Harness
  // execution targets must enter through ordinary session dispatch instead.
  throw new Error(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);
}

function resolveCronJobId(params: CronJobIdParams): string | undefined {
  // Exact store lookups; clipboard/UI padding must not fake "id not found".
  return normalizeOptionalString(params.id ?? params.jobId);
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

function respondCronJobNotFound(
  respond: RespondFn,
  jobId: string,
  options: { preserveCronGetWireMessage?: boolean } = {},
): void {
  const message = options.preserveCronGetWireMessage
    ? `cron job not found: ${jobId}. List automations and retry with a current job id.`
    : `Automation not found: ${jobId}. List automations and retry with a current job id.`;
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `${message} For cross-session management, use a fresh authenticated Control UI administrator turn or the Automations page.`,
      {
        details: { code: GatewayErrorDetailCodes.CRON_JOB_NOT_FOUND, jobId },
      },
    ),
  );
}

type CronSessionVisibility = (sessionKey: string, agentId?: string) => boolean;

function resolveCronSessionVisibility(
  client: GatewayClient | null,
  cfg: OpenClawConfig,
): CronSessionVisibility | undefined {
  const identity = client?.internal?.agentRuntimeIdentity;
  if (identity && getCronManagementAuthority(identity)) {
    return undefined;
  }
  if (operatorSessionCap(client, cfg) !== "none") {
    return undefined;
  }
  const entryFilter = createSessionListEntryFilter({ client, cfg });
  if (!entryFilter) {
    return undefined;
  }
  return (sessionKey, agentId) => {
    const loaded = loadGatewaySessionEntryReadOnly(sessionKey, agentId ? { agentId } : undefined);
    return loaded.entry !== undefined && entryFilter(loaded.canonicalKey, loaded.entry);
  };
}

function cronJobIsVisible(
  job: CronJob,
  visibility: CronSessionVisibility | undefined,
  defaultAgentId: string | undefined,
): boolean {
  if (!visibility) {
    return true;
  }
  const sessionKey =
    job.owner?.sessionKey ??
    resolveCronSessionTargetSessionKey(job.sessionTarget) ??
    job.sessionKey;
  return Boolean(
    sessionKey && visibility(sessionKey, job.owner?.agentId ?? job.agentId ?? defaultAgentId),
  );
}

/** Gateway request handlers for cron jobs and cron run-log access. */
export const cronHandlers: GatewayRequestHandlers = {
  wake: async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateWakeParams, "wake", respond)) {
      return;
    }
    // Caller-supplied sessionKey / agentId thread through to `cron.wake` so
    // multi-session deployments wake the originating conversation lane
    // instead of the heartbeat / main default. Empty strings are dropped
    // (schema permits omission; presence with empty payload should not
    // override the default).
    const p = params as {
      mode: "now" | "next-heartbeat";
      text: string;
      sessionKey?: string;
      agentId?: string;
    };
    const sessionKey = p.sessionKey?.trim() || undefined;
    const agentId = p.agentId?.trim() || undefined;
    const callerScope = readCronCallerScope(client);
    const requestedOwner = sessionKey
      ? resolveRequestedSessionAgentId(
          context.getRuntimeConfig(),
          sessionKey,
          agentId ?? callerScope?.agentId,
        )
      : undefined;
    if (requestedOwner && !requestedOwner.ok) {
      respond(false, undefined, requestedOwner.error);
      return;
    }
    const resolvedAgentId = requestedOwner?.agentId ?? callerScope?.agentId ?? agentId;
    if (sessionKey && isAgentHarnessSessionKey(sessionKey)) {
      const loaded = loadGatewaySessionEntryReadOnly(
        sessionKey,
        resolvedAgentId ? { agentId: resolvedAgentId } : {},
      );
      const harnessSessionError = loaded.entry
        ? resolveAgentHarnessSessionStoreEntryError(loaded.canonicalKey, loaded.entry)
        : AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE;
      if (harnessSessionError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, harnessSessionError));
        return;
      }
    }
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
    // The resolver normalizes agent ids. Reject conflicting raw spellings too,
    // so an explicitly named target is never silently rewritten.
    const sessionKeyAgentId = sessionKey
      ? parseAgentSessionKey(sessionKey)?.agentId?.trim().toLowerCase()
      : undefined;
    if (callerScope && agentId && normalizeAgentId(agentId) !== callerScope.agentId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "wake agentId outside caller scope"),
      );
      return;
    }
    if (agentId && sessionKeyAgentId && agentId.toLowerCase() !== sessionKeyAgentId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "wake agentId contradicts the agent that owns sessionKey; pass a single canonical wake target",
        ),
      );
      return;
    }
    const wakeConfig = context.getRuntimeConfig();
    // Resolving a default wake agent can fail; role-free requests must retain their existing path.
    if (wakeConfig.gateway?.roles) {
      const knownWakeAgentId = resolvedAgentId ?? context.cron.getDefaultAgentId();
      const wakeAgent = knownWakeAgentId
        ? { ok: true as const, agentId: knownWakeAgentId }
        : resolveRequestedSessionAgentId(wakeConfig, sessionKey ?? "main");
      if (!wakeAgent.ok) {
        respond(false, undefined, wakeAgent.error);
        return;
      }
      const wakeAccessError = authorizeGatewaySessionCreation({
        cfg: wakeConfig,
        client,
        agentId: wakeAgent.agentId,
      });
      if (wakeAccessError) {
        respond(false, undefined, wakeAccessError);
        return;
      }
    }
    // Gateway becomes request-ready before scheduled services start; load the
    // wake owner first so an early operator event cannot disappear on cold start.
    await context.cron.prepareWake?.();
    assertActiveAgentRuntimeAuthority(client, context);
    const result = context.cron.wake({
      mode: p.mode,
      text: p.text,
      ...(sessionKey ? { sessionKey } : {}),
      ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
    });
    respond(true, result, undefined);
  },
  "cron.list": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateCronListParams, "cron.list", respond)) {
      return;
    }
    const p = params as CronListParams;
    const admittedScope = readCronCallerScope(client);
    const callerScope = admittedScope?.manageAll ? undefined : admittedScope;
    const requestedAgentId = p.agentId ? normalizeAgentId(p.agentId) : undefined;
    if (callerScope && requestedAgentId && requestedAgentId !== callerScope.agentId) {
      respondInvalidCronParams(respond, "cron.list", "agentId outside caller scope");
      return;
    }
    const listOptions = {
      includeDisabled: p.includeDisabled,
      limit: p.limit,
      offset: p.offset,
      query: p.query,
      enabled: p.enabled,
      scheduleKind: p.scheduleKind,
      lastRunStatus: p.lastRunStatus,
      trigger: p.trigger,
      sortBy: p.sortBy,
      sortDir: p.sortDir,
      // Owners retain visibility when execution is retargeted to another agent.
      agentId: callerScope ? undefined : p.agentId,
    };
    const cronVisibility = resolveCronSessionVisibility(client, context.getRuntimeConfig());
    const defaultAgentId = context.cron.getDefaultAgentId();
    const page =
      callerScope || cronVisibility
        ? await listCronPageWithVisibility({
            context,
            options: listOptions,
            matchesJob: (job) =>
              cronJobMatchesCallerScope({
                job,
                callerScope,
                defaultAgentId,
                allowCurrentJob: true,
              }) && cronJobIsVisible(job, cronVisibility, defaultAgentId),
          })
        : await context.cron.listPage(listOptions);
    if (p.compact === true) {
      respond(true, { ...page, jobs: page.jobs.map(compactCronListJob) }, undefined);
      return;
    }
    const jobs = page.jobs.map(cronJobReadView);
    if (p.includeDeliveryPreviews === false) {
      // Full job rows are the default because editors need their payloads. Delivery
      // previews are independently suppressible so list-only callers avoid per-job I/O
      // without weakening the shipped full-response default.
      respond(true, { ...page, jobs }, undefined);
      return;
    }
    const deliveryPreviews = await resolveCronDeliveryPreviews({
      cfg: context.getRuntimeConfig(),
      defaultAgentId: context.cron.getDefaultAgentId(),
      jobs: page.jobs,
    });
    respond(true, { ...page, jobs, deliveryPreviews }, undefined);
  },
  "cron.status": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateCronStatusParams, "cron.status", respond)) {
      return;
    }
    const status = await context.cron.status();
    respond(true, status, undefined);
  },
  "cron.get": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateCronGetParams, "cron.get", respond)) {
      return;
    }
    const jobId = resolveCronJobId(params as CronJobIdParams);
    if (!jobId) {
      respondMissingCronJobId(respond, "cron.get");
      return;
    }
    const callerScope = readCronCallerScope(client);
    const job = await context.cron.readJob(jobId);
    const cronVisibility = resolveCronSessionVisibility(client, context.getRuntimeConfig());
    if (
      !job ||
      !cronJobIsVisible(job, cronVisibility, context.cron.getDefaultAgentId()) ||
      !cronJobMatchesCallerScope({
        job,
        callerScope,
        defaultAgentId: context.cron.getDefaultAgentId(),
        allowCurrentJob: true,
      })
    ) {
      // Shipped CLI matchers parse this exact wording for name lookup fallback.
      // Structured details let current consumers render their own recovery hint.
      respondCronJobNotFound(respond, jobId, { preserveCronGetWireMessage: true });
      return;
    }
    respond(true, cronJobReadView(job), undefined);
  },
  "cron.scratch.get": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateCronScratchGetParams, "cron.scratch.get", respond)) {
      return;
    }
    const jobId = resolveCronJobId(params as CronJobIdParams);
    if (!jobId) {
      respondMissingCronJobId(respond, "cron.scratch.get");
      return;
    }
    const callerScope = readCronCallerScope(client);
    const job = await context.cron.readJob(jobId);
    if (
      !job ||
      !cronJobMatchesCallerScope({
        job,
        callerScope,
        defaultAgentId: context.cron.getDefaultAgentId(),
      })
    ) {
      respondCronJobNotFound(respond, jobId);
      return;
    }
    const state = await context.cron.readScratch(jobId);
    respond(
      true,
      {
        scratch: publicCronScratch(state.scratch),
        currentRevision: state.currentRevision,
        maxBytes: CRON_JOB_SCRATCH_MAX_BYTES,
      },
      undefined,
    );
  },
  "cron.scratch.set": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateCronScratchSetParams, "cron.scratch.set", respond)) {
      return;
    }
    const p = params as CronJobIdParams & {
      content: string | null;
      expectedRevision?: number;
    };
    const jobId = resolveCronJobId(p);
    if (!jobId) {
      respondMissingCronJobId(respond, "cron.scratch.set");
      return;
    }
    const callerScope = readCronCallerScope(client);
    const job = await context.cron.readJob(jobId);
    if (
      !job ||
      !cronJobMatchesCallerScope({
        job,
        callerScope,
        defaultAgentId: context.cron.getDefaultAgentId(),
      })
    ) {
      respondCronJobNotFound(respond, jobId);
      return;
    }
    try {
      const commitGuard = resolveCronMutationCommitGuard(client, context, {
        callerScope,
        jobId,
      });
      const result = await context.cron.writeScratch(jobId, {
        content: p.content,
        expectedRevision: p.expectedRevision,
        ...(commitGuard ? { commitGuard } : {}),
      });
      if (!result.ok) {
        respond(true, result, undefined);
        return;
      }
      respond(
        true,
        {
          ok: true,
          scratch: publicCronScratch(result.scratch),
          currentRevision: result.currentRevision,
          maxBytes: CRON_JOB_SCRATCH_MAX_BYTES,
        },
        undefined,
      );
    } catch (error) {
      respondInvalidCronParams(respond, "cron.scratch.set", formatErrorMessage(error));
    }
  },
  "cron.add": async ({ params, respond, context, client }) => {
    const rawParams = params as {
      declarationKey?: unknown;
      displayName?: unknown;
      enabled?: unknown;
    } | null;
    if (
      typeof rawParams?.declarationKey === "string" &&
      rawParams.declarationKey.trim().length === 0
    ) {
      respondInvalidCronParams(respond, "cron.add", "declarationKey must not be blank");
      return;
    }
    if (typeof rawParams?.displayName === "string" && rawParams.displayName.trim().length === 0) {
      respondInvalidCronParams(respond, "cron.add", "displayName must not be blank");
      return;
    }
    const hasEnabled = Boolean(rawParams && Object.hasOwn(rawParams, "enabled"));
    const parsedEnabled = hasEnabled ? parseBoolean(rawParams?.enabled) : undefined;
    if (hasEnabled && parsedEnabled === undefined) {
      respondInvalidCronParams(respond, "cron.add", "enabled must be a boolean");
      return;
    }
    const enabledExplicit = parsedEnabled !== undefined;
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
    const candidate = normalized;
    if (!assertValidParams(candidate, validateCronAddParams, "cron.add", respond)) {
      return;
    }
    const callerScope = readCronCallerScope(client);
    const operatorActor = callerScope ? undefined : resolveOperatorSessionCreation(client).actor;
    const creatorSession = callerScope?.sessionKey
      ? loadGatewaySessionEntryReadOnly(callerScope.sessionKey, {
          agentId: callerScope.agentId,
        }).entry
      : undefined;
    // Agent-tool clients own one exact signed session. Read that session's creator instead of
    // reclassifying spawn context as the automation creator; params never carry this provenance.
    const actor = operatorActor ?? creatorSession?.createdActor;
    const actorId = normalizeOptionalString(actor?.id);
    const createdActor = actor ? { ...actor, ...(actorId ? { id: actorId } : {}) } : undefined;
    let captureRuntimeAuthority: (() => CronRuntimeAuthority | undefined) | undefined;
    try {
      captureRuntimeAuthority = resolveCronCreatorAuthorityCapture(callerScope);
    } catch (err) {
      respondInvalidCronParams(respond, "cron.add", formatErrorMessage(err));
      return;
    }
    const assertMutationCurrent = resolveCronMutationCommitGuard(client, context);
    const selectionIdentity = JSON.stringify(creatorSession?.skillLibrarySelections);
    const commitGuard = () => {
      assertMutationCurrent?.();
      if (creatorSession && callerScope?.sessionKey) {
        const latest = loadGatewaySessionEntryReadOnly(callerScope.sessionKey, {
          agentId: callerScope.agentId,
        }).entry;
        if (
          latest?.sessionId !== creatorSession.sessionId ||
          latest.lifecycleRevision !== creatorSession.lifecycleRevision ||
          JSON.stringify(latest.skillLibrarySelections) !== selectionIdentity
        ) {
          throw new Error(
            "Creator session changed before scheduling; retry from the current turn.",
          );
        }
      }
    };
    const jobCreate = applyCronCreateCallerScopeDefault(candidate as CronJobCreate, callerScope);
    const cfg = context.getRuntimeConfig();
    try {
      assertCronDoesNotTargetAgentHarness(jobCreate);
    } catch (err) {
      respondInvalidCronParams(respond, "cron.add", formatErrorMessage(err));
      return;
    }
    if (
      !cronCreateMatchesCallerScope({
        job: jobCreate,
        callerScope,
        defaultAgentId: context.cron.getDefaultAgentId(),
      })
    ) {
      respondInvalidCronParams(respond, "cron.add", "job agentId outside caller scope");
      return;
    }
    if (requiresExplicitAgentRuntimeToolsAllow({ job: jobCreate, callerScope })) {
      respondInvalidCronParams(
        respond,
        "cron.add",
        "agent-runtime tool jobs require an explicit payload.toolsAllow cap",
      );
      return;
    }
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
      await assertValidCronCreateDelivery(cfg, jobCreate);
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
    // Resolve before the durable add. A preview failure after commit would make a safe retry
    // create a duplicate job.
    const deliveryPreview = await resolveCronDeliveryPreview({
      cfg,
      defaultAgentId: context.cron.getDefaultAgentId(),
      job: jobCreate,
    });
    let result: Awaited<ReturnType<typeof context.cron.add>>;
    try {
      result = await context.cron.add(jobCreate, {
        enabledExplicit,
        ...(createdActor ? { createdActor } : {}),
        ...(creatorSession?.skillLibrarySelections
          ? { skillLibrarySelections: creatorSession.skillLibrarySelections }
          : {}),
        commitGuard,
        ...(captureRuntimeAuthority ? { captureRuntimeAuthority } : {}),
        matchesExisting: (job) =>
          cronJobMatchesDeclarationScope({
            job,
            input: jobCreate,
            callerScope,
            defaultAgentId: context.cron.getDefaultAgentId(),
          }),
        ...(cronJobUsesToolRuntime(jobCreate)
          ? {
              scheduledToolPolicy: resolveCronScheduledToolPolicyForCaller(callerScope),
              ...(callerScope?.toolsAllowProvenance
                ? { toolsAllowProvenance: callerScope.toolsAllowProvenance }
                : {}),
              ...(callerScope?.toolsAllowExecTarget
                ? { toolsAllowExecTarget: callerScope.toolsAllowExecTarget }
                : {}),
            }
          : {}),
      });
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
    const job = "job" in result ? result.job : result;
    context.logGateway.info("cron: job added", {
      jobId: job.id,
      declarationKey: job.declarationKey,
      schedule: jobCreate.schedule,
    });
    respond(
      true,
      cronAddPayloadWithDeliveryPreview({
        result,
        deliveryPreview,
      }),
      undefined,
    );
  },
  "cron.update": async ({ params, respond, context, client }) => {
    let normalizedPatch: ReturnType<typeof normalizeCronJobPatch>;
    try {
      const rawPatch = (params as { patch?: unknown } | null)?.patch;
      const rawDisplayName =
        rawPatch && typeof rawPatch === "object"
          ? (rawPatch as { displayName?: unknown }).displayName
          : undefined;
      if (typeof rawDisplayName === "string" && rawDisplayName.trim().length === 0) {
        throw new Error("displayName must not be blank");
      }
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
    if (!assertValidParams(candidate, validateCronUpdateParams, "cron.update", respond)) {
      return;
    }
    if (!normalizedPatch) {
      respondInvalidCronParams(respond, "cron.update", "patch did not normalize");
      return;
    }
    const p = candidate as {
      id?: string;
      jobId?: string;
      patch: Record<string, unknown>;
      expectedConfigRevision?: string;
    };
    const callerScope = readCronCallerScope(client);
    let captureRuntimeAuthority: (() => CronRuntimeAuthority | undefined) | undefined;
    try {
      captureRuntimeAuthority = resolveCronCreatorAuthorityCapture(callerScope);
    } catch (err) {
      respondInvalidCronParams(respond, "cron.update", formatErrorMessage(err));
      return;
    }
    const commitGuard = resolveCronMutationCommitGuard(client, context);
    const jobId = resolveCronJobId(p);
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.update params: missing id"),
      );
      return;
    }
    const patch: CronJobPatch = normalizedPatch;
    const cfg = context.getRuntimeConfig();
    const currentJob = await context.cron.readJob(jobId);
    if (
      !currentJob ||
      !cronJobMatchesCallerScope({
        job: currentJob,
        callerScope,
        defaultAgentId: context.cron.getDefaultAgentId(),
      })
    ) {
      respondCronJobNotFound(respond, jobId);
      return;
    }
    if (callerScope && !callerScope.manageAll && "agentId" in patch) {
      respondInvalidCronParams(respond, "cron.update", "agentId cannot be changed by caller scope");
      return;
    }
    if (!cronPatchSessionRefsMatchCaller(patch, callerScope)) {
      respondInvalidCronParams(respond, "cron.update", "session target outside caller scope");
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
    const touchesToolRuntime = cronPatchTouchesToolRuntime(patch);
    const validateUpdate = async (jobToUpdate: CronJob) => {
      const nextJob = await assertValidCronUpdatePatch({
        cfg,
        defaultAgentId: context.cron.getDefaultAgentId(),
        currentJob: jobToUpdate,
        patch,
      });
      if (
        touchesToolRuntime &&
        requiresExplicitAgentRuntimeToolsAllow({ job: nextJob, callerScope })
      ) {
        throw new TypeError("agent-runtime tool jobs require an explicit payload.toolsAllow cap");
      }
    };
    try {
      await validateUpdate(currentJob);
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
      job = await context.cron.updateWithPrecondition(
        jobId,
        patch,
        async (lockedJob) => {
          if (
            !cronJobMatchesCallerScope({
              job: lockedJob,
              callerScope,
              defaultAgentId: context.cron.getDefaultAgentId(),
            })
          ) {
            throw new Error(`unknown cron job id: ${jobId}`);
          }
          if (p.expectedConfigRevision !== undefined) {
            const actualConfigRevision = resolveCronJobConfigRevision(lockedJob);
            if (actualConfigRevision !== p.expectedConfigRevision) {
              throw new CronJobConfigRevisionConflictError(
                p.expectedConfigRevision,
                actualConfigRevision,
              );
            }
          }
          await validateUpdate(lockedJob);
        },
        touchesToolRuntime || commitGuard || captureRuntimeAuthority
          ? {
              // Management does not adopt the creator's execution authority.
              ...(touchesToolRuntime
                ? {
                    scheduledToolPolicy: callerScope?.manageAll
                      ? undefined
                      : resolveCronScheduledToolPolicyForCaller(callerScope),
                    toolsAllowProvenance: callerScope?.toolsAllowProvenance,
                    toolsAllowExecTarget: callerScope?.toolsAllowExecTarget,
                  }
                : {}),
              ...(commitGuard ? { commitGuard } : {}),
              ...(captureRuntimeAuthority ? { captureRuntimeAuthority } : {}),
            }
          : undefined,
      );
    } catch (err) {
      if (err instanceof CronJobConfigRevisionConflictError) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "cron job definition no longer matches the loaded version; review the latest version before retrying",
            {
              details: {
                code: "CRON_JOB_CHANGED",
                expectedConfigRevision: err.expectedConfigRevision,
                actualConfigRevision: err.actualConfigRevision,
              },
            },
          ),
        );
        return;
      }
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
    respond(true, cronJobReadView(job), undefined);
  },
  "cron.remove": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateCronRemoveParams, "cron.remove", respond)) {
      return;
    }
    const jobId = resolveCronJobId(params as CronJobIdParams);
    if (!jobId) {
      respondMissingCronJobId(respond, "cron.remove");
      return;
    }
    const callerScope = readCronCallerScope(client);
    const job = await context.cron.readJob(jobId);
    if (
      !job ||
      !cronJobMatchesCallerScope({
        job,
        callerScope,
        defaultAgentId: context.cron.getDefaultAgentId(),
        allowCurrentJob: true,
      })
    ) {
      respondCronJobNotFound(respond, jobId);
      return;
    }
    const defaultAgentId = context.cron.getDefaultAgentId();
    const usesCurrentJobCapability = !cronJobMatchesCallerScope({
      job,
      callerScope,
      defaultAgentId,
    });
    const expectedConfigRevision = usesCurrentJobCapability
      ? resolveCronJobConfigRevision(job)
      : undefined;
    let result: Awaited<ReturnType<typeof context.cron.remove>>;
    try {
      const commitGuard = resolveCronMutationCommitGuard(client, context, {
        callerScope,
        jobId,
        allowCurrentJob: usesCurrentJobCapability,
        expectedConfigRevision,
      });
      result = commitGuard
        ? await context.cron.remove(jobId, { commitGuard })
        : await context.cron.remove(jobId);
    } catch (error) {
      if (error instanceof TypeError) {
        respondInvalidCronParams(respond, "cron.remove", formatErrorMessage(error));
        return;
      }
      throw error;
    }
    if (!result.removed) {
      respondCronJobNotFound(respond, jobId);
      return;
    }
    context.logGateway.info("cron: job removed", { jobId });
    respond(true, result, undefined);
  },
  "cron.run": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateCronRunParams, "cron.run", respond)) {
      return;
    }
    const p = params as CronJobIdParams & {
      mode?: "due" | "force" | "if-enabled";
      expectedProcessInstanceId?: string;
    };
    const callerScope = readCronCallerScope(client);
    const jobId = resolveCronJobId(p);
    if (!jobId) {
      respondMissingCronJobId(respond, "cron.run");
      return;
    }
    const job = await context.cron.readJob(jobId);
    if (
      !job ||
      !cronJobMatchesCallerScope({
        job,
        callerScope,
        defaultAgentId: context.cron.getDefaultAgentId(),
      })
    ) {
      respondCronJobNotFound(respond, jobId);
      return;
    }
    if (
      p.expectedProcessInstanceId &&
      p.expectedProcessInstanceId !== getGatewayProcessInstanceId()
    ) {
      respondInvalidCronParams(respond, "cron.run", "Gateway process changed after preflight");
      return;
    }
    let result: Awaited<ReturnType<typeof context.cron.enqueueRun>>;
    try {
      const commitGuard = resolveCronMutationCommitGuard(client, context, {
        callerScope,
        jobId,
      });
      result = commitGuard
        ? await context.cron.enqueueRun(jobId, p.mode ?? "force", { commitGuard })
        : await context.cron.enqueueRun(jobId, p.mode ?? "force");
    } catch (error) {
      if (error instanceof TypeError) {
        respondInvalidCronParams(respond, "cron.run", formatErrorMessage(error));
        return;
      }
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
    respond(true, { ...result, processInstanceId: getGatewayProcessInstanceId() }, undefined);
  },
  "cron.runs": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateCronRunsParams, "cron.runs", respond)) {
      return;
    }
    const p = params as CronRunsRequestParams;
    const callerScope = readCronCallerScope(client);
    const explicitScope = p.scope;
    const hasJobSelector = p.id !== undefined || p.jobId !== undefined;
    const jobId = resolveCronJobId(p);
    const scope: "job" | "all" = explicitScope ?? (hasJobSelector ? "job" : "all");
    const cronVisibility = resolveCronSessionVisibility(client, context.getRuntimeConfig());
    if (scope === "all") {
      if (callerScope) {
        respondInvalidCronParams(respond, "cron.runs", "scope all is not allowed by caller scope");
        return;
      }
      const jobs = filterCronRunLogJobsByAgent(
        await context.cron.list({ includeDisabled: true }),
        p.agentId,
        context.cron.getDefaultAgentId(),
      ).filter((job) => cronJobIsVisible(job, cronVisibility, context.cron.getDefaultAgentId()));
      const jobNameById = Object.fromEntries(
        jobs
          .filter((job) => typeof job.id === "string" && typeof job.name === "string")
          .map((job) => [job.id, job.name]),
      );
      const visibleJobIds = new Set(jobs.map((job) => job.id));
      const page = readCronTaskRunHistoryPage({
        storeKey: cronStoreKey(context.cronStorePath),
        ...cronRunLogPageFilters(p),
        agentId: p.agentId,
        jobNameById,
        entryFilter: cronVisibility
          ? (entry) =>
              visibleJobIds.has(entry.jobId) &&
              (!entry.sessionKey || cronVisibility(entry.sessionKey, p.agentId))
          : undefined,
      });
      respond(true, page, undefined);
      return;
    }
    if (!jobId) {
      respondMissingCronJobId(respond, "cron.runs");
      return;
    }
    try {
      const job = await context.cron.readJob(jobId);
      const defaultAgentId = context.cron.getDefaultAgentId();
      const matchedJob =
        job &&
        filterCronRunLogJobsByAgent([job], p.agentId, defaultAgentId).length > 0 &&
        cronJobIsVisible(job, cronVisibility, defaultAgentId) &&
        cronJobMatchesCallerScope({
          job,
          callerScope,
          defaultAgentId,
          allowCurrentJob: true,
        })
          ? job
          : undefined;
      // Operator history survives job deletion; scoped reads still need a live, matching owner.
      const storeKey = cronStoreKey(context.cronStorePath);
      if (
        ((callerScope || p.agentId || cronVisibility) && !matchedJob) ||
        (!job && readCronTaskRunHistoryPage({ storeKey, jobId, limit: 1 }).total === 0)
      ) {
        respondCronJobNotFound(respond, jobId);
        return;
      }
      const jobNameById =
        matchedJob && typeof matchedJob.name === "string"
          ? { [jobId]: matchedJob.name }
          : undefined;
      const page = readCronTaskRunHistoryPage({
        storeKey,
        jobId,
        ...cronRunLogPageFilters(p),
        jobNameById,
        entryFilter: cronVisibility
          ? (entry) => !entry.sessionKey || cronVisibility(entry.sessionKey, matchedJob?.agentId)
          : undefined,
      });
      respond(true, page, undefined);
    } catch (err) {
      if (!isInvalidCronTaskRunJobIdError(err)) {
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

// The existing one-use grant is request-scoped; the original runtime identity
// stays intact so deferred cron commits still fence the exact admitted run.
for (const [method, handler] of Object.entries(cronHandlers)) {
  cronHandlers[method] = async (args) => {
    const identity = args.client?.internal?.agentRuntimeIdentity;
    if (!identity) {
      return await handler(args);
    }
    const grant = identity.cronManagementGrant;
    let succeeded = false;
    const run = async () => {
      assertActiveAgentRuntimeAuthority(args.client, args.context);
      await handler({
        ...args,
        respond: (...response) => {
          // Reads release data here; mutations already checked at commit. A late
          // acknowledgement must not turn a committed effect into a retryable denial.
          if (method === "cron.list" || method === "cron.get") {
            assertActiveAgentRuntimeAuthority(args.client, args.context);
            getCronManagementAuthority(identity)?.();
          }
          succeeded = response[0];
          args.respond(...response);
        },
      });
    };
    try {
      await (grant ? withCronManagementGrant(grant, identity, method, run) : run());
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error;
      }
      respondInvalidCronParams(args.respond, method, error.message);
    } finally {
      if (grant) {
        args.context.logGateway.info("cron: admin management", {
          method,
          runId: identity.operationalRunInstance.runId,
          instanceId: identity.operationalRunInstance.instanceId,
          ok: succeeded,
        });
      }
    }
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
