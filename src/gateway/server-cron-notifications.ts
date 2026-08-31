// Gateway cron notification delivery.
// Sends announce and webhook notifications for cron completion/failure events.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveUserTimezone } from "../agents/date-time.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveControlUiAutomationRunUrl } from "../config/control-ui-link-base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactCronCommandSummaryForExternalDelivery } from "../cron/command-output-summary.js";
import { resolveCronDeliveryPlan, sendCronAnnouncePayloadStrict } from "../cron/delivery.js";
import { retryTransientDirectCronDelivery } from "../cron/isolated-agent/delivery-dispatch-policy.js";
import { createCronExecutionId } from "../cron/run-id.js";
import type { CronEvent, CronService } from "../cron/service.js";
import { resolveCronDeliverySessionKey } from "../cron/session-target.js";
import type { CronJob } from "../cron/types.js";
import { normalizeHttpWebhookUrl } from "../cron/webhook-url.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatZonedTimestamp } from "../infra/format-time/format-datetime.js";
import { withTimeout } from "../infra/fs-safe.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { SsrFBlockedError, type SsrFPolicy } from "../infra/net/ssrf.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../process/gateway-work-admission.js";
import { assertSecretOwnerAvailable } from "../secrets/runtime-degraded-state.js";

const CRON_WEBHOOK_TIMEOUT_MS = 10_000;

type CronLogger = {
  warn: (obj: unknown, msg?: string) => void;
};

type CronAgentResolver = (requested?: string | null) => {
  agentId: string;
  cfg: OpenClawConfig;
};

type CronFailureAlertParams = Parameters<
  NonNullable<ConstructorParameters<typeof CronService>[0]["sendCronFailureAlert"]>
>[0] & {
  deps: CliDeps;
  logger: CronLogger;
  resolveCronAgent: CronAgentResolver;
  webhookToken?: unknown;
  ssrfPolicy?: SsrFPolicy;
};

function redactWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-webhook-url>";
  }
}

function redactOptionalWebhookUrl(url: unknown): string | undefined {
  const normalized = normalizeOptionalString(url);
  return normalized ? redactWebhookUrl(normalized) : undefined;
}

function redactCommandCronEventForExternalDelivery(evt: CronEvent, job?: CronJob): CronEvent {
  if (job?.payload.kind !== "command") {
    return evt;
  }
  const summary = redactCronCommandSummaryForExternalDelivery(evt.summary);
  const diagnosticsSummary = redactCronCommandSummaryForExternalDelivery(evt.diagnostics?.summary);
  const diagnosticsEntries = evt.diagnostics?.entries.map((entry) => ({
    ...entry,
    message: redactCronCommandSummaryForExternalDelivery(entry.message) ?? entry.message,
  }));
  const diagnosticsEntriesChanged = diagnosticsEntries?.some(
    (entry, index) => entry.message !== evt.diagnostics?.entries[index]?.message,
  );
  const embeddedJobState = evt.job?.state;
  const stripEmbeddedJobDiagnostics = Boolean(
    embeddedJobState &&
    ("lastDiagnostics" in embeddedJobState || "lastDiagnosticSummary" in embeddedJobState),
  );
  if (
    summary === evt.summary &&
    diagnosticsSummary === evt.diagnostics?.summary &&
    !diagnosticsEntriesChanged &&
    !stripEmbeddedJobDiagnostics
  ) {
    return evt;
  }
  const redacted: CronEvent = { ...evt };
  if (summary !== undefined) {
    redacted.summary = summary;
  } else {
    delete redacted.summary;
  }
  if (evt.diagnostics) {
    redacted.diagnostics = { ...evt.diagnostics };
    if (diagnosticsSummary !== undefined) {
      redacted.diagnostics.summary = diagnosticsSummary;
    } else {
      delete redacted.diagnostics.summary;
    }
    if (diagnosticsEntries) {
      redacted.diagnostics.entries = diagnosticsEntries;
    }
  }
  if (stripEmbeddedJobDiagnostics && evt.job) {
    const state = { ...evt.job.state };
    delete state.lastDiagnostics;
    delete state.lastDiagnosticSummary;
    redacted.job = {
      ...evt.job,
      state,
    };
  }
  return redacted;
}

