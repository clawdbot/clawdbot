// Applies idle and overall deadlines to fetch response-body reads.
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";

type TimeoutErrorFactory = (params: { timeoutMs: number }) => Error;

async function withCancellableTimeout<T>(params: {
  timeoutMs: number;
  onTimeout: TimeoutErrorFactory;
  cancel: (error: Error) => Promise<unknown>;
  read: () => Promise<T>;
}): Promise<T> {
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  return await new Promise<T>((resolve, reject) => {
    const clear = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    timeoutId = setTimeout(() => {
      timedOut = true;
      const error = params.onTimeout({ timeoutMs });
      clear();
      void params.cancel(error).catch(() => undefined);
      reject(error);
    }, timeoutMs);
    if (typeof timeoutId === "object" && "unref" in timeoutId) {
      timeoutId.unref();
    }

    void Promise.resolve()
      .then(params.read)
      .then(
        (value) => {
          clear();
          if (!timedOut) {
            resolve(value);
          }
        },
        (error: unknown) => {
          clear();
          if (!timedOut) {
            reject(toErrorObject(error, "Non-Error rejection"));
          }
        },
      );
  });
}

/** Reads one chunk, rejecting and cancelling the reader after an idle timeout. */
export async function readChunkWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunkTimeoutMs: number,
  onIdleTimeout?: (params: { chunkTimeoutMs: number }) => Error,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  return await withCancellableTimeout({
    timeoutMs: chunkTimeoutMs,
    onTimeout: ({ timeoutMs }) =>
      onIdleTimeout?.({ chunkTimeoutMs: timeoutMs }) ??
      new Error(`Media download stalled: no data received for ${timeoutMs}ms`),
    // Cancellation releases fetch sockets and buffers instead of letting the
    // pending read continue after the caller has failed.
    cancel: async (error) => await reader.cancel(error),
    read: async () => await reader.read(),
  });
}

export async function withResponseBodyTimeout<T>(params: {
  timeoutMs: number | undefined;
  onTimeout: TimeoutErrorFactory | undefined;
  cancel: (error: Error) => Promise<unknown>;
  read: () => Promise<T>;
}): Promise<T> {
  if (params.timeoutMs === undefined) {
    return await params.read();
  }
  return await withCancellableTimeout({
    timeoutMs: params.timeoutMs,
    onTimeout: ({ timeoutMs }) =>
      params.onTimeout?.({ timeoutMs }) ??
      new Error(`Response body timed out after ${timeoutMs}ms`),
    // Fetch resolves at headers. Body cancellation owns socket cleanup when
    // the separate whole-body deadline wins.
    cancel: params.cancel,
    read: params.read,
  });
}
