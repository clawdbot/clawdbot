import { beginDiscordActiveTurnThreadRoute } from "../active-turn-thread-route.js";

type DiscordReplyReference = {
  peek: () => string | undefined;
  use: () => string | undefined;
  markSent: () => void;
  hasReplied: () => boolean;
};

export function createDiscordMessageActiveThreadRoute(params: {
  sessionKey?: string;
  accountId?: string;
  sourceChannelId: string;
  sourceMessageId: string;
  sourceReplyReference: DiscordReplyReference;
  log: (message: string) => void;
}) {
  let adoptedThreadId: string | undefined;
  // Delivery is dispatch-scoped: the model may continue after the message tool
  // returns, but that continuation cannot undo the visible thread reply.
  let threadReplyDelivered = false;
  let onThreadAdopted: ((threadId: string) => Promise<void>) | undefined;
  const end = beginDiscordActiveTurnThreadRoute(params.sessionKey, {
    accountId: params.accountId,
    sourceChannelId: params.sourceChannelId,
    sourceMessageId: params.sourceMessageId,
    onThreadAdopted: async (threadId) => {
      // Route identity must change before migration so a successful thread
      // reply remains current-source even when moving the draft later fails.
      adoptedThreadId = threadId;
      await onThreadAdopted?.(threadId);
    },
    onThreadReplyDelivered: () => {
      threadReplyDelivered = true;
    },
    onThreadAdoptionError: (error) => {
      params.log(`discord: failed to move active progress into adopted thread (${String(error)})`);
    },
  });

  return {
    replyReference: {
      peek: () => (adoptedThreadId ? undefined : params.sourceReplyReference.peek()),
      use: () => (adoptedThreadId ? undefined : params.sourceReplyReference.use()),
      markSent: () => params.sourceReplyReference.markSent(),
      hasReplied: () => Boolean(adoptedThreadId) || params.sourceReplyReference.hasReplied(),
    },
    bindThreadAdoption(callback: (threadId: string) => Promise<void>) {
      onThreadAdopted = callback;
    },
    get threadReplyDelivered() {
      return threadReplyDelivered;
    },
    end,
  };
}