function resolveCronCompletionWebhook(params: {
  delivery?: {
    mode?: string;
    to?: string;
    completionDestination?: { mode?: string; to?: string };
  };
}): string | undefined {
  if (
    normalizeOptionalLowercaseString(params.delivery?.mode) !== "announce" ||
    normalizeOptionalLowercaseString(params.delivery?.completionDestination?.mode) !== "webhook"
  ) {
    return undefined;
  }
  return normalizeHttpWebhookUrl(params.delivery?.completionDestination?.to) ?? undefined;
}

function buildCronWebhookHeaders(webhookToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (webhookToken) {
    headers.Authorization = `Bearer ${webhookToken}`;
  }
  return headers;
}

function appendCronRunStarted(
  message: string,
  runAtMs: number | undefined,
  config: OpenClawConfig,
): string {
  if (typeof runAtMs !== "number" || !Number.isFinite(runAtMs)) {
    return message;
  }
  const timestamp = formatZonedTimestamp(new Date(runAtMs), {
    timeZone: resolveUserTimezone(config.agents?.defaults?.userTimezone),
  });
  return timestamp ? `${message}\nRun started: ${timestamp}` : message;
}

function appendCronFailureAlertDetails(
  message: string,
  jobId: string,
  runAtMs: number | undefined,
  config: OpenClawConfig,
): string {
  const withRunStarted = appendCronRunStarted(message, runAtMs, config);
  const inspectUrl = resolveControlUiAutomationRunUrl(config, {
    jobId,
    runId: runAtMs ? createCronExecutionId(jobId, runAtMs) : undefined,
  });
  return inspectUrl ? `${withRunStarted}\nInspect: ${inspectUrl}` : withRunStarted;
}

function buildCronFinishedWebhookPayload(evt: CronEvent) {
  if (evt.status !== "error") {
    return evt;
  }
  const { summary: _summary, diagnostics: _diagnostics, ...payload } = evt;
  if (evt.job) {
    const state = { ...evt.job.state };
    delete state.lastDiagnostics;
    delete state.lastDiagnosticSummary;
    return {
      ...payload,
      job: {
        ...evt.job,
        state,
      },
    };
  }
  return payload;
}

async function postCronWebhookStrict(params: {
  webhookUrl: string;
  webhookToken?: string;
  payload: unknown;
  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  onDeliveryAccepted?: () => void;
}): Promise<void> {
  const remainingMs =
    params.deadlineAtMs === undefined ? CRON_WEBHOOK_TIMEOUT_MS : params.deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    const error = new Error("cron webhook delivery deadline exceeded");
    error.name = "TimeoutError";
    throw error;
  }
  const requestTimeoutMs = Math.min(CRON_WEBHOOK_TIMEOUT_MS, remainingMs);
  const requestDeadlineAtMs = Date.now() + requestTimeoutMs;
  assertSecretOwnerAvailable("capability", "cron-webhook");
  const result = await fetchWithSsrFGuard({
    url: params.webhookUrl,
    timeoutMs: requestTimeoutMs,
    policy: params.ssrfPolicy,
    ...(params.signal ? { signal: params.signal } : {}),
    init: {
      method: "POST",
      headers: buildCronWebhookHeaders(params.webhookToken),
      body: JSON.stringify(params.payload),
    },
  });
  let accepted = false;
  try {
    if (!result.response.ok) {
      throw new Error(`Webhook request failed with HTTP ${result.response.status}`);
    }
    accepted = true;
    params.onDeliveryAccepted?.();
  } finally {
    const cleanup = async () => {
      // Keep response cleanup before guard release inside the request deadline; a non-settling
      // stream cancellation must not retain the dispatcher or Gateway root.
      if (!result.response.bodyUsed) {
        const cancellation = result.response.body?.cancel();
        if (cancellation) {
          await withTimeout(
            cancellation,
            Math.max(1, requestDeadlineAtMs - Date.now()),
            "cron webhook response cleanup",
          ).catch(() => undefined);
        }
      }
      await result.release();
    };
    if (accepted) {
      // A 2xx acknowledgement is the terminal delivery fact. Cleanup must not
      // rewrite it after the receiver has accepted the webhook.
      await cleanup().catch(() => undefined);
    } else {
      await cleanup();
    }
  }
}

