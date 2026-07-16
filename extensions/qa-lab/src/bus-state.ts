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

  const createMessage = (params: {
    direction: QaBusMessage["direction"];
    accountId: string;
    conversation: QaBusConversation;
    senderId: string;
    senderName?: string;
    text: string;
    timestamp?: number;
    threadId?: string;
    threadTitle?: string;
    replyToId?: string;
    attachments?: QaBusAttachment[];
    nativeCommand?: QaBusInboundMessageInput["nativeCommand"];
    toolCalls?: QaBusToolCall[];
  }): QaBusMessage => {
    const storedConversation = ensureConversation(params.accountId, params.conversation);
    const toolCalls = sanitizeQaBusToolCalls(params.toolCalls);
    const message: QaBusMessage = {
      id: randomUUID(),
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
      timestamp: params.timestamp ?? Date.now(),
      threadId: params.threadId,
      threadTitle: params.threadTitle,
      replyToId: params.replyToId,
      attachments: params.attachments?.map((attachment) => ({ ...attachment })) ?? [],
      ...(params.nativeCommand ? { nativeCommand: { ...params.nativeCommand } } : {}),
      ...(toolCalls ? { toolCalls } : {}),
      reactions: [],
    };
    messages.set(message.id, message);
    return message;
  };

  return {
    reset() {
      conversations.clear();
      threads.clear();
      messages.clear();
      events.length = 0;
      // Keep the cursor monotonic across resets so long-poll clients do not
      // miss fresh events after the bus is cleared mid-session.
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
    addInboundMessage(input: QaBusInboundMessageInput) {
      const accountId = normalizeAccountId(input.accountId);
      const message = createMessage({
        direction: "inbound",
        accountId,
        conversation: input.conversation,
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
      const message = requireQaBusMessageForAccount({ messages, input });
      const reaction = {
        emoji: input.emoji,
        senderId: input.senderId?.trim() || DEFAULT_BOT_ID,
        timestamp: input.timestamp ?? Date.now(),
      };
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
      const message = requireQaBusMessageForAccount({ messages, input });
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
      const message = requireQaBusMessageForAccount({ messages, input });
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
