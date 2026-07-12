// Telegram plugin module implements account throttler behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";
import { apiThrottler } from "./bot.runtime.js";

type ApiThrottlerTransformer = ReturnType<typeof apiThrottler>;
type TelegramApiPayload = {
  chat_id?: unknown;
  direct_messages_topic_id?: unknown;
  message_id?: unknown;
  message_thread_id?: unknown;
};
type QueuedApiRequest<T> = {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
};

class GroupFairQueue {
  private readonly lanes = new Map<string, Array<QueuedApiRequest<unknown>>>();
  private laneOrder: string[] = [];
  private nextLaneIndex = 0;
  private running = false;

  enqueue<T>(laneKey: string, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const request: QueuedApiRequest<unknown> = {
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      const existing = this.lanes.get(laneKey);
      if (existing) {
        existing.push(request);
      } else {
        this.lanes.set(laneKey, [request]);
        this.laneOrder.push(laneKey);
      }
      this.start();
    });
  }

  private start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (true) {
        const request = this.takeNext();
        if (!request) {
          return;
        }
        try {
          request.resolve(await request.run());
        } catch (err) {
          request.reject(err);
        }
      }
    } finally {
      this.running = false;
      if (this.laneOrder.length > 0) {
        this.start();
      }
    }
  }

  private takeNext(): QueuedApiRequest<unknown> | undefined {
    for (let remaining = this.laneOrder.length; remaining > 0; remaining -= 1) {
      this.nextLaneIndex %= this.laneOrder.length;
      const laneKey = expectDefined(
        this.laneOrder[this.nextLaneIndex],
        "non-empty Telegram throttle lane order",
      );
      const queue = this.lanes.get(laneKey);
      if (!queue || queue.length === 0) {
        this.lanes.delete(laneKey);
        this.laneOrder.splice(this.nextLaneIndex, 1);
        if (this.laneOrder.length === 0) {
          this.nextLaneIndex = 0;
          return undefined;
        }
        continue;
      }

      const request = queue.shift();
      this.nextLaneIndex += 1;
      return request;
    }
    return undefined;
  }
}

const throttlerByToken = new Map<string, ApiThrottlerTransformer>();

function readNumericId(value: unknown): number | undefined {
  return parseStrictInteger(value);
}

function readPayload(payload: unknown): TelegramApiPayload | undefined {
  return payload && typeof payload === "object" ? (payload as TelegramApiPayload) : undefined;
}

function resolveGroupChatKey(payload: TelegramApiPayload): string | undefined {
  const chatId = readNumericId(payload.chat_id);
  return chatId !== undefined && chatId < 0 ? String(chatId) : undefined;
}

function resolveForumLaneKey(payload: TelegramApiPayload): string {
  const threadId = readNumericId(payload.message_thread_id);
  if (threadId !== undefined) {
    return `topic:${threadId}`;
  }
  const directTopicId = readNumericId(payload.direct_messages_topic_id);
  if (directTopicId !== undefined) {
    return `direct-topic:${directTopicId}`;
  }
  const messageId = readNumericId(payload.message_id);
  if (messageId !== undefined) {
    return `message:${messageId}`;
  }
  return "main";
}

export function createTelegramAccountThrottler(
  createThrottler: () => ApiThrottlerTransformer = apiThrottler,
): ApiThrottlerTransformer {
  const baseThrottler = createThrottler();
  const fairQueuesByChat = new Map<string, GroupFairQueue>();

  return (prev, method, payload, signal) => {
    const apiPayload = readPayload(payload);
    const groupChatKey = apiPayload ? resolveGroupChatKey(apiPayload) : undefined;
    if (!apiPayload || !groupChatKey) {
      return baseThrottler(prev, method, payload, signal);
    }

    let fairQueue = fairQueuesByChat.get(groupChatKey);
    if (!fairQueue) {
      fairQueue = new GroupFairQueue();
      fairQueuesByChat.set(groupChatKey, fairQueue);
    }

    const laneKey = resolveForumLaneKey(apiPayload);
    return fairQueue.enqueue(laneKey, () => baseThrottler(prev, method, payload, signal));
  };
}

export function getOrCreateAccountThrottler(
  token: string,
  createThrottler: () => ApiThrottlerTransformer = apiThrottler,
): ApiThrottlerTransformer {
  let throttler = throttlerByToken.get(token);
  if (!throttler) {
    throttler = createTelegramAccountThrottler(createThrottler);
    throttlerByToken.set(token, throttler);
  }
  return throttler;
}

export function clearAccountThrottlersForTest(): void {
  throttlerByToken.clear();
}
