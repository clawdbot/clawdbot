// Reads response bodies with byte limits, abort handling, and timeout cancellation.
function defaultTooLargeMessage(label, maxBytes) {
  return `${label} response body exceeded ${maxBytes} bytes`;
}

function defaultTooLargeError(message) {
  return new Error(message);
}

export function createBoundedResponseTooLargeError(message) {
  return Object.assign(new Error(message), { code: "ETOOBIG" });
}

function cancelReaderSoon(reader) {
  void Promise.resolve()
    .then(() => reader.cancel())
    .catch(() => undefined);
}

function parseContentLengthHeader(headers) {
  const raw = headers.get("content-length");
  if (!raw || !/^\d+$/u.test(raw)) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

async function readResponseChunk(reader, label, signal, markCanceled) {
  if (!signal) {
    return await reader.read();
  }
  if (signal.aborted) {
    markCanceled();
    await reader.cancel().catch(() => undefined);
    throw signal.reason instanceof Error ? signal.reason : new Error(`${label} request aborted`);
  }

  let removeAbortListener;
  const abortPromise = new Promise((_resolve, reject) => {
    const onAbort = () => {
      markCanceled();
      reject(
        toLintErrorObject(
          signal.reason instanceof Error ? signal.reason : new Error(`${label} request aborted`),
          "Non-Error rejection",
        ),
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

async function readResponseChunkWithTimeout(reader, label, signal, timeoutPromise, markCanceled) {
  const readPromise = readResponseChunk(reader, label, signal, markCanceled);
  if (!timeoutPromise) {
    return await readPromise;
  }

  let waitingForRead = true;
  const timeoutReadPromise = timeoutPromise.catch((error) => {
    if (waitingForRead) {
      markCanceled();
      cancelReaderSoon(reader);
    }
    throw toLintErrorObject(error, `${label} response body read timed out`);
  });

  try {
    return await Promise.race([readPromise, timeoutReadPromise]);
  } finally {
    waitingForRead = false;
  }
}

/** Read response bytes while enforcing max bytes before and during streaming. */
export async function readBoundedResponseBytes(response, label, maxBytes, options = {}) {
  const formatTooLargeMessage = options.formatTooLargeMessage ?? defaultTooLargeMessage;
  const createTooLargeError = options.createTooLargeError ?? defaultTooLargeError;
  const tooLargeError = () => createTooLargeError(formatTooLargeMessage(label, maxBytes));
  const contentLength = parseContentLengthHeader(response.headers);
  if (contentLength !== undefined && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLargeError();
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks = [];
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
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        canceled = true;
        await reader.cancel().catch(() => undefined);
        throw tooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    if (!canceled) {
      reader.releaseLock();
    }
  }

  return Buffer.concat(chunks, totalBytes);
}

/** Read response text while enforcing max bytes before and during streaming. */
export async function readBoundedResponseText(response, label, maxBytes, options = {}) {
  const bytes = await readBoundedResponseBytes(response, label, maxBytes, options);
  return new TextDecoder().decode(bytes);
}

function toLintErrorObject(value, fallbackMessage) {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
