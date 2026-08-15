// Qa Lab plugin module implements bus state behavior.
import { randomUUID } from "node:crypto";
import {
  buildQaBusSnapshot,
  cloneMessage,
  normalizeAccountId,
  normalizeConversationFromTarget,
  pollQaBusEvents,
  readQaBusMessage,
  requireQaBusMessageForAccount,
  searchQaBusMessages,
} from "./bus-queries.js";
import { createQaBusWaiterStore } from "./bus-waiters.js";
import { sanitizeQaBusToolCalls } from "./qa-bus-protocol.js";
import type {
  QaBusAttachment,
  QaBusConversation,
  QaBusCreateThreadInput,
  QaBusDeleteMessageInput,
  QaBusEditMessageInput,
  QaBusEvent,
  QaBusInboundMessageInput,
  QaBusMessage,
  QaBusOutboundMessageInput,
  QaBusPollInput,
  QaBusReadMessageInput,
  QaBusReactToMessageInput,
  QaBusSearchMessagesInput,
  QaBusSnapshotConversation,
  QaBusStateSnapshot,
  QaBusThread,
  QaBusToolCall,
  QaBusWaitForInput,
} from "./runtime-api.js";

const DEFAULT_BOT_ID = "openclaw";
const DEFAULT_BOT_NAME = "OpenClaw QA";

function normalizeInboundConversation(conversation: QaBusConversation): QaBusConversation {
  const rawKind = (conversation as { kind?: unknown }).kind;
  const kind = rawKind === "dm" ? "direct" : rawKind;
  if (kind !== "direct" && kind !== "channel" && kind !== "group") {
    throw new Error(`invalid qa-channel conversation kind: ${String(rawKind)}`);
  }
  return kind === conversation.kind ? conversation : { ...conversation, kind };
}

type QaBusEventSeed =
  | {
      kind: "inbound-message";
      accountId: string;
      message: QaBusMessage;
    }
  | {
      kind: "outbound-message";
      accountId: string;
      message: QaBusMessage;
    }
  | {
      kind: "thread-created";
      accountId: string;
      thread: QaBusThread;
    }
  | {
      kind: "message-edited";
      accountId: string;
      message: QaBusMessage;
    }
  | {
      kind: "message-deleted";
      accountId: string;
      message: QaBusMessage;
    }
  | {
      kind: "reaction-added";
      accountId: string;
      message: QaBusMessage;
      emoji: string;
      senderId: string;
    };

