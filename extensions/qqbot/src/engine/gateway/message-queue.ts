/**
 * Per-user concurrent message queue.
 *
 * Messages are serialized per user (peer) and processed in parallel across
 * users, up to a configurable concurrency limit.
 *
 * This module is independent of any framework SDK — it only needs a logger
 * and an abort-state probe supplied via {@link MessageQueueContext}.
 */

import { formatErrorMessage } from "../utils/format.js";

// Message queue limits.
const MESSAGE_QUEUE_SIZE = 1000;
const PER_USER_QUEUE_SIZE = 20;
const MAX_CONCURRENT_USERS = 10;

/**
 * Queue item used for asynchronous message handling without blocking heartbeats.
 */
export interface QueuedMessage {
  type: "c2c" | "guild" | "dm" | "group";
  senderId: string;
  senderName?: string;
  content: string;
  messageId: string;
  timestamp: string;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
  attachments?: Array<{
    content_type: string;
    url: string;
    filename?: string;
    voice_wav_url?: string;
    asr_refer_text?: string;
  }>;
  /** refIdx of the quoted message. */
  refMsgIdx?: string;
  /** refIdx assigned to this message for future quoting. */
  msgIdx?: string;
  /** QQ message type (103 = quote). */
  msgType?: number;
  /** Referenced message elements (for quote messages). */
  msgElements?: Array<{
    msg_idx?: string;
    content?: string;
    attachments?: Array<{
      content_type: string;
      url: string;
      filename?: string;
      height?: number;
      width?: number;
      size?: number;
      voice_wav_url?: string;
      asr_refer_text?: string;
    }>;
  }>;
}

export interface MessageQueueContext {
  accountId: string;
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
  /** Abort-state probe supplied by the caller. */
  isAborted: () => boolean;
}

/** Snapshot of the queue state for diagnostics. */
export interface QueueSnapshot {
  totalPending: number;
  activeUsers: number;
  maxConcurrentUsers: number;
  senderPending: number;
}

export interface MessageQueue {
  enqueue: (msg: QueuedMessage) => void;
  startProcessor: (handleMessageFn: (msg: QueuedMessage) => Promise<void>) => void;
  getSnapshot: (senderPeerId: string) => QueueSnapshot;
  getMessagePeerId: (msg: QueuedMessage) => string;
  /** Clear a user's queued messages and return how many were dropped. */
  clearUserQueue: (peerId: string) => number;
  /** Execute one message immediately, bypassing the queue for urgent commands. */
  executeImmediate: (msg: QueuedMessage) => void;
}

/**
 * Create a per-user concurrent queue.
 * Messages are serialized per user and processed in parallel across users.
 */
export function createMessageQueue(ctx: MessageQueueContext): MessageQueue {
  const { accountId: _accountId, log } = ctx;

  const userQueues = new Map<string, QueuedMessage[]>();
  const activeUsers = new Set<string>();
  let messagesProcessed = 0;
  let handleMessageFnRef: ((msg: QueuedMessage) => Promise<void>) | null = null;
  let totalEnqueued = 0;

  const getMessagePeerId = (msg: QueuedMessage): string => {
    if (msg.type === "guild") {
      return `guild:${msg.channelId ?? "unknown"}`;
    }
    if (msg.type === "group") {
      return `group:${msg.groupOpenid ?? "unknown"}`;
    }
    return `dm:${msg.senderId}`;
  };

  const drainUserQueue = async (peerId: string): Promise<void> => {
    if (activeUsers.has(peerId)) {
      return;
    }
    if (activeUsers.size >= MAX_CONCURRENT_USERS) {
      log?.info(`Max concurrent users (${MAX_CONCURRENT_USERS}) reached, ${peerId} will wait`);
      return;
    }

    const queue = userQueues.get(peerId);
    if (!queue || queue.length === 0) {
      userQueues.delete(peerId);
      return;
    }

    activeUsers.add(peerId);

    try {
      while (queue.length > 0 && !ctx.isAborted()) {
        const msg = queue.shift()!;
        totalEnqueued = Math.max(0, totalEnqueued - 1);
        try {
          if (handleMessageFnRef) {
            await handleMessageFnRef(msg);
            messagesProcessed++;
          }
        } catch (err) {
          log?.error(`Message processor error for ${peerId}: ${formatErrorMessage(err)}`);
        }
      }
    } finally {
      activeUsers.delete(peerId);
      userQueues.delete(peerId);
      for (const [waitingPeerId, waitingQueue] of userQueues) {
        if (activeUsers.size >= MAX_CONCURRENT_USERS) {
          break;
        }
        if (waitingQueue.length > 0 && !activeUsers.has(waitingPeerId)) {
          void drainUserQueue(waitingPeerId);
        }
      }
    }
  };

  const enqueue = (msg: QueuedMessage): void => {
    const peerId = getMessagePeerId(msg);
    let queue = userQueues.get(peerId);
    if (!queue) {
      queue = [];
      userQueues.set(peerId, queue);
    }

    if (queue.length >= PER_USER_QUEUE_SIZE) {
      const dropped = queue.shift();
      log?.error(
        `Per-user queue full for ${peerId}, dropping oldest message ${dropped?.messageId}`,
      );
    }

    totalEnqueued++;
    if (totalEnqueued > MESSAGE_QUEUE_SIZE) {
      log?.error(
        `Global queue limit reached (${totalEnqueued}), message from ${peerId} may be delayed`,
      );
    }

    queue.push(msg);
    log?.debug?.(
      `Message enqueued for ${peerId}, user queue: ${queue.length}, active users: ${activeUsers.size}`,
    );

    void drainUserQueue(peerId);
  };

  const startProcessor = (handleMessageFn: (msg: QueuedMessage) => Promise<void>): void => {
    handleMessageFnRef = handleMessageFn;
    log?.debug?.(
      `Message processor started (per-user concurrency, max ${MAX_CONCURRENT_USERS} users)`,
    );
  };

  const getSnapshot = (senderPeerId: string): QueueSnapshot => {
    let totalPending = 0;
    for (const [, q] of userQueues) {
      totalPending += q.length;
    }
    const senderQueue = userQueues.get(senderPeerId);
    return {
      totalPending,
      activeUsers: activeUsers.size,
      maxConcurrentUsers: MAX_CONCURRENT_USERS,
      senderPending: senderQueue ? senderQueue.length : 0,
    };
  };

  const clearUserQueue = (peerId: string): number => {
    const queue = userQueues.get(peerId);
    if (!queue || queue.length === 0) {
      return 0;
    }
    const droppedCount = queue.length;
    queue.length = 0;
    totalEnqueued = Math.max(0, totalEnqueued - droppedCount);
    return droppedCount;
  };

  const executeImmediate = (msg: QueuedMessage): void => {
    if (handleMessageFnRef) {
      handleMessageFnRef(msg).catch((err) => {
        log?.error(`Immediate execution error: ${err}`);
      });
    }
  };

  return {
    enqueue,
    startProcessor,
    getSnapshot,
    getMessagePeerId,
    clearUserQueue,
    executeImmediate,
  };
}
