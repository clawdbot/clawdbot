// Gateway cron notification delivery.
// Sends announce and webhook notifications for cron completion/failure events.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { CliDeps } from "../cli/deps.types.js";
import type { CronFailureDestinationConfig } from "../config/types.cron.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactCronCommandSummaryForExternalDelivery } from "../cron/command-output-summary.js";
import {
  resolveCronDeliveryPlan,
  resolveFailureDestination,
  sendCronAnnouncePayloadStrict,
  sendFailureNotificationAnnounce,
} from "../cron/delivery.js";
import type { CronEvent } from "../cron/service.js";
import { resolveCronDeliverySessionKey } from "../cron/session-target.js";
import type { CronJob, CronMessageChannel } from "../cron/types.js";
import { normalizeHttpWebhookUrl } from "../cron/webhook-url.js";
import { formatErrorMessage } from "../infra/errors.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";

const CRON_WEBHOOK_TIMEOUT_MS = 10_000;

type CronLogger = {
  warn: (obj: unknown, msg?: string) => void;
};

type CronAgentResolver = (requested?: string | null) => {
  agentId: string;
  cfg: OpenClawConfig;
};

type CronWebhookTarget = {
  url: string;
  source: "delivery" | "completionDestination";
};

type CronFailureAlertParams = {
  deps: CliDeps;
  logger: CronLogger;
  resolveCronAgent: CronAgentResolver;
  webhookToken?: unknown;
  job: CronJob;
  text: string;
  channel: CronMessageChannel;
  to?: string;
  mode?: "announce" | "webhook";
  accountId?: string;
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

/** Resolves direct webhook delivery and completion-destination webhooks. */
function resolveCronWebhookTargets(params: {
  delivery?: {
    mode?: string;
    to?: string;
    completionDestination?: { mode?: string; to?: string };
  };
}): CronWebhookTarget[] {
  const targets: CronWebhookTarget[] = [];
  const mode = normalizeOptionalLowercaseString(params.delivery?.mode);
  if (mode === "webhook") {
    const url = normalizeHttpWebhookUrl(params.delivery?.to);
    if (url) {
      targets.push({ url, source: "delivery" });
    }
  }

  const completionMode = normalizeOptionalLowercaseString(
    params.delivery?.completionDestination?.mode,
  );
  if (mode === "announce" && completionMode === "webhook") {
    const url = normalizeHttpWebhookUrl(params.delivery?.completionDestination?.to);
    if (url && targets.every((target) => target.url !== url)) {
      targets.push({ url, source: "completionDestination" });
    }
  }

  return targets;
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

function buildCronFailureWebhookPayload(params: { evt: CronEvent; job: CronJob }) {
  const failureMessage = `Cron job "${params.job.name}" failed: ${params.evt.error ?? "unknown error"}`;
  return {
    jobId: params.job.id,
    jobName: params.job.name,
    message: failureMessage,
    status: params.evt.status,
    error: params.evt.error,
    runAtMs: params.evt.runAtMs,
    durationMs: params.evt.durationMs,
    nextRunAtMs: params.evt.nextRunAtMs,
  };
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

/** Posts a cron webhook without throwing back into scheduler completion flow. */
async function postCronWebhook(params: {
  webhookUrl: string;
  webhookToken?: string;
  payload: unknown;
  logContext: Record<string, unknown>;
  blockedLog: string;
  failedLog: string;
  logger: CronLogger;
}): Promise<void> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, CRON_WEBHOOK_TIMEOUT_MS);

  try {
    const result = await fetchWithSsrFGuard({
      url: params.webhookUrl,
      init: {
        method: "POST",
        headers: buildCronWebhookHeaders(params.webhookToken),
        body: JSON.stringify(params.payload),
        signal: abortController.signal,
      },
    });
    await result.release();
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
  } finally {
    clearTimeout(timeout);
  }
}

/** Detached sends outlive cron ticks; own roots block mid-delivery suspension snapshots. */
function dispatchDetachedCronNotification(params: {
  jobId: string;
  logger: CronLogger;
  deliver: () => Promise<void>;
}): void {
  void runWithGatewayIndependentRootWorkAdmission(params.deliver).catch((err: unknown) => {
    params.logger.warn(
      { jobId: params.jobId, err: formatErrorMessage(err) },
      "cron: detached notification delivery failed",
    );
  });
}

/** Sends the immediate failure alert for cron jobs that failed before normal completion delivery. */
export async function sendGatewayCronFailureAlert(params: CronFailureAlertParams): Promise<void> {
  await runWithGatewayIndependentRootWorkAdmission(async () => {
    await sendGatewayCronFailureAlertUnderAdmission(params);
  });
}

async function sendGatewayCronFailureAlertUnderAdmission(
  params: CronFailureAlertParams,
): Promise<void> {
  const { agentId, cfg: runtimeConfig } = params.resolveCronAgent(params.job.agentId);
  const webhookToken = normalizeOptionalString(params.webhookToken);

  if (params.mode === "webhook" && !params.to) {
    params.logger.warn(
      { jobId: params.job.id },
      "cron: failure alert webhook mode requires URL, skipping",
    );
    return;
  }

  if (params.mode === "webhook" && params.to) {
    const webhookUrl = normalizeHttpWebhookUrl(params.to);
    if (webhookUrl) {
      await postCronWebhook({
        webhookUrl,
        webhookToken,
        payload: {
          jobId: params.job.id,
          jobName: params.job.name,
          message: params.text,
        },
        logContext: { jobId: params.job.id },
        blockedLog: "cron: failure alert webhook blocked by SSRF guard",
        failedLog: "cron: failure alert webhook failed",
        logger: params.logger,
      });
    } else {
      params.logger.warn(
        {
          jobId: params.job.id,
          webhookUrl: redactWebhookUrl(params.to),
        },
        "cron: failure alert webhook URL is invalid, skipping",
      );
    }
    return;
  }

  const abortController = new AbortController();
  await sendCronAnnouncePayloadStrict({
    deps: params.deps,
    cfg: runtimeConfig,
    agentId,
    jobId: params.job.id,
    target: {
      channel: params.channel,
      to: params.to,
      accountId: params.accountId,
      sessionKey: resolveCronDeliverySessionKey(params.job),
    },
    message: params.text,
    abortSignal: abortController.signal,
  });
}

/** Dispatches completion and failure-destination notifications after a cron run finishes. */
export function dispatchGatewayCronFinishedNotifications(params: {
  evt: CronEvent;
  job?: CronJob;
  deps: CliDeps;
  logger: CronLogger;
  resolveCronAgent: CronAgentResolver;
  webhookToken?: unknown;
  globalFailureDestination?: CronFailureDestinationConfig;
}): void {
  const webhookToken = normalizeOptionalString(params.webhookToken);
  const redactedWebhookEvent = redactCommandCronEventForExternalDelivery(params.evt, params.job);
  const webhookTargets = resolveCronWebhookTargets({
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

  if (
    !webhookTargets.some((target) => target.source === "delivery") &&
    params.job?.delivery?.mode === "webhook"
  ) {
    params.logger.warn(
      {
        jobId: params.evt.jobId,
        deliveryTo: redactOptionalWebhookUrl(params.job.delivery.to),
      },
      "cron: skipped webhook delivery, delivery.to must be a valid http(s) URL",
    );
  }

  if (params.evt.summary) {
    for (const webhookTarget of webhookTargets) {
      const payload = buildCronFinishedWebhookPayload(redactedWebhookEvent);
      // Completion notification fanout is best-effort; the cron service has
      // already recorded the run result and must not wait on slow webhooks.
      dispatchDetachedCronNotification({
        jobId: params.evt.jobId,
        logger: params.logger,
        deliver: () =>
          postCronWebhook({
            webhookUrl: webhookTarget.url,
            webhookToken,
            payload,
            logContext: { jobId: params.evt.jobId, source: webhookTarget.source },
            blockedLog: "cron: webhook delivery blocked by SSRF guard",
            failedLog: "cron: webhook delivery failed",
            logger: params.logger,
          }),
      });
    }
  }

  dispatchCronFailureDestinationNotifications({
    evt: params.evt,
    job: params.job,
    deps: params.deps,
    logger: params.logger,
    resolveCronAgent: params.resolveCronAgent,
    webhookToken,
    globalFailureDestination: params.globalFailureDestination,
  });
}

function dispatchCronFailureDestinationNotifications(params: {
  evt: CronEvent;
  job?: CronJob;
  deps: CliDeps;
  logger: CronLogger;
  resolveCronAgent: CronAgentResolver;
  webhookToken?: string;
  globalFailureDestination?: CronFailureDestinationConfig;
}): void {
  if (params.evt.status !== "error" || !params.job || params.job.delivery?.bestEffort === true) {
    return;
  }

  const job = params.job;
  const failureDest = resolveFailureDestination(job, params.globalFailureDestination);
  const deliverySessionKey = resolveCronDeliverySessionKey(job);
  const failurePayload = buildCronFailureWebhookPayload({ evt: params.evt, job });

  if (failureDest) {
    if (failureDest.mode === "webhook" && failureDest.to) {
      const webhookUrl = normalizeHttpWebhookUrl(failureDest.to);
      if (webhookUrl) {
        // Failure destinations mirror completion webhooks: notify in the
        // background and log failures without rewriting the cron event result.
        dispatchDetachedCronNotification({
          jobId: params.evt.jobId,
          logger: params.logger,
          deliver: () =>
            postCronWebhook({
              webhookUrl,
              webhookToken: params.webhookToken,
              payload: failurePayload,
              logContext: { jobId: params.evt.jobId },
              blockedLog: "cron: failure destination webhook blocked by SSRF guard",
              failedLog: "cron: failure destination webhook failed",
              logger: params.logger,
            }),
        });
      } else {
        params.logger.warn(
          {
            jobId: params.evt.jobId,
            webhookUrl: redactWebhookUrl(failureDest.to),
          },
          "cron: failure destination webhook URL is invalid, skipping",
        );
      }
      return;
    }

    if (failureDest.mode === "announce") {
      const { agentId, cfg: runtimeConfig } = params.resolveCronAgent(job.agentId);
      dispatchDetachedCronNotification({
        jobId: job.id,
        logger: params.logger,
        deliver: () =>
          sendFailureNotificationAnnounce(
            params.deps,
            runtimeConfig,
            agentId,
            job.id,
            {
              channel: failureDest.channel,
              to: failureDest.to,
              accountId: failureDest.accountId,
              sessionKey: deliverySessionKey,
              // A configured failure route is already explicit; keep the cron run
              // session only for context, not for reattaching the primary topic.
              inheritSessionThread: false,
            },
            `⚠️ ${failurePayload.message}`,
          ),
      });
    }
    return;
  }

  const primaryPlan = resolveCronDeliveryPlan(job);
  if (primaryPlan.mode !== "announce" || !primaryPlan.requested) {
    return;
  }

  const { agentId, cfg: runtimeConfig } = params.resolveCronAgent(job.agentId);
  dispatchDetachedCronNotification({
    jobId: job.id,
    logger: params.logger,
    deliver: () =>
      sendFailureNotificationAnnounce(
        params.deps,
        runtimeConfig,
        agentId,
        job.id,
        {
          channel: primaryPlan.channel,
          to: primaryPlan.to,
          accountId: primaryPlan.accountId,
          sessionKey: deliverySessionKey,
        },
        `⚠️ ${failurePayload.message}`,
      ),
  });
}
