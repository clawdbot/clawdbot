/**
 * Debounced steering queue for forwarding user messages to an active Codex
 * app-server turn.
 */
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import { buildCodexUserInput } from "./user-input.js";

const CODEX_STEER_ALL_DEBOUNCE_MS = 500;

/** Per-message options for Codex steering queue behavior. */
export type CodexSteeringQueueOptions = {
  debounceMs?: number;
  images?: EmbeddedRunAttemptParams["images"];
  isInboundUserMessage?: boolean;
};

/**
 * Creates a queue that batches steer messages while still serializing
 * app-server `turn/steer` requests.
 */
export function createCodexSteeringQueue(params: {
  client: CodexAppServerClient;
  threadId: string;
  turnId: string;
  claimPendingUserInput: () =>
    | {
        answer: (text: string) => boolean;
        cancel: () => boolean;
      }
    | undefined;
  signal: AbortSignal;
}) {
  type PendingSteerMessage = {
    text: string;
    images?: EmbeddedRunAttemptParams["images"];
    resolve: () => void;
    reject: (error: unknown) => void;
    settled: boolean;
  };
  type PendingSteerBatch = {
    items: PendingSteerMessage[];
  };
  let batchedMessages: PendingSteerMessage[] = [];
  const dispatchedBatches = new Map<string, PendingSteerBatch>();
  const pendingMessages = new Set<PendingSteerMessage>();
  let batchTimer: NodeJS.Timeout | undefined;
  let batchSequence = 0;
  let sendChain: Promise<void> = Promise.resolve();
  let closedError: Error | undefined;

  const clearBatchTimer = () => {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = undefined;
    }
  };

  const resolveItem = (item: PendingSteerMessage) => {
    if (item.settled) {
      return;
    }
    item.settled = true;
    pendingMessages.delete(item);
    item.resolve();
  };

  const rejectItem = (item: PendingSteerMessage, error: unknown) => {
    if (item.settled) {
      return;
    }
    item.settled = true;
    pendingMessages.delete(item);
    item.reject(error);
  };

  const closeQueue = (error: Error) => {
    if (closedError) {
      return;
    }
    closedError = error;
    params.signal.removeEventListener("abort", abortQueue);
    clearBatchTimer();
    batchedMessages = [];
    dispatchedBatches.clear();
    for (const item of pendingMessages) {
      rejectItem(item, error);
    }
  };
  const abortQueue = () => {
    closeQueue(new Error("codex app-server steering queue aborted"));
  };
  const cancelQueue = () => {
    closeQueue(new Error("codex app-server steering queue cancelled"));
  };

  const sendBatch = async (items: PendingSteerMessage[]) => {
    const liveItems = items.filter((item) => !item.settled);
    if (liveItems.length === 0) {
      return;
    }
    const unavailableError =
      closedError ??
      (params.signal.aborted ? new Error("codex app-server steering queue aborted") : undefined);
    if (unavailableError) {
      for (const item of liveItems) {
        rejectItem(item, unavailableError);
      }
      throw unavailableError;
    }
    const clientUserMessageId = `openclaw:${params.turnId}:steer:${++batchSequence}`;
    const batch = { items: liveItems };
    // RPC acceptance is not delivery: interrupt clears accepted pending input.
    // Keep the batch unsettled until Codex echoes this id on userMessage completion.
    dispatchedBatches.set(clientUserMessageId, batch);
    try {
      await params.client.request("turn/steer", {
        threadId: params.threadId,
        expectedTurnId: params.turnId,
        input: liveItems.flatMap((item) => buildCodexUserInput(item.text, item.images)),
        clientUserMessageId,
      });
    } catch (error) {
      dispatchedBatches.delete(clientUserMessageId);
      for (const item of liveItems) {
        rejectItem(item, error);
      }
      throw error;
    }
  };

  const enqueueSend = (items: PendingSteerMessage[]) => {
    const send = sendChain.then(() => sendBatch(items));
    // Preserve submission order after rejection: later messages must fall back
    // instead of overtaking the failed message with another turn/steer request.
    sendChain = send;
    void send.catch((error: unknown) => {
      for (const item of items) {
        rejectItem(item, error);
      }
      embeddedAgentLog.debug("codex app-server queued steer failed", { error });
    });
    return send;
  };

  const flushBatch = (): Promise<void> => {
    clearBatchTimer();
    const items = batchedMessages;
    batchedMessages = [];
    if (items.length === 0) {
      return sendChain;
    }
    const send = enqueueSend(items);
    void send.catch(() => undefined);
    return send;
  };

  const createPendingMessage = (
    text: string,
    images?: EmbeddedRunAttemptParams["images"],
  ): { item: PendingSteerMessage; delivery: Promise<void> } => {
    let resolveDelivery!: () => void;
    let rejectDelivery!: (error: unknown) => void;
    const delivery = new Promise<void>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
    const item = {
      text,
      images,
      resolve: resolveDelivery,
      reject: rejectDelivery,
      settled: false,
    };
    pendingMessages.add(item);
    return { item, delivery };
  };

  params.signal.addEventListener("abort", abortQueue, { once: true });
  if (params.signal.aborted) {
    abortQueue();
  }

  return {
    async queue(text: string, options?: CodexSteeringQueueOptions) {
      const pendingUserInput = params.claimPendingUserInput();
      if (pendingUserInput) {
        if (!options?.images?.length) {
          pendingUserInput.answer(text);
          return;
        }
        // request_user_input cannot carry images. Submit the complete message
        // before releasing the prompt so no partial text answer can win the race.
        void flushBatch().catch(() => undefined);
        const { item, delivery } = createPendingMessage(text, options.images);
        await Promise.all([enqueueSend([item]).finally(() => pendingUserInput.cancel()), delivery]);
        return;
      }
      if (closedError) {
        throw closedError;
      }
      if (params.signal.aborted) {
        throw new Error("codex app-server steering queue aborted");
      }
      const { item, delivery } = createPendingMessage(text, options?.images);
      batchedMessages.push(item);
      clearBatchTimer();
      const debounceMs = normalizeCodexSteerDebounceMs(options?.debounceMs);
      if (debounceMs === 0) {
        void flushBatch();
      } else {
        batchTimer = setTimeout(() => {
          batchTimer = undefined;
          void flushBatch();
        }, debounceMs);
      }
      return await delivery;
    },
    async flushPending() {
      if (closedError) {
        return;
      }
      await flushBatch().catch(() => undefined);
    },
    confirmConsumed(clientUserMessageId: string) {
      const batch = dispatchedBatches.get(clientUserMessageId);
      if (!batch) {
        return false;
      }
      dispatchedBatches.delete(clientUserMessageId);
      for (const item of batch.items) {
        resolveItem(item);
      }
      return true;
    },
    cancel: cancelQueue,
  };
}

/** Normalizes steer debounce milliseconds, preserving explicit zero. */
function normalizeCodexSteerDebounceMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : CODEX_STEER_ALL_DEBOUNCE_MS;
}
