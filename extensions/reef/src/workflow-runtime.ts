import { z } from "zod";
import { PipelineError, ProtocolError } from "../protocol/index.js";
import { isPermanentReefOutboundRejection } from "./flow.js";
import type { ReefPeerIdentity } from "./friend-types.js";
import { getActiveReef } from "./runtime.js";
import { encodeReefWorkflowMessage } from "./workflow-inbox.js";
export { prepareReefMessageId } from "./flow.js";

/** Review and policy outcomes require an owner decision, never an automatic rewrite. */
export function classifyReefWorkflowSendError(
  error: unknown,
): "review-pending" | "rejected" | "retryable" {
  if (error instanceof PipelineError && error.reviewOutcome === "pending") {
    return "review-pending";
  }
  return error instanceof ProtocolError ||
    error instanceof z.ZodError ||
    isPermanentReefOutboundRejection(error)
    ? "rejected"
    : "retryable";
}

export {
  REEF_WORKFLOW_API_VERSION,
  registerReefWorkflowInbox,
  type ReefWorkflowMessage,
  type ReefWorkflowInboxRegistration,
} from "./workflow-inbox.js";

/** Queue one guarded transport attempt. Application acceptance is a separate workflow message. */
export async function sendReefWorkflowMessage(options: {
  protocol: string;
  peer: string;
  expectedPeer: ReefPeerIdentity;
  messageId: string;
  /** Reserve before guard evaluation; retain only while its proposal awaits review. */
  transportMessageId?: string;
  payload: unknown;
}): Promise<{ transportMessageId: string; status: "queued" }> {
  const { flow } = getActiveReef();
  const text = encodeReefWorkflowMessage({
    protocol: options.protocol,
    messageId: options.messageId,
    payload: options.payload,
  });
  const transportMessageId = await flow.send(options.peer, text, {
    expectedRecipient: options.expectedPeer,
    resendDisabled: true,
    ...(options.transportMessageId ? { messageId: options.transportMessageId } : {}),
    onPlatformSendDispatch: async () => {
      if (getActiveReef().flow !== flow) {
        throw new Error("Reef workflow channel changed before dispatch; retry after restart");
      }
    },
  });
  return { transportMessageId, status: "queued" };
}
