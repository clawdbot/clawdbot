/**
 * Debounced steering queue for forwarding user messages to an active Codex
 * app-server turn.
 */
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isCodexAppServerIndeterminateRequestCancellationError,
  isCodexAppServerIndeterminateTransportError,
  type CodexAppServerClient,
} from "./client.js";
import { buildCodexUserInput } from "./user-input.js";

const CODEX_STEER_ALL_DEBOUNCE_MS = 500;

export class CodexSteeringAcceptedUnconfirmedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexSteeringAcceptedUnconfirmedError";
  }
}

/** Per-message options for Codex steering queue behavior. */
export type CodexSteeringQueueOptions = {
  debounceMs?: number;
  images?: EmbeddedRunAttemptParams["images"];
  inputProvenance?: EmbeddedRunAttemptParams["inputProvenance"];
  isInboundUserMessage?: boolean;
};

type CodexSteeringQueueOutcome = { kind: "answered-pending-input" } | { kind: "steered" };

const ANSWERED_PENDING_INPUT_OUTCOME: CodexSteeringQueueOutcome = {
  kind: "answered-pending-input",
};
const STEERED_OUTCOME: CodexSteeringQueueOutcome = { kind: "steered" };

/**
 * Creates a queue that batches steer messages while still serializing
 * app-server `turn/steer` requests.
 */