/** Posts a detached cron webhook without throwing back into scheduler completion flow. */
async function postCronWebhook(params: {
  webhookUrl: string;
  webhookToken?: string;
  payload: unknown;
  ssrfPolicy?: SsrFPolicy;
  logContext: Record<string, unknown>;
  blockedLog: string;
  failedLog: string;
  logger: CronLogger;
}): Promise<void> {
  try {
    await postCronWebhookStrict(params);
  } catch (err) {
    if (err instanceof SsrFBlockedError) {
      params.logger.warn(
        {
          ...params.logContext,
          reason: formatErrorMessage(err),
          webhookUrl: redactWebhookUrl(params.webhookUrl),
        },
        params.blockedLog,
      );
    } else {
      params.logger.warn(
        {
          ...params.logContext,
          err: formatErrorMessage(err),
          webhookUrl: redactWebhookUrl(params.webhookUrl),
        },
        params.failedLog,
      );
    }
  }
}

/** Delivers the primary webhook while the cron run still owns its terminal outcome. */
export async function sendGatewayCronWebhook(params: {
  event: CronEvent;
  job: CronJob;
  abortSignal?: AbortSignal;
  deadlineAtMs?: number;
  webhookToken?: unknown;
  ssrfPolicy?: SsrFPolicy;
  onDeliveryAccepted?: () => void;
}): Promise<void> {
  const deliveryPlan = resolveCronDeliveryPlan(params.job);
  const webhookUrl = normalizeHttpWebhookUrl(deliveryPlan.to);
  if (!webhookUrl) {
    throw new Error("cron webhook delivery.to must be a valid http(s) URL");
  }
  const event = redactCommandCronEventForExternalDelivery(params.event, params.job);
  await retryTransientDirectCronDelivery({
    jobId: params.job.id,
    label: "webhook",
    ...(params.abortSignal ? { signal: params.abortSignal } : {}),
    ...(params.deadlineAtMs !== undefined ? { deadlineAtMs: params.deadlineAtMs } : {}),
    run: () =>
      postCronWebhookStrict({
        webhookUrl,
        webhookToken: normalizeOptionalString(params.webhookToken),
        ssrfPolicy: params.ssrfPolicy,
        payload: buildCronFinishedWebhookPayload(event),
        ...(params.abortSignal ? { signal: params.abortSignal } : {}),
        ...(params.deadlineAtMs !== undefined ? { deadlineAtMs: params.deadlineAtMs } : {}),
        ...(params.onDeliveryAccepted ? { onDeliveryAccepted: params.onDeliveryAccepted } : {}),
      }),
    shouldRetryError: (error) => !(error instanceof SsrFBlockedError),
  });
}

/** Detached sends outlive cron ticks; own roots block mid-delivery suspension snapshots. */
function dispatchDetachedCronNotification(params: {
  jobId: string;
  logger: CronLogger;
  deliver: () => Promise<void>;
}): void {
  void runWithGatewayIndependentRootWorkContinuation(params.deliver).catch((err: unknown) => {
    params.logger.warn(
      { jobId: params.jobId, err: formatErrorMessage(err) },
      "cron: detached notification delivery failed",
    );
  });
}

/** Transports a scheduler-authorized cron failure alert. */
export async function sendGatewayCronFailureAlert(params: CronFailureAlertParams): Promise<void> {
  await runWithGatewayIndependentRootWorkContinuation(async () => {
    await sendGatewayCronFailureAlertUnderAdmission(params);
  });
}

