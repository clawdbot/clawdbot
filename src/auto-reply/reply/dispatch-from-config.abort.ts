import { isAbortError } from "../../infra/abort-signal.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";
import { readDispatcherFailedCounts } from "./reply-dispatcher.types.js";

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
  const shouldStopForAbort = () => signal?.aborted === true;
  let settled = false;
  let abortHandler: (() => void) | undefined;
  const work = Promise.resolve()
    .then(run)
    .then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        if (shouldStopForAbort() && isAbortError(error)) {
          throw new DispatchReplyOperationAbortedError();
        }
        throw error;
      },
    );
  onWorkStarted?.(work);
  if (!signal) {
    return work;
  }
  const aborted = new Promise<never>((_, reject) => {
    abortHandler = () => {
      if (!settled && shouldStopForAbort()) {
        reject(new DispatchReplyOperationAbortedError());
      }
    };
    signal.addEventListener("abort", abortHandler, { once: true });
  });
  return Promise.race([work, aborted]).finally(() => {
    settled = true;
    if (abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
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
  const dispatcher: ReplyDispatcher = {
    sendToolResult: sendIfActive(params.dispatcher.sendToolResult),
    sendBlockReply: sendIfActive(params.dispatcher.sendBlockReply),
    sendFinalReply: sendIfActive(params.dispatcher.sendFinalReply),
    waitForIdle: () => params.dispatcher.waitForIdle(),
    getQueuedCounts: () => params.dispatcher.getQueuedCounts(),
    getFailedCounts: () => readDispatcherFailedCounts(params.dispatcher),
    markComplete: () => {
      if (!params.isAborted()) {
        params.dispatcher.markComplete();
      }
    },
  };
  if (params.dispatcher.getCancelledCounts) {
    dispatcher.getCancelledCounts = () => params.dispatcher.getCancelledCounts!();
  }
  return dispatcher;
}
