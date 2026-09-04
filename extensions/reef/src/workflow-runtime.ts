import type { ReefPeerIdentity } from "./friend-types.js";
import { getActiveReef } from "./runtime.js";
import { encodeReefWorkflowMessage } from "./workflow-inbox.js";
export { prepareReefMessageId } from "./flow.js";

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
