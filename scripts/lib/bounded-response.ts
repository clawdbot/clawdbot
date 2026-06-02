type BoundedResponseTextOptions = {
  createTooLargeError?: (message: string) => Error;
  formatTooLargeMessage?: (label: string, maxBytes: number) => string;
  signal?: AbortSignal;
  timeoutPromise?: Promise<never>;
};

const defaultTooLargeMessage = (label: string, maxBytes: number) =>
  `${label} response body exceeded ${maxBytes} bytes`;

const defaultTooLargeError = (message: string) => new Error(`${message}.`);

function cancelReaderSoon(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  void Promise.resolve()
    .then(() => reader.cancel())
    .catch(() => undefined);
}

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
      reject(
        signal.reason instanceof Error ? signal.reason : new Error(`${label} request aborted`),
      );
      cancelReaderSoon(reader);
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

function toErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  return new Error(fallbackMessage, { cause: value });
}

async function readResponseChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  label: string,
  signal: AbortSignal | undefined,
  timeoutPromise: Promise<never> | undefined,
  markCanceled: () => void,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const readPromise = readResponseChunk(reader, label, signal, markCanceled);
  if (!timeoutPromise) {
    return await readPromise;
  }

  let waitingForRead = true;
  const timeoutReadPromise = timeoutPromise.catch((error: unknown) => {
    if (waitingForRead) {
      markCanceled();
      cancelReaderSoon(reader);
    }
    throw toErrorObject(error, `${label} response body read timed out`);
  });

  try {
    return await Promise.race([readPromise, timeoutReadPromise]);
  } finally {
    waitingForRead = false;
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
      const { done, value } = await readResponseChunkWithTimeout(
        reader,
        label,
        options.signal,
        options.timeoutPromise,
        () => {
          canceled = true;
        },
      );
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
