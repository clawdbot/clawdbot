import { formatErrorMessage } from "../utils/format.js";

const DEFAULT_GLOBAL_QUEUE_SIZE = 1000;
const DEFAULT_PER_PEER_QUEUE_SIZE = 20;
const DEFAULT_GROUP_QUEUE_SIZE = 50;
const DEFAULT_MAX_CONCURRENT_USERS = 10;

export interface QueuedMention {
  scope?: "all" | "single";
  id?: string;
  user_openid?: string;
  member_openid?: string;
  username?: string;
  nickname?: string;
  bot?: boolean;
  is_you?: boolean;
}

interface QueuedMergeInfo {
  count: number;
  messages: readonly QueuedMessage[];
}

export interface QueuedMessage {
  type: "c2c" | "guild" | "dm" | "group";
  senderId: string;
  senderName?: string;
  senderIsBot?: boolean;
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
  refMsgIdx?: string;
  msgIdx?: string;
  msgType?: number;
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
  eventType?: string;
  mentions?: QueuedMention[];
  messageScene?: { source?: string; ext?: string[] };
  merge?: QueuedMergeInfo;
}

export function isMergedTurn(msg: QueuedMessage): msg is QueuedMessage & {
  merge: QueuedMergeInfo;
} {
  return (msg.merge?.count ?? 0) > 1;
}

interface MessageQueueContext {
  accountId: string;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  isAborted: () => boolean;
  groupQueueSize?: number;
  peerQueueSize?: number;
  globalQueueSize?: number;
  maxConcurrentUsers?: number;
}

interface QueueSnapshot {
  totalPending: number;
  activeUsers: number;
  maxConcurrentUsers: number;
  senderPending: number;
}

interface MessageQueue {
  enqueue: (msg: QueuedMessage) => void;
  startProcessor: (handleMessageFn: (msg: QueuedMessage) => Promise<void>) => void;
  getSnapshot: (senderPeerId: string) => QueueSnapshot;
  getMessagePeerId: (msg: QueuedMessage) => string;
  clearUserQueue: (peerId: string) => number;
  executeImmediate: (msg: QueuedMessage) => void;
}

function isGroupPeer(peerId: string): boolean {
  return peerId.startsWith("group:") || peerId.startsWith("guild:");
}

function isSlashCommand(msg: QueuedMessage): boolean {
  return (msg.content ?? "").trim().startsWith("/");
}

/**
 * Merge several queued group messages into one representative message.
 *
 * Merge semantics:
 *   - `content` is joined with newlines; each line prefixed with `[sender]`
 *     so the downstream formatter can attribute speakers.
 *   - `attachments` is concatenated.
 *   - `mentions` is deduplicated by member/user openid; if *any* source
 *     message was a `GROUP_AT_MESSAGE_CREATE`, the merged result inherits
 *     that eventType (the merged turn effectively @-s the bot).
 *   - `messageId`, `msgIdx`, `timestamp` come from the last message — the
 *     most recent identity is what the outbound reply should quote.
 *   - `refMsgIdx` (the message that the user quoted) comes from the FIRST
 *     message in the batch because the first quote anchors the topic.
 *   - `senderIsBot` is true only when every source message was authored
 *     by a bot. Any human participation flips the flag.
 *
 * A single-message batch is returned unchanged (no merge overhead).
 */
export function mergeGroupMessages(batch: QueuedMessage[]): QueuedMessage {
  if (batch.length === 0) {
    throw new Error("mergeGroupMessages: empty batch");
  }
  if (batch.length === 1) {
    return batch[0];
  }

  const first = batch[0];
  const last = batch[batch.length - 1];

  const mergedContent = batch
    .map((m) => `[${m.senderName ?? m.senderId}]: ${m.content}`)
    .join("\n");

  const mergedAttachments: QueuedMessage["attachments"] = [];
  for (const m of batch) {
    if (m.attachments?.length) {
      mergedAttachments.push(...m.attachments);
    }
  }

  const seenMentionIds = new Set<string>();
  const mergedMentions: NonNullable<QueuedMessage["mentions"]> = [];
  let anyAtYouEvent = false;
  for (const m of batch) {
    if (m.eventType === "GROUP_AT_MESSAGE_CREATE") {
      anyAtYouEvent = true;
    }
    if (m.mentions) {
      for (const mt of m.mentions) {
        const key = mt.member_openid ?? mt.id ?? mt.user_openid ?? "";
        if (key && seenMentionIds.has(key)) {
          continue;
        }
        if (key) {
          seenMentionIds.add(key);
        }
        mergedMentions.push(mt);
      }
    }
  }

  const allFromBot = batch.every((m) => m.senderIsBot);

  return {
    type: last.type,
    senderId: last.senderId,
    senderName: last.senderName,
    senderIsBot: allFromBot,
    content: mergedContent,
    messageId: last.messageId,
    timestamp: last.timestamp,
    channelId: last.channelId,
    guildId: last.guildId,
    groupOpenid: last.groupOpenid,
    attachments: mergedAttachments.length > 0 ? mergedAttachments : undefined,
    refMsgIdx: first.refMsgIdx,
    msgIdx: last.msgIdx,
    eventType: anyAtYouEvent ? "GROUP_AT_MESSAGE_CREATE" : last.eventType,
    mentions: mergedMentions.length > 0 ? mergedMentions : undefined,
    messageScene: last.messageScene,
    merge: { count: batch.length, messages: batch },
  };
}

