type SlackDraftConversation = {
  accountId?: string;
  teamId?: string;
  channelId: string;
  threadTs?: string;
};

type ActiveSlackDraft = {
  messageTs: string;
  onInterveningMessage: () => void;
};

const activeDraftsByConversation = new Map<string, Set<ActiveSlackDraft>>();

function conversationKey(conversation: SlackDraftConversation): string {
  return [
    conversation.accountId ?? "default",
    conversation.teamId ?? "",
    conversation.channelId,
    conversation.threadTs ?? "",
  ].join(":");
}

function isLaterSlackMessage(candidate: string, current: string): boolean {
  const candidateTimestamp = Number(candidate);
  const currentTimestamp = Number(current);
  return (
    Number.isFinite(candidateTimestamp) &&
    Number.isFinite(currentTimestamp) &&
    candidateTimestamp > currentTimestamp
  );
}

/** Keeps a live preview attached to its actual place in the Slack conversation. */
export function trackSlackDraftMessage(
  conversation: SlackDraftConversation & ActiveSlackDraft,
): () => void {
  const key = conversationKey(conversation);
  const activeDraft: ActiveSlackDraft = {
    messageTs: conversation.messageTs,
    onInterveningMessage: conversation.onInterveningMessage,
  };
  const drafts = activeDraftsByConversation.get(key) ?? new Set<ActiveSlackDraft>();
  drafts.add(activeDraft);
  activeDraftsByConversation.set(key, drafts);

  return () => {
    const currentDrafts = activeDraftsByConversation.get(key);
    currentDrafts?.delete(activeDraft);
    if (currentDrafts?.size === 0) {
      activeDraftsByConversation.delete(key);
    }
  };
}

/** A later human message means subsequent assistant output belongs below it. */
export function noteSlackDraftConversationMessage(
  conversation: SlackDraftConversation & {
    messageTs?: string;
    userId?: string;
    botUserId?: string;
    botId?: string;
    subtype?: string;
  },
): void {
  if (
    !conversation.messageTs ||
    !conversation.userId ||
    conversation.userId === conversation.botUserId ||
    conversation.botId ||
    conversation.subtype === "bot_message"
  ) {
    return;
  }

  const drafts = activeDraftsByConversation.get(conversationKey(conversation));
  if (!drafts) {
    return;
  }

  for (const draft of drafts) {
    if (isLaterSlackMessage(conversation.messageTs, draft.messageTs)) {
      draft.onInterveningMessage();
    }
  }
}
