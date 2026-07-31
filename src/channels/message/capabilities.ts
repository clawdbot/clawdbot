import type { ReplyPayload } from "../../auto-reply/types.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
/**
 * Channel message capability derivation.
 *
 * Computes durable-final delivery requirements from a concrete outbound payload.
 */
import type {
  DeriveDurableFinalDeliveryRequirementsParams,
  DurableFinalDeliveryCapability,
  DurableFinalDeliveryRequirementMap,
} from "./types.js";

function hasMediaPayload(
  payload: DeriveDurableFinalDeliveryRequirementsParams["payload"],
): boolean {
  if (payload.mediaUrl?.trim()) {
    return true;
  }
  return (
    Array.isArray(payload.mediaUrls) &&
    payload.mediaUrls.some((url) => typeof url === "string" && url.trim().length > 0)
  );
}

function setRequired(
  requirements: DurableFinalDeliveryRequirementMap,
  capability: DurableFinalDeliveryCapability,
  required: boolean | undefined,
): void {
  if (required === true) {
    requirements[capability] = true;
  }
}

/** Derives the adapter capabilities core needs before it can require durable final delivery. */
export function deriveDurableFinalDeliveryRequirements(
  params: DeriveDurableFinalDeliveryRequirementsParams,
): DurableFinalDeliveryRequirementMap {
  const requirements: DurableFinalDeliveryRequirementMap = {};
  setRequired(requirements, "text", true);
  setRequired(requirements, "media", hasMediaPayload(params.payload));
  setRequired(
    requirements,
    "replyTo",
    params.replyToId != null || params.payload.replyToId != null,
  );
  setRequired(requirements, "thread", params.threadId != null);
  setRequired(requirements, "silent", params.silent);
  setRequired(requirements, "messageSendingHooks", params.messageSendingHooks !== false);
  setRequired(requirements, "payload", params.payloadTransport);
  setRequired(requirements, "batch", params.batch);
  setRequired(requirements, "reconcileUnknownSend", params.reconcileUnknownSend);
  setRequired(requirements, "afterSendSuccess", params.afterSendSuccess);
  setRequired(requirements, "afterCommit", params.afterCommit);

  for (const [capability, required] of Object.entries(params.extraCapabilities ?? {}) as Array<
    [DurableFinalDeliveryCapability, boolean | undefined]
  >) {
    setRequired(requirements, capability, required);
  }

  return requirements;
}

/** Matches the structured-payload branch selected by core delivery. */
export function payloadRequiresDurablePayloadTransport(
  payload: ReplyPayload,
  options?: { sendTextOnlyErrorPayloads?: boolean },
): boolean {
  return (
    (payload.isError === true && options?.sendTextOnlyErrorPayloads === true) ||
    hasReplyPayloadContent(
      {
        presentation: payload.presentation,
        interactive: payload.interactive,
        channelData: payload.channelData,
        location: payload.location,
      },
      { extraContent: payload.location != null },
    ) ||
    payload.audioAsVoice === true ||
    payload.videoAsNote === true
  );
}

/** Derives the union of required capabilities from the final concrete batch. */
export function deriveDurableFinalDeliveryRequirementsForBatch(params: {
  payloads: readonly ReplyPayload[];
  replyToId?: string | null;
  threadId?: string | number | null;
  silent?: boolean;
  reconcileUnknownSend?: boolean;
}): DurableFinalDeliveryRequirementMap {
  // Preserve the public preflight diagnostic: exact delivery first reports
  // missing reconciliation before secondary transport capabilities.
  const requirements: DurableFinalDeliveryRequirementMap =
    params.reconcileUnknownSend && params.payloads.length > 0 ? { reconcileUnknownSend: true } : {};
  for (const payload of params.payloads) {
    const current = deriveDurableFinalDeliveryRequirements({
      payload,
      replyToId: params.replyToId,
      threadId: params.threadId,
      silent: params.silent,
      payloadTransport: payloadRequiresDurablePayloadTransport(payload),
      batch: params.payloads.length > 1,
      reconcileUnknownSend: params.reconcileUnknownSend,
    });
    for (const [capability, required] of Object.entries(current) as Array<
      [DurableFinalDeliveryCapability, boolean | undefined]
    >) {
      setRequired(requirements, capability, required);
    }
  }
  return requirements;
}
