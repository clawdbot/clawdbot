import type { Conversation, Message, Thread } from "./ui-types.js";

type ConversationIdentity = Pick<Conversation, "accountId" | "id" | "kind">;

// Raw ids can collide across accounts and conversation kinds. Keep one key
// shape for sidebar selection, transcript filtering, and thread navigation.
export function conversationSelectionKey(identity: ConversationIdentity): string {
  return JSON.stringify([identity.accountId, identity.kind, identity.id]);
}

export function findConversationBySelectionKey(
  conversations: Conversation[],
  selectionKey: string | null,
): Conversation | undefined {
  if (!selectionKey) {
    return undefined;
  }
  return conversations.find(
    (conversation) => conversationSelectionKey(conversation) === selectionKey,
  );
}

export function messageConversationSelectionKey(message: Message): string {
  return conversationSelectionKey({
    accountId: message.accountId,
    id: message.conversation.id,
    kind: message.conversation.kind,
  });
}

export function threadConversationSelectionKey(thread: Thread): string {
  // QA bus thread records come only from channel-scoped createThread; direct
  // message thread ids do not create sidebar thread records.
  return conversationSelectionKey({
    accountId: thread.accountId,
    id: thread.conversationId,
    kind: "channel",
  });
}
