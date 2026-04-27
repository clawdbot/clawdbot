import type { CliDeps } from "../cli/deps.types.js";
import type { CronFailureDestinationConfig } from "../config/types.cron.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

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
  source: "delivery" | "legacy";
};

function redactWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<invalid-webhook-url>";
  }
}

function resolveCronWebhookTarget(params: {
  delivery?: { mode?: string; to?: string };
  legacyNotify?: boolean;
  legacyWebhook?: string;
}): CronWebhookTarget | null {
  const mode = normalizeOptionalLowercaseString(params.delivery?.mode);
  if (mode === "webhook") {
    const url = normalizeHttpWebhookUrl(params.delivery?.to);
    return url ? { url, source: "delivery" } : null;
  }

  if (params.legacyNotify) {
    const legacyUrl = normalizeHttpWebhookUrl(params.legacyWebhook);
    if (legacyUrl) {
      return { url: legacyUrl, source: "legacy" };
    }
  }

  return null;
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

export async function sendGatewayCronFailureAlert(params: {
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
}): Promise<void> {
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

export function dispatchGatewayCronFinishedNotifications(params: {
  evt: CronEvent;
  job?: CronJob;
  deps: CliDeps;
  logger: CronLogger;
  resolveCronAgent: CronAgentResolver;
  webhookToken?: unknown;
  legacyWebhook?: unknown;
  globalFailureDestination?: CronFailureDestinationConfig;
  warnedLegacyWebhookJobs: Set<string>;
}): void {
  const webhookToken = normalizeOptionalString(params.webhookToken);
  const legacyWebhook = normalizeOptionalString(params.legacyWebhook);
  const legacyNotify = (params.job as { notify?: unknown } | undefined)?.notify === true;
  const webhookTarget = resolveCronWebhookTarget({
    delivery:
      params.job?.delivery && typeof params.job.delivery.mode === "string"
        ? { mode: params.job.delivery.mode, to: params.job.delivery.to }
        : undefined,
    legacyNotify,
    legacyWebhook,
  });

  if (!webhookTarget && params.job?.delivery?.mode === "webhook") {
    params.logger.warn(
      {
        jobId: params.evt.jobId,
        deliveryTo: params.job.delivery.to,
      },
      "cron: skipped webhook delivery, delivery.to must be a valid http(s) URL",
    );
  }

  if (webhookTarget?.source === "legacy" && !params.warnedLegacyWebhookJobs.has(params.evt.jobId)) {
    params.warnedLegacyWebhookJobs.add(params.evt.jobId);
    params.logger.warn(
      {
        jobId: params.evt.jobId,
        legacyWebhook: redactWebhookUrl(webhookTarget.url),
      },
      "cron: deprecated notify+cron.webhook fallback in use, migrate to delivery.mode=webhook with delivery.to",
    );
  }

  if (webhookTarget && params.evt.summary) {
    void (async () => {
      await postCronWebhook({
        webhookUrl: webhookTarget.url,
        webhookToken,
        payload: params.evt,
        logContext: { jobId: params.evt.jobId },
        blockedLog: "cron: webhook delivery blocked by SSRF guard",
        failedLog: "cron: webhook delivery failed",
        logger: params.logger,
      });
    })();
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

  const failureMessage = `Cron job "${params.job.name}" failed: ${params.evt.error ?? "unknown error"}`;
  const failureDest = resolveFailureDestination(params.job, params.globalFailureDestination);
  const deliverySessionKey = resolveCronDeliverySessionKey(params.job);

  if (failureDest) {
    const failurePayload = {
      jobId: params.job.id,
      jobName: params.job.name,
      message: failureMessage,
      status: params.evt.status,
      error: params.evt.error,
      runAtMs: params.evt.runAtMs,
      durationMs: params.evt.durationMs,
      nextRunAtMs: params.evt.nextRunAtMs,
    };

    if (failureDest.mode === "webhook" && failureDest.to) {
      const webhookUrl = normalizeHttpWebhookUrl(failureDest.to);
      if (webhookUrl) {
        void (async () => {
          await postCronWebhook({
            webhookUrl,
            webhookToken: params.webhookToken,
            payload: failurePayload,
            logContext: { jobId: params.evt.jobId },
            blockedLog: "cron: failure destination webhook blocked by SSRF guard",
            failedLog: "cron: failure destination webhook failed",
            logger: params.logger,
          });
        })();
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
      const { agentId, cfg: runtimeConfig } = params.resolveCronAgent(params.job.agentId);
      void sendFailureNotificationAnnounce(
        params.deps,
        runtimeConfig,
        agentId,
        params.job.id,
        {
          channel: failureDest.channel,
          to: failureDest.to,
          accountId: failureDest.accountId,
          sessionKey: deliverySessionKey,
        },
        `⚠️ ${failureMessage}`,
      );
    }
    return;
  }

  const primaryPlan = resolveCronDeliveryPlan(params.job);
  if (primaryPlan.mode !== "announce" || !primaryPlan.requested) {
    return;
  }

  const { agentId, cfg: runtimeConfig } = params.resolveCronAgent(params.job.agentId);
  void sendFailureNotificationAnnounce(
    params.deps,
    runtimeConfig,
    agentId,
    params.job.id,
    {
      channel: primaryPlan.channel,
      to: primaryPlan.to,
      accountId: primaryPlan.accountId,
      sessionKey: deliverySessionKey,
    },
    `⚠️ ${failureMessage}`,
  );
}
