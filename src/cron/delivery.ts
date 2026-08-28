/** Sends cron announce payloads and best-effort failure notifications. */

import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import {
  durableMessageBatchMayHaveReachedRecipient,
  sendDurableMessageBatchCore,
} from "../channels/message/runtime.js";
import type { CliDeps } from "../cli/deps.types.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveAgentOutboundIdentity } from "../infra/outbound/identity.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveCronDeliveryPlan } from "./delivery-plan.js";
import {
  resolveDeliveryTarget,
  type DeliveryTargetResolution,
} from "./isolated-agent/delivery-target.js";
import { resolveCronNotificationSessionKey } from "./session-target.js";
import type { CronMessageChannel } from "./types.js";

export { resolveCronDeliveryPlan };

/** Channel target metadata used for cron announcements and failure notifications. */
type CronAnnounceTarget = {
  channel?: string;
  to?: string;
  threadId?: string | number;
  accountId?: string;
  sessionKey?: string;
  inheritSessionThread?: boolean;
};

type SuccessfulDeliveryTarget = Extract<DeliveryTargetResolution, { ok: true }>;
type CronAnnounceDeliveryOutcome = Extract<
  Awaited<ReturnType<typeof sendDurableMessageBatchCore>>,
  { status: "sent" | "suppressed" }
>;

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
  const targetResolutionOptions =
    params.target.inheritSessionThread === false ? { inheritSessionThread: false } : undefined;
  const resolvedTarget = await resolveDeliveryTarget(
    params.cfg,
    params.agentId,
    {
      channel: params.target.channel as CronMessageChannel | undefined,
      to: params.target.to,
      threadId: params.target.threadId,
      accountId: params.target.accountId,
      sessionKey: params.target.sessionKey,
    },
    targetResolutionOptions,
  );

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

/** Sends a cron announce payload and throws if target resolution or delivery fails. */
export async function sendCronAnnouncePayloadStrict(params: {
  deps: CliDeps;
  cfg: OpenClawConfig;
  agentId: string;
  jobId: string;
  target: CronAnnounceTarget;
  payload: ReplyPayload;
  abortSignal: AbortSignal;
  onDeliveryAttempt?: (reachedRecipient: boolean) => void;
}): Promise<CronAnnounceDeliveryOutcome> {
  const delivery = await resolveCronAnnounceDelivery(params);
  if (!delivery.ok) {
    throw delivery.error;
  }
  // Resolution can settle after its caller's deadline; never start plugin
  // delivery once the Gateway has released ownership of the timed-out work.
  params.abortSignal.throwIfAborted();

  // Cron delivery is durable and non-best-effort for primary announces; partial
  // channel failure must surface as a cron run failure.
  let recipientReached = false;
  const send = await sendDurableMessageBatchCore({
    cfg: params.cfg,
    channel: delivery.resolvedTarget.channel,
    to: delivery.resolvedTarget.to,
    accountId: delivery.resolvedTarget.accountId,
    threadId: delivery.resolvedTarget.threadId,
    payloads: [params.payload],
    session: delivery.session,
    identity: delivery.identity,
    bestEffort: false,
    deps: createOutboundSendDeps(params.deps),
    signal: params.abortSignal,
    onDeliveryResult: () => {
      if (!recipientReached) {
        recipientReached = true;
        params.onDeliveryAttempt?.(true);
      }
    },
  });
  if (!recipientReached) {
    params.onDeliveryAttempt?.(durableMessageBatchMayHaveReachedRecipient(send));
  }
  if (send.status === "failed" || send.status === "partial_failed") {
    throw send.error;
  }
  return send;
}
