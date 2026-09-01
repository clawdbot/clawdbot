import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
} from "../../infra/outbound/payloads.js";
import { commitBackgroundResultToSession } from "../../sessions/background-session-result.js";
import { createCronExecutionId } from "../run-id.js";
import {
  buildDirectCronTranscriptMirrorPayloads,
  resolveDirectCronTranscriptMirrorText,
} from "./delivery-dispatch-awareness.js";
import type { DispatchCronDeliveryParams } from "./delivery-dispatch-types.js";
import { resolvedDeliveryTargetsExternalChannel } from "./delivery-target.js";

type CurrentSessionCompletionResult =
  | { ok: false; reason: string }
  | { ok: true; requiresExternalDelivery: boolean; deliveryError?: string };

export async function commitCurrentSessionCronCompletion(
  params: DispatchCronDeliveryParams,
  text?: string,
): Promise<CurrentSessionCompletionResult> {
  const sourceSessionKey = params.sourceSessionKey?.trim();
  if (!sourceSessionKey) {
    return { ok: false, reason: "current cron delivery is missing its source session binding" };
  }
  if (!params.sourceSessionGeneration) {
    return { ok: false, reason: "current cron delivery is missing its source session generation" };
  }
  const completionText =
    resolveDirectCronTranscriptMirrorText(
      projectOutboundPayloadPlanForMirror(
        createOutboundPayloadPlan(buildDirectCronTranscriptMirrorPayloads(params.deliveryPayloads)),
      ),
    ) ?? normalizeOptionalString(text);
  if (!completionText) {
    return { ok: false, reason: "current cron completion has no durable transcript projection" };
  }
  const runId = createCronExecutionId(params.job.id, params.runStartedAt);
  const committed = await commitBackgroundResultToSession({
    agentId: params.agentId,
    sessionKey: sourceSessionKey,
    expectedGeneration: params.sourceSessionGeneration,
    text: completionText,
    idempotencyKey: `cron-current-completion:${runId}`,
    provenance: { kind: "cron", jobId: params.job.id, runId },
    config: params.cfgWithAgentDefaults,
    signal: params.abortSignal,
  });
  if (!committed.ok) {
    return committed;
  }
  if (params.sourceDeliveryOutcome.satisfiesSourceDelivery) {
    return { ok: true, requiresExternalDelivery: false };
  }
  if (params.resolvedDelivery.ok) {
    return { ok: true, requiresExternalDelivery: true };
  }
  // The completion is durably committed to the target conversation. When the
  // failed resolution names an external channel route, that route still owed a
  // send — report it as a delivery failure without failing the committed turn.
  // With no external route (internal webchat/Control UI conversations, or a
  // gateway with no channels configured), the commit IS the delivery.
  if (resolvedDeliveryTargetsExternalChannel(params.resolvedDelivery)) {
    return {
      ok: true,
      requiresExternalDelivery: false,
      deliveryError: params.resolvedDelivery.error.message,
    };
  }
  return { ok: true, requiresExternalDelivery: false };
}
