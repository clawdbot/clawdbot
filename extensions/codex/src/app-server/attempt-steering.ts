/**
 * Debounced steering queue for forwarding user messages to an active Codex
 * app-server turn.
 */
import {
  embeddedAgentLog,
  type queueAgentHarnessMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isCodexAppServerIndeterminateRequestCancellationError,
  isCodexAppServerIndeterminateTransportError,
  type CodexAppServerClient,
} from "./client.js";
import type { CodexUserInput } from "./protocol.js";

const CODEX_STEER_ALL_DEBOUNCE_MS = 500;
type AgentHarnessQueueMessageOptions = NonNullable<Parameters<typeof queueAgentHarnessMessage>[2]>;

export class CodexSteeringAcceptedUnconfirmedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexSteeringAcceptedUnconfirmedError";
  }
}

/** Per-message options for Codex steering queue behavior. */
export type CodexSteeringQueueOptions = Pick<
  AgentHarnessQueueMessageOptions,
  | "debounceMs"
  | "images"
  | "imageOrder"
  | "media"
  | "isInboundUserMessage"
  | "onQueueAccepted"
  | "userTurnTranscriptRecorder"
>;

type CodexSteeringCommitItem = Pick<
  CodexSteeringQueueOptions,
  "isInboundUserMessage" | "userTurnTranscriptRecorder"
>;

/**
 * Creates a queue that batches steer messages while still serializing
 * app-server `turn/steer` requests.
 */
export function createCodexSteeringQueue(params: {
  client: CodexAppServerClient;
  threadId: string;
  turnId: string;
  requestTimeoutMs: number;
  signal: AbortSignal;
  assertActive: () => void;
  prepareMessage: (text: string, options: CodexSteeringQueueOptions) => Promise<CodexUserInput[]>;
  beforeConfirmConsumed?: (items: readonly CodexSteeringCommitItem[]) => Promise<void>;
}) {
  type PendingSteerMessage = CodexSteeringQueueOptions & {
    acceptance: "open" | "accepted" | "rejected";
    text: string;
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
  let sealedError: Error | undefined;
  let closedError: Error | undefined;

  const assertActive = () => {
    const unavailableError = closedError ?? sealedError;
    if (unavailableError) {
      throw unavailableError;
    }
    params.signal.throwIfAborted();
    params.assertActive();
  };

  const clearBatchTimer = () => {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = undefined;
    }
  };

  const reportItemAcceptance = (item: PendingSteerMessage, accepted: boolean) => {
    if (item.acceptance !== "open") {
      return;
    }
    item.acceptance = accepted ? "accepted" : "rejected";
    item.onQueueAccepted?.(accepted);
  };

  const resolveItem = (item: PendingSteerMessage) => {
    if (item.settled) {
      return;
    }
    reportItemAcceptance(item, true);
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
    reportItemAcceptance(item, false);
    item.reject(
      item.acceptance === "accepted"
        ? new CodexSteeringAcceptedUnconfirmedError(
            "Codex accepted steering but did not confirm transcript consumption",
            { cause: error },
          )
        : error,
    );
  };

  const closeQueue = (error: Error) => {
    if (closedError) {
      return;
    }
    closedError = error;
    params.signal.removeEventListener("abort", abortQueue);
    clearBatchTimer();
    batchedMessages = [];
    // An issued RPC may have reached Codex before its response. Fence wire-dispatched
    // batches as accepted-unconfirmed so terminal cancellation cannot replay them.
    for (const batch of dispatchedBatches.values()) {
      for (const item of batch.items) {
        reportItemAcceptance(item, true);
      }
    }
    dispatchedBatches.clear();
    for (const item of pendingMessages) {
      rejectItem(item, error);
    }
  };
  const sealQueueAdmission = () => {
    if (sealedError || closedError) {
      return;
    }
    sealedError = new Error("codex app-server steering queue admission sealed");
    clearBatchTimer();
    batchedMessages = [];
    const dispatchedItems = new Set(
      [...dispatchedBatches.values()].flatMap((batch) => batch.items),
    );
    // Terminal receipt closes admission immediately, but a user-message
    // completion already ahead of it on the wire still owns its dispatched batch.
    for (const item of pendingMessages) {
      if (!dispatchedItems.has(item)) {
        rejectItem(item, sealedError);
      }
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
    let clientUserMessageId: string | undefined;
    try {
      assertActive();
      const input: CodexUserInput[] = [];
      // Reserve sendChain ownership before any preparation so later text cannot
      // overtake an image read. Preparing input has not crossed the wire boundary.
      for (const item of liveItems) {
        input.push(...(await params.prepareMessage(item.text, item)));
        assertActive();
      }
      // No await between final owner validation and RPC dispatch. Only these
      // batches become accepted-unconfirmed if cancellation races the response.
      clientUserMessageId = `openclaw:${params.turnId}:steer:${++batchSequence}`;
      dispatchedBatches.set(clientUserMessageId, { items: liveItems });
      // turn/steer is an ack, but nothing guarantees the app-server answers it.
      // Without a deadline and the run signal the caller only unblocks when the
      // app-server client closes, which strands whichever channel handler is
      // awaiting delivery and wedges every later steer behind sendChain.
      await params.client.request(
        "turn/steer",
        {
          threadId: params.threadId,
          expectedTurnId: params.turnId,
          input,
          clientUserMessageId,
        },
        { timeoutMs: params.requestTimeoutMs, signal: params.signal },
      );
      for (const item of liveItems) {
        reportItemAcceptance(item, true);
      }
    } catch (error) {
      if (clientUserMessageId) {
        dispatchedBatches.delete(clientUserMessageId);
      }
      const acceptedUnconfirmed =
        clientUserMessageId !== undefined &&
        (isCodexAppServerIndeterminateRequestCancellationError(error) ||
          isCodexAppServerIndeterminateTransportError(error));
      for (const item of liveItems) {
        if (acceptedUnconfirmed) {
          reportItemAcceptance(item, true);
        }
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
    options?: CodexSteeringQueueOptions,
  ): { item: PendingSteerMessage; delivery: Promise<void> } => {
    let resolveDelivery!: () => void;
    let rejectDelivery!: (error: unknown) => void;
    const delivery = new Promise<void>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
    const item = {
      ...options,
      acceptance: "open" as const,
      text,
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
      try {
        assertActive();
      } catch (error) {
        options?.onQueueAccepted?.(false);
        throw error;
      }
      const { item, delivery } = createPendingMessage(text, options);
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
    confirmConsumed(clientUserMessageId: string) {
      const batch = dispatchedBatches.get(clientUserMessageId);
      if (!batch) {
        return false;
      }
      dispatchedBatches.delete(clientUserMessageId);
      for (const item of batch.items) {
        reportItemAcceptance(item, true);
      }
      const resolveBatch = () => {
        for (const item of batch.items) {
          resolveItem(item);
        }
        return true;
      };
      const rejectBatch = (error: unknown) => {
        for (const item of batch.items) {
          rejectItem(item, error);
        }
        return true;
      };
      if (!params.beforeConfirmConsumed) {
        return resolveBatch();
      }
      try {
        return params.beforeConfirmConsumed(batch.items).then(resolveBatch, rejectBatch);
      } catch (error) {
        return rejectBatch(error);
      }
    },
    sealAdmission: sealQueueAdmission,
    cancel: cancelQueue,
  };
}

/** Normalizes steer debounce milliseconds, preserving explicit zero. */
function normalizeCodexSteerDebounceMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : CODEX_STEER_ALL_DEBOUNCE_MS;
}
