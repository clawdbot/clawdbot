/**
 * Carries confirmed CLI messaging delivery across failed execution/finalization paths.
 */
import type { CliOutput } from "../cli-output.js";

const CLI_MESSAGING_DELIVERY_EVIDENCE_KEY = "cliMessagingDeliveryEvidence";

type CliMessagingDeliveryEvidence = Pick<
  CliOutput,
  | "didSendViaMessagingTool"
  | "didDeliverSourceReplyViaMessageTool"
  | "messagingToolSentTexts"
  | "messagingToolSentMediaUrls"
  | "messagingToolSentTargets"
  | "messagingToolSourceReplyPayloads"
>;

function snapshotCliMessagingDeliveryEvidence(
  output: CliMessagingDeliveryEvidence,
): CliMessagingDeliveryEvidence | undefined {
  if (output.didSendViaMessagingTool !== true) {
    return undefined;
  }
  return {
    didSendViaMessagingTool: true,
    ...(output.didDeliverSourceReplyViaMessageTool
      ? { didDeliverSourceReplyViaMessageTool: true }
      : {}),
    ...(output.messagingToolSentTexts?.length
      ? { messagingToolSentTexts: output.messagingToolSentTexts.slice() }
      : {}),
    ...(output.messagingToolSentMediaUrls?.length
      ? { messagingToolSentMediaUrls: output.messagingToolSentMediaUrls.slice() }
      : {}),
    ...(output.messagingToolSentTargets?.length
      ? { messagingToolSentTargets: output.messagingToolSentTargets.slice() }
      : {}),
    ...(output.messagingToolSourceReplyPayloads?.length
      ? { messagingToolSourceReplyPayloads: output.messagingToolSourceReplyPayloads.slice() }
      : {}),
  };
}

/** Attaches confirmed delivery evidence so caller retries cannot duplicate a visible send. */
export function attachCliMessagingDeliveryEvidence(
  error: unknown,
  output: CliMessagingDeliveryEvidence,
): unknown {
  const evidence = snapshotCliMessagingDeliveryEvidence(output);
  if (!evidence) {
    return error;
  }
  if (error && typeof error === "object") {
    try {
      Object.assign(error, { [CLI_MESSAGING_DELIVERY_EVIDENCE_KEY]: evidence });
      return error;
    } catch {
      // Frozen and non-extensible failures need a mutable wrapper.
    }
  }
  const wrapped = new Error(error instanceof Error ? error.message : String(error), {
    cause: error,
  });
  Object.assign(wrapped, { [CLI_MESSAGING_DELIVERY_EVIDENCE_KEY]: evidence });
  return wrapped;
}

/** Reads confirmed delivery evidence from a failed CLI attempt. */
export function getCliMessagingDeliveryEvidence(
  error: unknown,
): CliMessagingDeliveryEvidence | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const evidence = (error as Record<string, unknown>)[CLI_MESSAGING_DELIVERY_EVIDENCE_KEY];
  return evidence && typeof evidence === "object"
    ? snapshotCliMessagingDeliveryEvidence(evidence as CliMessagingDeliveryEvidence)
    : undefined;
}
