type BoundedResponseTextOptions = {
  createTooLargeError?: (message: string) => Error;
  formatTooLargeMessage?: (label: string, maxBytes: number) => string;
  signal?: AbortSignal;
  timeoutPromise?: Promise<never>;
};

const defaultTooLargeMessage = (label: string, maxBytes: number) =>
  `${label} response body exceeded ${maxBytes} bytes`;

const defaultTooLargeError = (message: string) => new Error(`${message}.`);

async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  label: string,
  signal: AbortSignal | undefined,
  markCanceled: () => void,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) {
    return await reader.read();
  }
  if (signal.aborted) {
    markCanceled();
    await reader.cancel().catch(() => undefined);
    throw signal.reason instanceof Error ? signal.reason : new Error(`${label} request aborted`);
  }

  let removeAbortListener: (() => void) | undefined;
  const abortPromise = new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => {
    const onAbort = () => {
      markCanceled();
      void reader.cancel().catch(() => undefined);
      reject(
        signal.reason instanceof Error ? signal.reason : new Error(`${label} request aborted`),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });

  try {
    return await Promise.race([reader.read(), abortPromise]);
  } finally {
    removeAbortListener?.();
  }
}

export async function readBoundedResponseText(
  response: Response,
  label: string,
  maxBytes: number,
  options: BoundedResponseTextOptions = {},
): Promise<string> {
  const formatTooLargeMessage = options.formatTooLargeMessage ?? defaultTooLargeMessage;
  const createTooLargeError = options.createTooLargeError ?? defaultTooLargeError;
  const tooLargeError = () => createTooLargeError(formatTooLargeMessage(label, maxBytes));
  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLargeError();
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  let canceled = false;

  try {
    for (;;) {
      const { done, value } = await (options.timeoutPromise
        ? Promise.race([
            readResponseChunk(reader, label, options.signal, () => {
              canceled = true;
            }),
            options.timeoutPromise,
          ])
        : readResponseChunk(reader, label, options.signal, () => {
            canceled = true;
          }));
      if (done) {
        const tail = decoder.decode();
        if (tail) {
          chunks.push(tail);
        }
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        canceled = true;
        await reader.cancel().catch(() => undefined);
        throw tooLargeError();
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    if (!canceled) {
      reader.releaseLock();
    }
  }

  return chunks.join("");
}
