import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
} from "../../infra/outbound/payloads.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { commitBackgroundResultToSession } from "../../sessions/background-session-result.js";
import { createCronExecutionId } from "../run-id.js";
import {
  buildDirectCronTranscriptMirrorPayloads,
  resolveDirectCronTranscriptMirrorText,
} from "./delivery-dispatch-awareness.js";
import type { DispatchCronDeliveryParams } from "./delivery-dispatch-types.js";

type CurrentSessionCompletionResult =
  | { ok: false; reason: string }
  | { ok: true; requiresExternalDelivery: boolean };

export async function commitCurrentSessionCronCompletion(
  params: DispatchCronDeliveryParams,
  text?: string,
): Promise<CurrentSessionCompletionResult> {
  const sourceSessionKey = params.sourceSessionKey?.trim();
  if (!sourceSessionKey) {
    return { ok: false, reason: "current cron delivery is missing its source session binding" };
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
  const sourceChannel = parseAgentSessionKey(sourceSessionKey)?.rest.split(":")[0];
  if (params.resolvedDelivery.channel === "webchat" || sourceChannel === "webchat") {
    return { ok: true, requiresExternalDelivery: false };
  }
  return { ok: false, reason: params.resolvedDelivery.error.message };
}