async function sendGatewayCronFailureAlertUnderAdmission(
  params: CronFailureAlertParams,
): Promise<void> {
  const { agentId, cfg: runtimeConfig } = params.resolveCronAgent(params.job.agentId);

  if (params.mode === "webhook") {
    if (!params.to) {
      throw new Error("cron failure alert webhook requires a URL");
    }
    const webhookUrl = normalizeHttpWebhookUrl(params.to);
    if (!webhookUrl) {
      throw new Error("cron failure alert webhook requires a valid http(s) URL");
    }
    await postCronWebhookStrict({
      webhookUrl,
      webhookToken: normalizeOptionalString(params.webhookToken),
      ssrfPolicy: params.ssrfPolicy,
      onDeliveryAccepted: () => params.onDeliveryAttempt?.(true),
      payload: {
        jobId: params.job.id,
        jobName: params.job.name,
        message: params.payload.text ?? "",
        runAtMs: params.runAtMs,
      },
    });
    return;
  }

  const abortController = new AbortController();
  const deliveryTimeoutError = new Error("cron: failure alert announcement timed out");
  // Release Gateway admission on deadline even when a transport ignores abort.
  await withTimeout(
    sendCronAnnouncePayloadStrict({
      deps: params.deps,
      cfg: runtimeConfig,
      agentId,
      jobId: params.job.id,
      target: {
        channel: params.channel,
        to: params.to,
        accountId: params.accountId,
        threadId: params.threadId,
        sessionKey: resolveCronDeliverySessionKey(params.job),
        inheritSessionThread: params.inheritSessionThread,
      },
      payload: {
        ...params.payload,
        text: appendCronFailureAlertDetails(
          params.payload.text ?? "",
          params.job.id,
          params.runAtMs,
          runtimeConfig,
        ),
      },
      abortSignal: abortController.signal,
      onDeliveryAttempt: params.onDeliveryAttempt,
    }),
    CRON_WEBHOOK_TIMEOUT_MS,
    {
      createError: () => {
        abortController.abort(deliveryTimeoutError);
        return deliveryTimeoutError;
      },
    },
  );
}

/** Fans out completion webhooks after a cron run finishes. */
export function dispatchGatewayCronFinishedNotifications(params: {
  evt: CronEvent;
  job?: CronJob;
  deps: CliDeps;
  logger: CronLogger;
  resolveCronAgent: CronAgentResolver;
  webhookToken?: unknown;
  ssrfPolicy?: SsrFPolicy;
}): void {
  const webhookToken = normalizeOptionalString(params.webhookToken);
  const redactedWebhookEvent = redactCommandCronEventForExternalDelivery(params.evt, params.job);
  const completionSummary =
    params.job?.payload.kind === "script"
      ? normalizeOptionalString(redactedWebhookEvent.summary)
      : params.evt.summary;
  const completionWebhookUrl = resolveCronCompletionWebhook({
    delivery:
      params.job?.delivery && typeof params.job.delivery.mode === "string"
        ? {
            mode: params.job.delivery.mode,
            to: params.job.delivery.to,
            completionDestination: params.job.delivery.completionDestination,
          }
        : undefined,
  });

  if (
    params.job?.delivery?.completionDestination?.mode === "webhook" &&
    !normalizeHttpWebhookUrl(params.job.delivery.completionDestination.to)
  ) {
    params.logger.warn(
      {
        jobId: params.evt.jobId,
        deliveryTo: redactOptionalWebhookUrl(params.job.delivery.completionDestination.to),
      },
      "cron: skipped completion webhook delivery, delivery.completionDestination.to must be a valid http(s) URL",
    );
  }

  // Script notify is carried as the completion summary, so its absence uses
  // the same silent-summary suppression path as NO_REPLY output.
  if (completionWebhookUrl && (completionSummary || params.evt.completionStatus === "failed")) {
    const payload = buildCronFinishedWebhookPayload(redactedWebhookEvent);
    dispatchDetachedCronNotification({
      jobId: params.evt.jobId,
      logger: params.logger,
      deliver: () =>
        postCronWebhook({
          webhookUrl: completionWebhookUrl,
          webhookToken,
          ssrfPolicy: params.ssrfPolicy,
          payload,
          logContext: { jobId: params.evt.jobId, source: "completionDestination" },
          blockedLog: "cron: webhook delivery blocked by SSRF guard",
          failedLog: "cron: webhook delivery failed",
          logger: params.logger,
        }),
    });
  }
}
