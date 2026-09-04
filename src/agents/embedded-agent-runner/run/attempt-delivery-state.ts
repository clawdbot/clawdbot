import type { EmbeddedRunAttemptResult } from "./types.js";

export function copyAttemptDeliveryState(attempt: EmbeddedRunAttemptResult) {
  return {
    latestMcpAppChannelView: attempt.latestMcpAppChannelView,
    latestMcpConnectAction: attempt.latestMcpConnectAction,
    didSendViaMessagingTool: attempt.didSendViaMessagingTool,
    sourceReplyDelivered: attempt.sourceReplyDelivered,
    didDeliverSourceReplyViaMessageTool: attempt.didDeliverSourceReplyViaMessageTool === true,
    didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
    messagingToolSentTexts: attempt.messagingToolSentTexts,
    messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
    messagingToolSentTargets: attempt.messagingToolSentTargets,
    messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads,
    heartbeatToolResponse: attempt.heartbeatToolResponse,
    successfulCronAdds: attempt.successfulCronAdds,
    acceptedSessionSpawns: attempt.acceptedSessionSpawns,
  };
}
