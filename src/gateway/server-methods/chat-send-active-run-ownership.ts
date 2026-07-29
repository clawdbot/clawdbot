/**
 * Decide whether chat.send still owns user-turn fallback persistence.
 *
 * Steered and queued followups are already owned by the active runtime or a
 * later aggregate turn. Writing through the gateway fallback while an embedded
 * prompt lock is released appends a foreign user turn and kills the active run
 * with EmbeddedAttemptSessionTakeoverError (#113194).
 */
function shouldFinalizeChatSendAsNonAgent(params: {
  agentRunStarted: boolean;
  queuedFollowupEnqueued: boolean;
  activeRunTurnAdopted: boolean;
}): boolean {
  return !params.agentRunStarted && !params.queuedFollowupEnqueued && !params.activeRunTurnAdopted;
}

/** Successful steer/queue admission ends this client run; a later turn owns work. */
function shouldTerminalizeDeferredChatSend(params: {
  queuedFollowupEnqueued: boolean;
  activeRunTurnAdopted: boolean;
}): boolean {
  return params.queuedFollowupEnqueued || params.activeRunTurnAdopted;
}

/** Track steer vs followup ownership for chat.send post-dispatch. */
export function createChatSendActiveRunOwnership() {
  let queuedFollowupEnqueued = false;
  let activeRunTurnAdopted = false;
  return {
    markQueuedFollowupEnqueued: () => {
      queuedFollowupEnqueued = true;
    },
    markActiveRunTurnAdopted: () => {
      activeRunTurnAdopted = true;
    },
    isQueuedFollowupEnqueued: () => queuedFollowupEnqueued,
    isActiveRunTurnAdopted: () => activeRunTurnAdopted,
    shouldFinalizeAsNonAgent: (agentRunStarted: boolean) =>
      shouldFinalizeChatSendAsNonAgent({
        agentRunStarted,
        queuedFollowupEnqueued,
        activeRunTurnAdopted,
      }),
    shouldTerminalize: () =>
      shouldTerminalizeDeferredChatSend({
        queuedFollowupEnqueued,
        activeRunTurnAdopted,
      }),
  };
}
