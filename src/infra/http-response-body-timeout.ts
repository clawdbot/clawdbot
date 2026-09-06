// Applies idle and overall deadlines to fetch response-body reads.
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";

type TimeoutErrorFactory = (params: { timeoutMs: number }) => Error;

function createResponseBodyTimeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

export async function withResponseBodyTimeout<T>(params: {
  timeoutMs: number | undefined;
  onTimeout: TimeoutErrorFactory | undefined;
  cancel: (error: Error) => Promise<unknown>;
  read: (refreshTimeout?: () => void) => Promise<T>;
}): Promise<T> {
  if (params.timeoutMs === undefined) {
    return await params.read();
  }
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timeoutError: Error | undefined;

  return await new Promise<T>((resolve, reject) => {
    const clear = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    timeoutId = setTimeout(() => {
      const error =
        params.onTimeout?.({ timeoutMs }) ??
        createResponseBodyTimeoutError(`Response body timed out after ${timeoutMs}ms`);
      timeoutError = error;
      clear();
      void params.cancel(error).catch(() => undefined);
      reject(error);
    }, timeoutMs);
    if (typeof timeoutId === "object" && "unref" in timeoutId) {
      timeoutId.unref();
    }

    void Promise.resolve()
      .then(() =>
        params.read(() => {
          // A late read must not restart an expired deadline or consume another chunk.
          if (timeoutError) {
            throw timeoutError;
          }
          timeoutId?.refresh();
        }),
      )
      .then(
        (value) => {
          clear();
          if (!timeoutError) {
            resolve(value);
          }
        },
        (error: unknown) => {
          clear();
          if (!timeoutError) {
            reject(toErrorObject(error, "Non-Error rejection"));
          }
        },
      );
  });
}

/** Owns one refreshable idle deadline for a bounded response-body operation. */
export function withResponseBodyIdleTimeout<T>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunkTimeoutMs: number | undefined,
  onIdleTimeout: ((params: { chunkTimeoutMs: number }) => Error) | undefined,
  read: (refreshTimeout?: () => void) => Promise<T>,
): Promise<T> {
  if (chunkTimeoutMs === undefined) {
    return read();
  }
  return withResponseBodyTimeout({
    timeoutMs: chunkTimeoutMs,
    onTimeout: ({ timeoutMs }) =>
      onIdleTimeout?.({ chunkTimeoutMs: timeoutMs }) ??
      createResponseBodyTimeoutError(`Media download stalled: no data received for ${timeoutMs}ms`),
    // Cancellation releases fetch sockets and buffers instead of letting the
    // pending read continue after the caller has failed.
    cancel: async (error) => await reader.cancel(error),
    read,
  });
}

/** Reads one chunk, rejecting and cancelling the reader after an idle timeout. */
export async function readChunkWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunkTimeoutMs: number,
  onIdleTimeout?: (params: { chunkTimeoutMs: number }) => Error,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  return await withResponseBodyIdleTimeout(reader, chunkTimeoutMs, onIdleTimeout, () =>
    reader.read(),
  );
}
