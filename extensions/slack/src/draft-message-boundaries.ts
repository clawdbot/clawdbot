type SlackDraftConversation = {
  accountId?: string;
  teamId?: string;
  channelId: string;
  threadTs?: string;
};

type ActiveSlackReply = {
  messageTs?: string;
  latestHumanMessage?: SlackConversationMessageBoundary;
  onInterveningMessage: (boundary: SlackConversationMessageBoundary) => void;
};

export type SlackConversationMessageBoundary = {
  messageTs: string;
  threadTs?: string;
};

export type SlackMessageBoundaryTracker = {
  setMessageTs: (messageTs: string) => void;
  stop: () => void;
};

const activeRepliesByConversation = new Map<string, Set<ActiveSlackReply>>();

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

/** Keeps an in-flight reply attached to its actual place in the Slack conversation. */
export function trackSlackConversationMessage(
  conversation: SlackDraftConversation & ActiveSlackReply,
): SlackMessageBoundaryTracker {
  const key = conversationKey(conversation);
  const activeReply: ActiveSlackReply = {
    messageTs: conversation.messageTs,
    onInterveningMessage: conversation.onInterveningMessage,
  };
  const replies = activeRepliesByConversation.get(key) ?? new Set<ActiveSlackReply>();
  replies.add(activeReply);
  activeRepliesByConversation.set(key, replies);

  const stop = () => {
    const currentReplies = activeRepliesByConversation.get(key);
    currentReplies?.delete(activeReply);
    if (currentReplies?.size === 0) {
      activeRepliesByConversation.delete(key);
    }
  };

  return {
    setMessageTs: (messageTs) => {
      activeReply.messageTs = messageTs;
      if (
        activeReply.latestHumanMessage &&
        isLaterSlackMessage(activeReply.latestHumanMessage.messageTs, messageTs)
      ) {
        activeReply.onInterveningMessage(activeReply.latestHumanMessage);
      }
    },
    stop,
  };
}

/** A later human message means subsequent assistant output belongs below it. */
export function noteSlackConversationMessage(
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

  const replies = activeRepliesByConversation.get(conversationKey(conversation));
  if (!replies) {
    return;
  }

  for (const reply of replies) {
    const boundary: SlackConversationMessageBoundary = {
      messageTs: conversation.messageTs,
      ...(conversation.threadTs ? { threadTs: conversation.threadTs } : {}),
    };
    if (!reply.messageTs) {
      if (
        !reply.latestHumanMessage ||
        isLaterSlackMessage(conversation.messageTs, reply.latestHumanMessage.messageTs)
      ) {
        // Slack can deliver the next message before chat.postMessage returns its timestamp.
        reply.latestHumanMessage = boundary;
      }
      continue;
    }
    if (isLaterSlackMessage(conversation.messageTs, reply.messageTs)) {
      reply.onInterveningMessage(boundary);
    }
  }
}
