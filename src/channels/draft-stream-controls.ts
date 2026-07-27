/**
 * Finalizable draft stream controls.
 *
 * Coordinates preview updates, final flushes, clears, and deletion callbacks for channel drafts.
 */
import { formatErrorMessage } from "../infra/errors.js";
import { createDraftStreamLoop } from "./draft-stream-loop.js";

/**
 * Mutable finalization flags shared by draft stream controls and channel adapters.
 */
export type FinalizableDraftStreamState = {
  stopped: boolean;
  final: boolean;
};

type StopAndClearMessageIdParams<T> = {
  stopForClear: () => Promise<void>;
  readMessageId: () => T | undefined;
  clearMessageId: () => void;
};

type ClearFinalizableDraftMessageParams<T> = StopAndClearMessageIdParams<T> & {
  isValidMessageId: (value: unknown) => value is T;
  deleteMessage: (messageId: T) => Promise<void>;
  onDeleteFailure?: (messageId: T) => void;
  onDeleteSuccess?: (messageId: T) => void;
  warn?: (message: string) => void;
  warnPrefix: string;
};

type DeleteFinalizableDraftMessageParams<T> = Omit<
  ClearFinalizableDraftMessageParams<T>,
  "isValidMessageId" | "onDeleteFailure" | "stopForClear"
>;

type FinalizableDraftLifecycleParams<T> = Omit<
  ClearFinalizableDraftMessageParams<T>,
  "onDeleteFailure" | "stopForClear"
> & {
  throttleMs: number;
  state: FinalizableDraftStreamState;
  sendOrEditStreamMessage: (text: string) => Promise<boolean>;
};

/**
 * Creates controls for streaming preview messages that can be finalized, sealed, or cleared.
 */
export function createFinalizableDraftStreamControls(params: {
  throttleMs: number;
  isStopped: () => boolean;
  isFinal: () => boolean;
  markStopped: () => void;
  markFinal: () => void;
  sendOrEditStreamMessage: (text: string) => Promise<boolean>;
}) {
  const loop = createDraftStreamLoop({
    throttleMs: params.throttleMs,
    isStopped: params.isStopped,
    sendOrEditStreamMessage: params.sendOrEditStreamMessage,
  });

  const update = (text: string) => {
    // Finalized or stopped streams must ignore late model deltas so a deleted/posted draft is
    // not recreated by an in-flight throttle tick.
    if (params.isStopped() || params.isFinal()) {
      return;
    }
    loop.update(text);
  };

  const stop = async (): Promise<void> => {
    // stop finalizes by flushing the latest pending text into the preview message.
    params.markFinal();
    await loop.flush();
  };

  const stopForClear = async (): Promise<void> => {
    // Clearing deletes the preview, so stop the loop without flushing another edit first.
    params.markStopped();
    loop.stop();
    await loop.waitForInFlight();
  };

  const seal = async (): Promise<void> => {
    // Sealing keeps the preview id for callers that already own final delivery/deletion.
    params.markFinal();
    loop.stop();
    await loop.waitForInFlight();
  };

  return {
    loop,
    update,
    stop,
    seal,
    discardPending: stopForClear,
    stopForClear,
  };
}

/**
 * Creates finalizable draft controls backed by a shared mutable state object.
 */
export function createFinalizableDraftStreamControlsForState(params: {
  throttleMs: number;
  state: FinalizableDraftStreamState;
  sendOrEditStreamMessage: (text: string) => Promise<boolean>;
}) {
  return createFinalizableDraftStreamControls({
    throttleMs: params.throttleMs,
    isStopped: () => params.state.stopped,
    isFinal: () => params.state.final,
    markStopped: () => {
      params.state.stopped = true;
    },
    markFinal: () => {
      params.state.final = true;
    },
    sendOrEditStreamMessage: params.sendOrEditStreamMessage,
  });
}

/**
 * Stops a draft stream, reads the current preview message id, then clears the stored id.
 */
export async function takeMessageIdAfterStop<T>(
  params: StopAndClearMessageIdParams<T>,
): Promise<T | undefined> {
  await params.stopForClear();
  const messageId = params.readMessageId();
  params.clearMessageId();
  return messageId;
}

async function deleteFinalizableDraftMessage<T>(
  params: DeleteFinalizableDraftMessageParams<T>,
  messageId: T,
): Promise<boolean> {
  try {
    await params.deleteMessage(messageId);
  } catch (err) {
    params.warn?.(`${params.warnPrefix}: ${formatErrorMessage(err)}`);
    return false;
  }
  try {
    // A replacement preview may become current while deletion is in flight; never clear its ID.
    if (Object.is(params.readMessageId(), messageId)) {
      params.clearMessageId();
    }
    params.onDeleteSuccess?.(messageId);
  } catch (err) {
    params.warn?.(`${params.warnPrefix} after delete: ${formatErrorMessage(err)}`);
  }
  return true;
}

/**
 * Stops a draft stream and deletes its preview message when the stored id is valid.
 * Claims the current id before deletion; stateful callers can retain failures through
 * onDeleteFailure without making overlapping clears delete the same message twice.
 */
export async function clearFinalizableDraftMessage<T>(
  params: ClearFinalizableDraftMessageParams<T>,
): Promise<void> {
  await params.stopForClear();
  const messageId = params.readMessageId();
  params.clearMessageId();
  if (!params.isValidMessageId(messageId)) {
    return;
  }
  const deleted = await deleteFinalizableDraftMessage(params, messageId);
  if (!deleted) {
    params.onDeleteFailure?.(messageId);
  }
}

/**
 * Builds the standard draft lifecycle used by channel streaming preview implementations.
 */
export function createFinalizableDraftLifecycle<T>(params: FinalizableDraftLifecycleParams<T>) {
  const controls = createFinalizableDraftStreamControlsForState({
    throttleMs: params.throttleMs,
    state: params.state,
    sendOrEditStreamMessage: params.sendOrEditStreamMessage,
  });

  let pendingDeleteIds: T[] = [];
  let clearTail = Promise.resolve();

  const clearOnce = async (stopForClear: () => Promise<void>) => {
    await stopForClear();
    const currentMessageId = params.readMessageId();
    const deleteIds = pendingDeleteIds;
    pendingDeleteIds = [];
    if (!params.isValidMessageId(currentMessageId)) {
      params.clearMessageId();
    } else if (!deleteIds.some((messageId) => Object.is(messageId, currentMessageId))) {
      deleteIds.push(currentMessageId);
    }

    for (const messageId of deleteIds) {
      const deleted = await deleteFinalizableDraftMessage(params, messageId);
      if (!deleted && !pendingDeleteIds.some((pendingId) => Object.is(pendingId, messageId))) {
        pendingDeleteIds.push(messageId);
      }
    }
  };

  const clearWithStop = (stopForClear: () => Promise<void>) => {
    // Custom channel stops share the same serialized retry ownership as the default clear path.
    const clearRun = clearTail.catch(() => {}).then(() => clearOnce(stopForClear));
    clearTail = clearRun;
    return clearRun;
  };
  const clear = () => clearWithStop(controls.stopForClear);

  return {
    ...controls,
    clear,
    clearWithStop,
  };
}
