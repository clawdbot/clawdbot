import { isAbortError, racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";

export class DispatchReplyOperationAbortedError extends Error {
  constructor() {
    super("Dispatch reply operation aborted");
    this.name = "AbortError";
  }
}

export function isDispatchReplyOperationAbortedError(
  error: unknown,
): error is DispatchReplyOperationAbortedError {
  return error instanceof DispatchReplyOperationAbortedError;
}

export function runWithDispatchAbortSignal<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T> | T,
  onWorkStarted?: (work: Promise<unknown>) => void,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new DispatchReplyOperationAbortedError());
  }
  const work = Promise.resolve().then(run);
  onWorkStarted?.(work);
  return racePromiseWithAbortSignal(work, signal).catch((error: unknown) => {
    if (signal?.aborted && isAbortError(error)) {
      throw new DispatchReplyOperationAbortedError();
    }
    throw error;
  });
}

export function createAbortAwareDispatcher(params: {
  dispatcher: ReplyDispatcher;
  isAborted: () => boolean;
}): ReplyDispatcher {
  const sendIfActive =
    (send: (payload: ReplyPayload) => boolean) =>
    (payload: ReplyPayload): boolean =>
      params.isAborted() ? false : send(payload);
  const { getCancelledCounts, prepareReplyPayload } = params.dispatcher;
  const dispatcher: ReplyDispatcher = {
    ...(prepareReplyPayload
      ? { prepareReplyPayload: prepareReplyPayload.bind(params.dispatcher) }
      : {}),
    sendToolResult: sendIfActive(params.dispatcher.sendToolResult),
    sendBlockReply: sendIfActive(params.dispatcher.sendBlockReply),
    sendFinalReply: sendIfActive(params.dispatcher.sendFinalReply),
    ...(params.dispatcher.supportsSettledReceipt ? { supportsSettledReceipt: true } : {}),
    waitForIdle: () => params.dispatcher.waitForIdle(),
    getQueuedCounts: () => params.dispatcher.getQueuedCounts(),
    ...(getCancelledCounts ? { getCancelledCounts: () => getCancelledCounts() } : {}),
    getFailedCounts: () => params.dispatcher.getFailedCounts(),
    markComplete: () => {
      if (!params.isAborted()) {
        params.dispatcher.markComplete();
      }
    },
  };
  return dispatcher;
}