export function createQaBusState() {
  const conversations = new Map<string, QaBusSnapshotConversation>();
  const threads = new Map<string, QaBusThread>();
  const messages = new Map<string, QaBusMessage>();
  const events: QaBusEvent[] = [];
  const acknowledgedPollCursors = new Map<string, number>();
  let cursor = 0;
  const waiters = createQaBusWaiterStore(() =>
    buildQaBusSnapshot({
      cursor,
      conversations,
      threads,
      messages,
      events,
    }),
  );

  const pushEvent = (event: QaBusEventSeed | ((cursor: number) => QaBusEventSeed)): QaBusEvent => {
    cursor += 1;
    const next = typeof event === "function" ? event(cursor) : event;
    const finalized = { cursor, ...next } as QaBusEvent;
    events.push(finalized);
    waiters.settle();
    return finalized;
  };

  const ensureConversation = (
    accountId: string,
    conversation: QaBusConversation,
  ): QaBusSnapshotConversation => {
    const key = JSON.stringify([accountId, conversation.kind, conversation.id]);
    const existing = conversations.get(key);
    if (existing) {
      if (!existing.title && conversation.title) {
        existing.title = conversation.title;
      }
      return existing;
    }
    const created = { ...conversation, accountId };
    conversations.set(key, created);
    return created;
  };

  const requireActiveMessageForAccount = (
    input: Pick<QaBusReadMessageInput, "accountId" | "messageId">,
  ): QaBusMessage => {
    const message = requireQaBusMessageForAccount({ messages, input });
    if (message.deleted) {
      throw new Error(`qa-bus message was deleted: ${input.messageId}`);
    }
    return message;
  };

  const createMessage = (params: {
    direction: QaBusMessage["direction"];
    accountId: string;
    messageId?: string;
    conversation: QaBusConversation;
    senderId: string;
    senderName?: string;
    text: string;
    isError?: boolean;
    timestamp?: number;
    threadId?: string;
    threadTitle?: string;
    replyToId?: string;
    attachments?: QaBusAttachment[];
    nativeCommand?: QaBusInboundMessageInput["nativeCommand"];
    toolCalls?: QaBusToolCall[];
  }): QaBusMessage => {
    const thread = params.threadId ? threads.get(params.threadId) : undefined;
    if (
      thread &&
      (thread.accountId !== params.accountId ||
        thread.conversationId !== params.conversation.id ||
        params.conversation.kind !== "channel")
    ) {
      // Unknown ids can represent externally observed threads; owned records
      // must never cross account, conversation, or channel-kind boundaries.
      throw new Error("qa-bus thread not found in selected account and conversation");
    }
    const storedConversation = ensureConversation(params.accountId, params.conversation);
    const toolCalls = sanitizeQaBusToolCalls(params.toolCalls);
    const message: QaBusMessage = {
      // Adopt native identity before indexing or publishing any message clone.
      id: params.messageId ?? randomUUID(),
      accountId: params.accountId,
      direction: params.direction,
      conversation: {
        id: storedConversation.id,
        kind: storedConversation.kind,
        ...(storedConversation.title ? { title: storedConversation.title } : {}),
      },
      senderId: params.senderId,
      senderName: params.senderName,
      text: params.text,
      ...(params.isError === true ? { isError: true } : {}),
      timestamp: params.timestamp ?? Date.now(),
      threadId: params.threadId,
      threadTitle: params.threadTitle,
      replyToId: params.replyToId,
      attachments: params.attachments?.map((attachment) => ({ ...attachment })) ?? [],
      ...(params.nativeCommand ? { nativeCommand: { ...params.nativeCommand } } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      reactions: [],
    };
    // Provider IDs are conversation-local and must never replace another chat's message.
    const { accountId, conversation, id } = message;
    messages.set(JSON.stringify([accountId, conversation.kind, conversation.id, id]), message);
    return message;
  };

  return {
    reset() {
      conversations.clear();
      threads.clear();
      messages.clear();
      events.length = 0;
      // Keep the cursor monotonic across resets so long-poll clients do not
      // miss fresh events and retained restart acknowledgements remain valid.
      waiters.reset();
    },
    getSnapshot() {
      return buildQaBusSnapshot({
        cursor,
        conversations,
        threads,
        messages,
        events,
      });
    },
    addInboundMessage(input: QaBusInboundMessageInput, messageId?: string) {
      const accountId = normalizeAccountId(input.accountId);
      const message = createMessage({
        direction: "inbound",
        accountId,
        messageId,
        // `dm:` is the canonical target spelling and is also used by manual
        // QA-bus clients. Normalize its matching ingress alias before routing
        // so a DM can never silently acquire group/channel privacy semantics.
        conversation: normalizeInboundConversation(input.conversation),
        senderId: input.senderId,
        senderName: input.senderName,
        text: input.text,
        timestamp: input.timestamp,
        threadId: input.threadId,
        threadTitle: input.threadTitle,
        replyToId: input.replyToId,
        attachments: input.attachments,
        nativeCommand: input.nativeCommand,
        toolCalls: input.toolCalls,
      });
      pushEvent({
        kind: "inbound-message",
        accountId,
        message: cloneMessage(message),
      });
      return cloneMessage(message);
    },
    addOutboundMessage(input: QaBusOutboundMessageInput) {
      const accountId = normalizeAccountId(input.accountId);
      const { conversation, threadId } = normalizeConversationFromTarget(input.to);
      const message = createMessage({
        direction: "outbound",
        accountId,
        conversation,
        senderId: input.senderId?.trim() || DEFAULT_BOT_ID,
        senderName: input.senderName?.trim() || DEFAULT_BOT_NAME,
        text: input.text,
        isError: input.isError,
        timestamp: input.timestamp,
        threadId: input.threadId ?? threadId,
        replyToId: input.replyToId,
        attachments: input.attachments,
        toolCalls: input.toolCalls,
      });
      pushEvent({
        kind: "outbound-message",
        accountId,
        message: cloneMessage(message),
      });
      return cloneMessage(message);
    },
    createThread(input: QaBusCreateThreadInput) {
      const accountId = normalizeAccountId(input.accountId);
      const thread: QaBusThread = {
        id: `thread-${randomUUID()}`,
        accountId,
        conversationId: input.conversationId,
        title: input.title,
        createdAt: input.timestamp ?? Date.now(),
        createdBy: input.createdBy?.trim() || DEFAULT_BOT_ID,
      };
      threads.set(thread.id, thread);
      ensureConversation(accountId, {
        id: input.conversationId,
        kind: "channel",
      });
      pushEvent({
        kind: "thread-created",
        accountId,
        thread: { ...thread },
      });
      return { ...thread };
    },
    reactToMessage(input: QaBusReactToMessageInput) {
      const accountId = normalizeAccountId(input.accountId);
      const message = requireActiveMessageForAccount(input);
      const reaction = {
        emoji: input.emoji,
        senderId: input.senderId?.trim() || DEFAULT_BOT_ID,
        timestamp: input.timestamp ?? Date.now(),
      };
      if (
        message.reactions.some(
          (existing) =>
            existing.emoji === reaction.emoji && existing.senderId === reaction.senderId,
        )
      ) {
        return cloneMessage(message);
      }
      message.reactions.push(reaction);
      pushEvent({
        kind: "reaction-added",
        accountId,
        message: cloneMessage(message),
        emoji: reaction.emoji,
        senderId: reaction.senderId,
      });
      return cloneMessage(message);
    },
    editMessage(input: QaBusEditMessageInput) {
      const accountId = normalizeAccountId(input.accountId);
      const message = requireActiveMessageForAccount(input);
      message.text = input.text;
      message.editedAt = input.timestamp ?? Date.now();
      pushEvent({
        kind: "message-edited",
        accountId,
        message: cloneMessage(message),
      });
      return cloneMessage(message);
    },
    deleteMessage(input: QaBusDeleteMessageInput) {
      const accountId = normalizeAccountId(input.accountId);
      const message = requireActiveMessageForAccount(input);
      message.deleted = true;
      pushEvent({
        kind: "message-deleted",
        accountId,
        message: cloneMessage(message),
      });
      return cloneMessage(message);
    },
    readMessage(input: QaBusReadMessageInput) {
      return readQaBusMessage({ messages, input });
    },
    searchMessages(input: QaBusSearchMessagesInput) {
      return searchQaBusMessages({ messages, input });
    },
    resolvePollCursor(input: QaBusPollInput = {}) {
      const accountId = normalizeAccountId(input.accountId);
      const requestedCursor = input.cursor ?? 0;
      const acknowledgedCursor = acknowledgedPollCursors.get(accountId) ?? 0;
      // Fetch progress and completed work are separate facts. Missing
      // acknowledgement means the consumer has not recorded new completion.
      const completedCursor = input.acknowledgedCursor ?? 0;
      if (completedCursor > acknowledgedCursor && completedCursor <= cursor) {
        acknowledgedPollCursors.set(accountId, completedCursor);
      }
      // A restarted channel consumer begins at zero. Resume its account cursor
      // so retained events are not replayed, while still returning unacked work.
      return requestedCursor === 0 ? acknowledgedCursor : requestedCursor;
    },
    getAcknowledgedPollCursor(accountId?: string) {
      return acknowledgedPollCursors.get(normalizeAccountId(accountId)) ?? 0;
    },
    poll(input: QaBusPollInput = {}) {
      return pollQaBusEvents({ events, cursor, input });
    },
    async waitFor(input: QaBusWaitForInput) {
      return await waiters.waitFor(input);
    },
    async waitForCursorAdvance(
      afterCursor: number,
      timeoutMs: number,
      shouldResolve?: (snapshot: QaBusStateSnapshot) => boolean,
    ) {
      return await waiters.waitForCursorAdvance(afterCursor, timeoutMs, shouldResolve);
    },
  };
}

export type QaBusState = ReturnType<typeof createQaBusState>;