export function createMessageQueue(ctx: MessageQueueContext): MessageQueue {
  const { accountId: _accountId, log } = ctx;
  const globalQueueSize = ctx.globalQueueSize ?? DEFAULT_GLOBAL_QUEUE_SIZE;
  const peerQueueSize = ctx.peerQueueSize ?? DEFAULT_PER_PEER_QUEUE_SIZE;
  const groupQueueSize = ctx.groupQueueSize ?? DEFAULT_GROUP_QUEUE_SIZE;
  const maxConcurrentUsers = ctx.maxConcurrentUsers ?? DEFAULT_MAX_CONCURRENT_USERS;

  const userQueues = new Map<string, QueuedMessage[]>();
  const activeUsers = new Set<string>();
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

  const evictOne = (queue: QueuedMessage[], isGroup: boolean): QueuedMessage | undefined => {
    if (isGroup) {
      const botIdx = queue.findIndex((m) => m.senderIsBot);
      if (botIdx >= 0) {
        return queue.splice(botIdx, 1)[0];
      }
    }
    return queue.shift();
  };

  const processOne = async (msg: QueuedMessage, peerId: string, label: string): Promise<void> => {
    try {
      await handleMessageFnRef!(msg);
    } catch (err) {
      log?.error(`${label} error for ${peerId}: ${formatErrorMessage(err)}`);
    }
  };

  const drainGroupBatch = async (batch: QueuedMessage[], peerId: string): Promise<void> => {
    const commands: QueuedMessage[] = [];
    const normal: QueuedMessage[] = [];
    for (const m of batch) {
      if (isSlashCommand(m)) {
        commands.push(m);
      } else {
        normal.push(m);
      }
    }

    for (const cmd of commands) {
      log?.debug?.(
        `Processing command independently for ${peerId}: ${(cmd.content ?? "").trim().slice(0, 50)}`,
      );
      await processOne(cmd, peerId, "Command processor");
    }

    if (normal.length > 0) {
      const merged = mergeGroupMessages(normal);
      if (normal.length > 1) {
        log?.debug?.(`Merged ${normal.length} queued group messages for ${peerId} into one`);
      }
      await processOne(merged, peerId, `Message processor (merged batch of ${normal.length})`);
    }
  };

  const drainUserQueue = async (peerId: string): Promise<void> => {
    if (activeUsers.has(peerId)) {
      return;
    }
    if (activeUsers.size >= maxConcurrentUsers) {
      log?.debug?.(`Max concurrent users (${maxConcurrentUsers}) reached, ${peerId} will wait`);
      return;
    }

    const queue = userQueues.get(peerId);
    if (!queue || queue.length === 0) {
      userQueues.delete(peerId);
      return;
    }

    activeUsers.add(peerId);
    const isGroup = isGroupPeer(peerId);

    try {
      while (queue.length > 0 && !ctx.isAborted()) {
        if (isGroup && queue.length > 1 && handleMessageFnRef) {
          const batch = queue.splice(0);
          totalEnqueued = Math.max(0, totalEnqueued - batch.length);
          await drainGroupBatch(batch, peerId);
          continue;
        }

        const msg = queue.shift()!;
        totalEnqueued = Math.max(0, totalEnqueued - 1);
        if (handleMessageFnRef) {
          await processOne(msg, peerId, "Message processor");
        }
      }
    } finally {
      activeUsers.delete(peerId);
      userQueues.delete(peerId);

      for (const [waitingPeerId, waitingQueue] of userQueues) {
        if (activeUsers.size >= maxConcurrentUsers) {
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
    const isGroup = isGroupPeer(peerId);

    let queue = userQueues.get(peerId);
    if (!queue) {
      queue = [];
      userQueues.set(peerId, queue);
    }

    const maxSize = isGroup ? groupQueueSize : peerQueueSize;
    if (queue.length >= maxSize) {
      const dropped = evictOne(queue, isGroup);
      totalEnqueued = Math.max(0, totalEnqueued - 1);
      if (isGroup && dropped?.senderIsBot) {
        log?.info(`Queue full for ${peerId}, dropping bot message ${dropped.messageId}`, {
          accountId: ctx.accountId,
          peerId,
          droppedMessageId: dropped.messageId,
          reason: "queue_full_evict_bot",
        });
      } else {
        log?.error(`Queue full for ${peerId}, dropping oldest message ${dropped?.messageId}`, {
          accountId: ctx.accountId,
          peerId,
          droppedMessageId: dropped?.messageId,
          reason: "queue_full_evict_oldest",
        });
      }
    }

    totalEnqueued++;
    if (totalEnqueued > globalQueueSize) {
      log?.error(
        `Global queue limit reached (${totalEnqueued}), message from ${peerId} may be delayed`,
        { accountId: ctx.accountId, peerId, totalEnqueued, globalQueueSize },
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
      `Message processor started (per-user concurrency, max ${maxConcurrentUsers} users)`,
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
      maxConcurrentUsers,
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
