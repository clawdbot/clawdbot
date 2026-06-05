/** Sends cron announce payloads and best-effort failure notifications. */
import { sendDurableMessageBatch } from "../channels/message/runtime.js";
import type { CliDeps } from "../cli/deps.types.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../config/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveAgentOutboundIdentity } from "../infra/outbound/identity.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { getChildLogger } from "../logging.js";
import {
  resolveFailureDestination,
  type CronFailureDeliveryPlan,
  type CronFailureDestinationInput,
  type CronDeliveryPlan,
  resolveCronDeliveryPlan,
} from "./delivery-plan.js";
import {
  resolveDeliveryTarget,
  type DeliveryTargetResolution,
} from "./isolated-agent/delivery-target.js";
import { resolveCronNotificationSessionKey } from "./session-target.js";
import type { CronMessageChannel } from "./types.js";

export {
  resolveCronDeliveryPlan,
  resolveFailureDestination,
  type CronDeliveryPlan,
  type CronFailureDeliveryPlan,
  type CronFailureDestinationInput,
};

const FAILURE_NOTIFICATION_TIMEOUT_MS = 30_000;
const cronDeliveryLogger = getChildLogger({ subsystem: "cron-delivery" });

/** Channel target metadata used for cron announcements and failure notifications. */
export type CronAnnounceTarget = {
  channel?: string;
  to?: string;
  accountId?: string;
  sessionKey?: string;
};

type SuccessfulDeliveryTarget = Extract<DeliveryTargetResolution, { ok: true }>;

async function resolveCronAnnounceDelivery(params: {
  cfg: OpenClawConfig;
  agentId: string;
  jobId: string;
  target: CronAnnounceTarget;
}): Promise<
  | {
      ok: true;
      resolvedTarget: SuccessfulDeliveryTarget;
      session: ReturnType<typeof buildOutboundSessionContext>;
      identity: ReturnType<typeof resolveAgentOutboundIdentity>;
    }
  | { ok: false; error: Error }
> {
  // Resolve the target before building outbound identity/session so send errors
  // report the configured route, not only the cron job id.
  const resolvedTarget = await resolveDeliveryTarget(params.cfg, params.agentId, {
    channel: params.target.channel as CronMessageChannel | undefined,
    to: params.target.to,
    accountId: params.target.accountId,
    sessionKey: params.target.sessionKey,
  });

  if (!resolvedTarget.ok) {
    return { ok: false, error: resolvedTarget.error };
  }

  const identity = resolveAgentOutboundIdentity(params.cfg, params.agentId);
  const session = buildOutboundSessionContext({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: resolveCronNotificationSessionKey({
      jobId: params.jobId,
      sessionKey: params.target.sessionKey,
    }),
  });

  return {
    ok: true,
    resolvedTarget,
    session,
    identity,
  };
}

async function deliverCronAnnouncePayload(params: {
  deps: CliDeps;
  cfg: OpenClawConfig;
  delivery: {
    resolvedTarget: SuccessfulDeliveryTarget;
    session: ReturnType<typeof buildOutboundSessionContext>;
    identity: ReturnType<typeof resolveAgentOutboundIdentity>;
  };
  message: string;
  abortSignal: AbortSignal;
}): Promise<void> {
  // Cron delivery is durable and non-best-effort for primary announces; partial
  // channel failure must surface as a cron run failure.
  const send = await sendDurableMessageBatch({
    cfg: params.cfg,
    channel: params.delivery.resolvedTarget.channel,
    to: params.delivery.resolvedTarget.to,
    accountId: params.delivery.resolvedTarget.accountId,
    threadId: params.delivery.resolvedTarget.threadId,
    payloads: [{ text: params.message }],
    session: params.delivery.session,
    identity: params.delivery.identity,
    bestEffort: false,
    deps: createOutboundSendDeps(params.deps),
    signal: params.abortSignal,
  });
  if (send.status === "failed" || send.status === "partial_failed") {
    throw send.error;
  }
}

/** Sends a cron announce payload and throws if target resolution or delivery fails. */
export async function sendCronAnnouncePayloadStrict(params: {
  deps: CliDeps;
  cfg: OpenClawConfig;
  agentId: string;
  jobId: string;
  target: CronAnnounceTarget;
  message: string;
  abortSignal: AbortSignal;
}): Promise<void> {
  const delivery = await resolveCronAnnounceDelivery(params);
  if (!delivery.ok) {
    throw delivery.error;
  }
  await deliverCronAnnouncePayload({
    deps: params.deps,
    cfg: params.cfg,
    delivery,
    message: params.message,
    abortSignal: params.abortSignal,
  });
}

/** Sends a best-effort cron failure notification, logging resolution/send failures. */
export async function sendFailureNotificationAnnounce(
  deps: CliDeps,
  cfg: OpenClawConfig,
  agentId: string,
  jobId: string,
  target: CronAnnounceTarget,
  message: string,
): Promise<void> {
  const delivery = await resolveCronAnnounceDelivery({ cfg, agentId, jobId, target });

  if (!delivery.ok) {
    // Failure alerts must not mask the original cron run failure.
    cronDeliveryLogger.warn(
      { error: delivery.error.message },
      "cron: failed to resolve failure destination target",
    );
    return;
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    // Failure notifications are secondary; timeout prevents a stuck channel send
    // from extending an already-failed cron run.
    abortController.abort();
  }, FAILURE_NOTIFICATION_TIMEOUT_MS);

  try {
    await deliverCronAnnouncePayload({
      deps,
      cfg,
      delivery,
      message,
      abortSignal: abortController.signal,
    });
  } catch (err) {
    cronDeliveryLogger.warn(
      {
        err: formatErrorMessage(err),
        channel: delivery.resolvedTarget.channel,
        to: delivery.resolvedTarget.to,
      },
      "cron: failure destination announce failed",
    );
  } finally {
    clearTimeout(timeout);
  }
}