export function createCodexSteeringQueue(params: {
  client: CodexAppServerClient;
  threadId: string;
  turnId: string;
  requestTimeoutMs: number;
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
    resolve: (outcome: CodexSteeringQueueOutcome) => void;
    reject: (error: unknown) => void;
  };
  type PendingSteerBatchState =
    | "queued"
    | "dispatched"
    | "acknowledged"
    | "consumed"
    | "failed"
    | "cancelled";
  type PendingSteerBatch = {
    items: PendingSteerMessage[];
    state: PendingSteerBatchState;
    clientUserMessageId?: string;
    releaseClaim?: () => void;
    send: Promise<void>;
    settleSend: (error?: unknown) => void;
  };
  let batchedBatch: PendingSteerBatch | undefined;
  const dispatchedBatches = new Map<string, PendingSteerBatch>();
  const pendingBatches = new Set<PendingSteerBatch>();
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

  const resolveItem = (item: PendingSteerMessage, outcome: CodexSteeringQueueOutcome) => {
    item.resolve(outcome);
  };

  const rejectItem = (item: PendingSteerMessage, error: unknown, accepted = false) => {
    item.reject(
      accepted && !(error instanceof CodexSteeringAcceptedUnconfirmedError)
        ? new CodexSteeringAcceptedUnconfirmedError(
            "Codex accepted steering but did not confirm transcript consumption",
            { cause: error },
          )
        : error,
    );
  };

  const isTerminalBatch = (batch: PendingSteerBatch) =>
    batch.state === "consumed" || batch.state === "failed" || batch.state === "cancelled";

  const finishBatch = (
    batch: PendingSteerBatch,
    state: Extract<PendingSteerBatchState, "consumed" | "failed" | "cancelled">,
    itemError?: unknown,
    sendError = itemError,
  ) => {
    if (isTerminalBatch(batch)) {
      return false;
    }
    const accepted = batch.state === "acknowledged";
    if (batch.clientUserMessageId) {
      dispatchedBatches.delete(batch.clientUserMessageId);
    }
    batch.state = state;
    pendingBatches.delete(batch);
    if (state === "consumed") {
      for (const item of batch.items) {
        resolveItem(item, STEERED_OUTCOME);
      }
      batch.settleSend();
      return true;
    }
    for (const item of batch.items) {
      rejectItem(item, itemError, accepted);
    }
    batch.settleSend(sendError);
    return true;
  };

  const createBatch = (
    items: PendingSteerMessage[],
    releaseClaim?: () => void,
  ): PendingSteerBatch => {
    let resolveSend!: () => void;
    let rejectSend!: (error: unknown) => void;
    const send = new Promise<void>((resolve, reject) => {
      resolveSend = resolve;
      rejectSend = reject;
    });
    let sendSettled = false;
    // Cancellation can reject a queued batch before its serialization turn.
    void send.catch(() => undefined);
    const batch: PendingSteerBatch = {
      items,
      state: "queued",
      releaseClaim,
      send,
      settleSend: (error) => {
        if (sendSettled) {
          return;
        }
        sendSettled = true;
        try {
          releaseClaim?.();
        } catch (releaseError) {
          embeddedAgentLog.debug("codex app-server pending input release failed", {
            error: releaseError,
          });
        }
        if (error === undefined) {
          resolveSend();
        } else {
          rejectSend(error);
        }
      },
    };
    pendingBatches.add(batch);
    return batch;
  };

  const closeQueue = (error: Error) => {
    if (closedError) {
      return;
    }
    closedError = error;
    params.signal.removeEventListener("abort", abortQueue);
    clearBatchTimer();
    batchedBatch = undefined;
    for (const batch of pendingBatches) {
      finishBatch(batch, "cancelled", error);
    }
  };
  const abortQueue = () => {
    closeQueue(new Error("codex app-server steering queue aborted"));
  };
  const cancelQueue = () => {
    closeQueue(new Error("codex app-server steering queue cancelled"));
  };

  const dispatchBatch = (batch: PendingSteerBatch): Promise<void> => {
    if (batch.state !== "queued") {
      return batch.send;
    }
    const unavailableError =
      closedError ??
      (params.signal.aborted ? new Error("codex app-server steering queue aborted") : undefined);
    if (unavailableError) {
      finishBatch(batch, "cancelled", unavailableError);
      return batch.send;
    }
    const clientUserMessageId = `openclaw:${params.turnId}:steer:${++batchSequence}`;
    batch.clientUserMessageId = clientUserMessageId;
    batch.state = "dispatched";
    // RPC acceptance is not delivery: interrupt clears accepted pending input.
    // Keep the batch unsettled until Codex echoes this id on userMessage completion.
    dispatchedBatches.set(clientUserMessageId, batch);
    let request: Promise<unknown>;
    try {
      request = params.client.request(
        "turn/steer",
        {
          threadId: params.threadId,
          expectedTurnId: params.turnId,
          input: batch.items.flatMap((item) => buildCodexUserInput(item.text, item.images)),
          clientUserMessageId,
        },
        { timeoutMs: params.requestTimeoutMs, signal: params.signal },
      );
    } catch (error) {
      finishBatch(batch, "failed", error);
      return batch.send;
    }
    void request.then(
      () => {
        if (batch.state !== "dispatched") {
          return;
        }
        batch.state = "acknowledged";
        // Acknowledgment releases transport serialization, but logical callers
        // still wait for the correlated userMessage completion.
        batch.settleSend();
      },
      (error: unknown) => {
        if (isTerminalBatch(batch)) {
          return;
        }
        const itemError =
          isCodexAppServerIndeterminateRequestCancellationError(error) ||
          isCodexAppServerIndeterminateTransportError(error)
            ? new CodexSteeringAcceptedUnconfirmedError(
                "Codex steering request may have been accepted before confirmation",
                { cause: error },
              )
            : error;
        finishBatch(batch, "failed", itemError, error);
      },
    );
    return batch.send;
  };

  const enqueueBatch = (batch: PendingSteerBatch) => {
    const send = sendChain.then(() => dispatchBatch(batch));
    // Preserve serialization without allowing one failed request to poison
    // later steering. Callers still receive the original batch failure.
    sendChain = send.catch(() => undefined);
    void send.catch((error: unknown) => {
      embeddedAgentLog.debug("codex app-server queued steer failed", { error });
    });
    return send;
  };

  const flushBatch = (): Promise<void> => {
    clearBatchTimer();
    const batch = batchedBatch;
    batchedBatch = undefined;
    if (!batch) {
      return sendChain;
    }
    const send = enqueueBatch(batch);
    void send.catch(() => undefined);
    return send;
  };

  const createPendingMessage = (
    text: string,
    images?: EmbeddedRunAttemptParams["images"],
  ): { item: PendingSteerMessage; delivery: Promise<CodexSteeringQueueOutcome> } => {
    let resolveDelivery!: (outcome: CodexSteeringQueueOutcome) => void;
    let rejectDelivery!: (error: unknown) => void;
    const delivery = new Promise<CodexSteeringQueueOutcome>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
    const item = {
      text,
      images,
      resolve: resolveDelivery,
      reject: rejectDelivery,
    };
    return { item, delivery };
  };

  params.signal.addEventListener("abort", abortQueue, { once: true });
  if (params.signal.aborted) {
    abortQueue();
  }

  return {
    async queue(text: string, options?: CodexSteeringQueueOptions) {
      if (closedError) {
        throw closedError;
      }
      if (params.signal.aborted) {
        throw new Error("codex app-server steering queue aborted");
      }
      const pendingUserInput = params.claimPendingUserInput();
      if (pendingUserInput) {
        if (!options?.images?.length) {
          if (pendingUserInput.answer(text)) {
            return ANSWERED_PENDING_INPUT_OUTCOME;
          }
        } else {
          // request_user_input cannot carry images. Submit the complete message
          // before releasing the prompt so no partial text answer can win the race.
          void flushBatch().catch(() => undefined);
          const { item, delivery } = createPendingMessage(text, options.images);
          void enqueueBatch(createBatch([item], pendingUserInput.cancel)).catch(() => undefined);
          return await delivery;
        }
      }
      const { item, delivery } = createPendingMessage(text, options?.images);
      batchedBatch ??= createBatch([]);
      batchedBatch.items.push(item);
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
      return finishBatch(batch, "consumed");
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
