import type { EmbeddedRunAttemptResult } from "./types.js";

type TerminalPresentationObservation = {
  terminalPresentation?: string;
  toolCallOrdinal?: number;
};

export function createTerminalToolPresentationTracker() {
  let latestOrdinal = -1;
  let nextOrdinal = 0;
  let value: string | undefined;
  return {
    allocateOrdinal: () => nextOrdinal++,
    observe: (observation: TerminalPresentationObservation): void => {
      const ordinal = observation.toolCallOrdinal ?? latestOrdinal + 1;
      if (ordinal >= latestOrdinal) {
        latestOrdinal = ordinal;
        value = observation.terminalPresentation;
      }
    },
    read: () => value,
  };
}

export function copyAttemptDeliveryState(attempt: EmbeddedRunAttemptResult) {
  return {
    latestMcpAppChannelView: attempt.latestMcpAppChannelView,
    latestMcpConnectAction: attempt.latestMcpConnectAction,
    didSendViaMessagingTool: attempt.didSendViaMessagingTool,
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
