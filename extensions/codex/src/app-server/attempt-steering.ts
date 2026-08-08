import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  isCodexAppServerIndeterminateRequestCancellationError,
  isCodexAppServerIndeterminateTransportError,
  type CodexAppServerClient,
} from "./client.js";
import { buildCodexUserInput } from "./user-input.js";

const DEFAULT_DEBOUNCE_MS = 500;

export class CodexSteeringAcceptedUnconfirmedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexSteeringAcceptedUnconfirmedError";
  }
}

export type CodexSteeringQueueOptions = {
  debounceMs?: number;
  images?: EmbeddedRunAttemptParams["images"];
  inputProvenance?: EmbeddedRunAttemptParams["inputProvenance"];
  isInboundUserMessage?: boolean;
};

type Outcome = { kind: "answered-pending-input" } | { kind: "steered" };
type Item = {
  text: string;
  images?: EmbeddedRunAttemptParams["images"];
  resolve(outcome: Outcome): void;
  reject(error: unknown): void;
};
type Batch = {
  accepted: boolean;
  items: Item[];
  clientId?: string;
  gate: Promise<void>;
  releaseGate(error?: unknown): void;
};

function createItem(text: string, images?: Item["images"]) {
  let resolve!: Item["resolve"];
  let reject!: Item["reject"];
  const delivery = new Promise<Outcome>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { delivery, item: { text, images, resolve, reject } };
}

export function createCodexSteeringQueue(params: {
  client: CodexAppServerClient;
  threadId: string;
  turnId: string;
  requestTimeoutMs: number;
  claimPendingUserInput: () => { answer(text: string): boolean; cancel(): boolean } | undefined;
  signal: AbortSignal;
}) {
  let pendingBatch: Batch | undefined;
  let timer: NodeJS.Timeout | undefined;
  let sequence = 0;
  let sendChain = Promise.resolve();
  let closedError: Error | undefined;
  const batches = new Set<Batch>();
  const batchesByClientId = new Map<string, Batch>();

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const createBatch = (releaseClaim?: () => void): Batch => {
    let resolveGate!: () => void;
    let rejectGate!: (error: unknown) => void;
    const gate = new Promise<void>((resolve, reject) => {
      resolveGate = resolve;
      rejectGate = reject;
    });
    void gate.catch(() => {});
    let released = false;
    const batch: Batch = {
      accepted: false,
      items: [],
      gate,
      releaseGate(error) {
        if (released) {
          return;
        }
        released = true;
        try {
          releaseClaim?.();
        } catch {}
        if (error === undefined) {
          resolveGate();
        } else {
          rejectGate(error);
        }
      },
    };
    batches.add(batch);
    return batch;
  };

  const finish = (batch: Batch, error?: unknown, accepted = batch.accepted) => {
    if (!batches.delete(batch)) {
      return false;
    }
    if (batch.clientId) {
      batchesByClientId.delete(batch.clientId);
    }
    const deliveryError =
      error !== undefined && accepted && !(error instanceof CodexSteeringAcceptedUnconfirmedError)
        ? new CodexSteeringAcceptedUnconfirmedError(
            "Codex accepted steering but did not confirm transcript consumption",
            { cause: error },
          )
        : error;
    for (const item of batch.items) {
      if (deliveryError === undefined) {
        item.resolve({ kind: "steered" });
      } else {
        item.reject(deliveryError);
      }
    }
    batch.releaseGate(error);
    return true;
  };

  const close = (error: Error) => {
    if (closedError) {
      return;
    }
    closedError = error;
    params.signal.removeEventListener("abort", abort);
    clearTimer();
    pendingBatch = undefined;
    for (const batch of batches) {
      finish(batch, error);
    }
  };
  const abort = () => close(new Error("codex app-server steering queue aborted"));

  const dispatch = (batch: Batch): Promise<void> => {
    if (!batches.has(batch) || batch.clientId) {
      return batch.gate;
    }
    const unavailable =
      closedError ??
      (params.signal.aborted ? new Error("codex app-server steering queue aborted") : undefined);
    if (unavailable) {
      finish(batch, unavailable);
      return batch.gate;
    }
    const clientId = `openclaw:${params.turnId}:steer:${++sequence}`;
    batch.clientId = clientId;
    batchesByClientId.set(clientId, batch);
    let request: Promise<unknown>;
    try {
      request = params.client.request(
        "turn/steer",
        {
          threadId: params.threadId,
          expectedTurnId: params.turnId,
          input: batch.items.flatMap((item) => buildCodexUserInput(item.text, item.images)),
          clientUserMessageId: clientId,
        },
        { timeoutMs: params.requestTimeoutMs, signal: params.signal },
      );
    } catch (error) {
      finish(batch, error);
      return batch.gate;
    }
    void request.then(
      () => {
        if (batches.has(batch)) {
          batch.accepted = true;
          batch.releaseGate();
        }
      },
      (error: unknown) => {
        if (!batches.has(batch)) {
          return;
        }
        const indeterminate =
          isCodexAppServerIndeterminateRequestCancellationError(error) ||
          isCodexAppServerIndeterminateTransportError(error);
        finish(
          batch,
          indeterminate
            ? new CodexSteeringAcceptedUnconfirmedError(
                "Codex steering request may have been accepted before confirmation",
                { cause: error },
              )
            : error,
          indeterminate,
        );
      },
    );
    return batch.gate;
  };

  const enqueue = (batch: Batch) => {
    const sent = sendChain.then(() => dispatch(batch));
    sendChain = sent.catch(() => {});
    void sent.catch(() => {});
    return sent;
  };

  const flush = () => {
    clearTimer();
    const batch = pendingBatch;
    pendingBatch = undefined;
    return batch ? enqueue(batch) : sendChain;
  };

  params.signal.addEventListener("abort", abort, { once: true });
  if (params.signal.aborted) {
    abort();
  }

  return {
    async queue(text: string, options?: CodexSteeringQueueOptions) {
      if (closedError) {
        throw closedError;
      }
      const pendingInput = params.claimPendingUserInput();
      if (pendingInput && !options?.images?.length && pendingInput.answer(text)) {
        return { kind: "answered-pending-input" } as const;
      }
      const { item, delivery } = createItem(text, options?.images);
      if (pendingInput && options?.images?.length) {
        void flush().catch(() => {});
        const batch = createBatch(() => pendingInput.cancel());
        batch.items.push(item);
        void enqueue(batch).catch(() => {});
      } else {
        pendingBatch ??= createBatch();
        pendingBatch.items.push(item);
        clearTimer();
        const debounceMs = normalizeDebounceMs(options?.debounceMs);
        if (debounceMs === 0) {
          void flush();
        } else {
          timer = setTimeout(() => void flush(), debounceMs);
        }
      }
      return await delivery;
    },
    async flushPending() {
      if (!closedError) {
        await flush().catch(() => {});
      }
    },
    confirmConsumed(clientId: string) {
      const batch = batchesByClientId.get(clientId);
      return batch ? finish(batch) : false;
    },
    cancel: () => close(new Error("codex app-server steering queue cancelled")),
  };
}

function normalizeDebounceMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_DEBOUNCE_MS;
}
