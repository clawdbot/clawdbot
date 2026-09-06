// Telegram plugin module implements account throttler behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";
import { logVerbose, sleepWithAbort, waitForAbortSignal } from "openclaw/plugin-sdk/runtime-env";
import { apiThrottler } from "./bot.runtime.js";
import { TELEGRAM_CHAT_ACTION_INTERVAL_MS } from "./chat-action-timing.js";
import { createTelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";

type ApiThrottlerTransformer = ReturnType<typeof apiThrottler>;
type TelegramAccountThrottler = {
  transformer: ApiThrottlerTransformer;
  chatActions: ReturnType<typeof createTelegramSendChatActionHandler>;
};
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

class GroupRequestScheduler {
  private readonly lanes = new Map<string, Array<QueuedApiRequest<unknown>>>();
  private laneOrder: string[] = [];
  private nextLaneIndex = 0;
  private running = false;
  private actionTail = Promise.resolve();
  private nextActionAtMs = 0;

  enqueueAction<T>(
    run: () => Promise<T>,
    signal: Parameters<ApiThrottlerTransformer>[3],
  ): Promise<T> {
    // grammY may supply the legacy node-fetch signal; bridge only its abort event.
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }
    const result = this.actionTail.then(async () => {
      controller.signal.throwIfAborted();
      const waitMs = this.nextActionAtMs - Date.now();
      if (waitMs > 0) {
        await sleepWithAbort(waitMs, controller.signal);
      }
      try {
        return await run();
      } finally {
        // The final API guard can back off after this queue's wait.
        this.nextActionAtMs = Date.now() + 1_000;
      }
    });
    this.actionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return Promise.race([
      result,
      waitForAbortSignal(controller.signal).then(() => {
        throw new DOMException("Chat action canceled", "AbortError");
      }),
    ]).finally(() => {
      signal?.removeEventListener("abort", abort);
      controller.abort();
    });
  }

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

const TELEGRAM_ACCOUNT_THROTTLERS_KEY = Symbol.for("openclaw.telegram.accountThrottlers");

function getAccountThrottlers(): Map<string, TelegramAccountThrottler> {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const existing = globalRecord[TELEGRAM_ACCOUNT_THROTTLERS_KEY] as
    | Map<string, TelegramAccountThrottler>
    | undefined;
  if (existing) {
    return existing;
  }
  const created = new Map<string, TelegramAccountThrottler>();
  globalRecord[TELEGRAM_ACCOUNT_THROTTLERS_KEY] = created;
  return created;
}

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

function createTelegramAccountThrottler(
  createThrottler: () => ApiThrottlerTransformer = apiThrottler,
): TelegramAccountThrottler {
  const baseThrottler = createThrottler();
  const chatActions = createTelegramSendChatActionHandler({
    logger: (message) => logVerbose(`telegram: ${message}`),
    minIntervalMs: TELEGRAM_CHAT_ACTION_INTERVAL_MS,
  });
  const schedulersByChat = new Map<string, GroupRequestScheduler>();

  const transformer: ApiThrottlerTransformer = (prev, method, payload, signal) => {
    const apiPayload = readPayload(payload);
    const groupChatKey = apiPayload ? resolveGroupChatKey(apiPayload) : undefined;
    if (!apiPayload || !groupChatKey) {
      return baseThrottler(
        (queuedMethod, queuedPayload, queuedSignal) =>
          chatActions.apiTransformer(prev, queuedMethod, queuedPayload, queuedSignal),
        method,
        payload,
        signal,
      );
    }

    let scheduler = schedulersByChat.get(groupChatKey);
    if (!scheduler) {
      scheduler = new GroupRequestScheduler();
      schedulersByChat.set(groupChatKey, scheduler);
    }
    if (method === "sendChatAction") {
      // Ephemeral actions must not spend message reservoirs; the shared guard honors flood waits.
      return scheduler.enqueueAction(
        () => chatActions.apiTransformer(prev, method, payload, signal),
        signal,
      );
    }

    const laneKey = resolveForumLaneKey(apiPayload);
    return scheduler.enqueue(laneKey, () => baseThrottler(prev, method, payload, signal));
  };
  return { transformer, chatActions };
}

export function getOrCreateAccountThrottler(
  token: string,
  createThrottler: () => ApiThrottlerTransformer = apiThrottler,
): TelegramAccountThrottler {
  const throttlerByToken = getAccountThrottlers();
  let throttler = throttlerByToken.get(token);
  if (!throttler) {
    throttler = createTelegramAccountThrottler(createThrottler);
    throttlerByToken.set(token, throttler);
  }
  return throttler;
}
