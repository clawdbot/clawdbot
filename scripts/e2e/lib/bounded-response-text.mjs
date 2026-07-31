// Bounded response body reader used by E2E HTTP fixture clients.
function bodyTooLargeError(label, byteLimit) {
  return Object.assign(new Error(`${label} response body exceeded ${byteLimit} bytes`), {
    code: "ETOOBIG",
  });
}

function cancelReaderSoon(reader) {
  void Promise.resolve()
    .then(() => reader.cancel())
    .catch(() => {});
}

function parseContentLengthHeader(headers) {
  const raw = headers.get("content-length");
  if (!raw || !/^\d+$/u.test(raw)) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export async function readBoundedResponseBytes(response, label, byteLimit, timeoutPromise) {
  const contentLength = parseContentLengthHeader(response.headers);
  if (contentLength !== undefined && contentLength > byteLimit) {
    await response.body?.cancel().catch(() => {});
    throw bodyTooLargeError(label, byteLimit);
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let byteCount = 0;
  let canceled = false;
  try {
    while (true) {
      const read = reader.read();
      const readWithTimeout = timeoutPromise
        ? Promise.race([
            read,
            timeoutPromise.catch((error) => {
              canceled = true;
              cancelReaderSoon(reader);
              throw error;
            }),
          ])
        : read;
      const { done, value } = await readWithTimeout;
      if (done) {
        return Buffer.concat(chunks, byteCount);
      }
      byteCount += value.byteLength;
      if (byteCount > byteLimit) {
        canceled = true;
        await reader.cancel().catch(() => {});
        throw bodyTooLargeError(label, byteLimit);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    if (!canceled) {
      reader.releaseLock();
    }
  }
}

export async function readBoundedResponseText(response, label, byteLimit, timeoutPromise) {
  const bytes = await readBoundedResponseBytes(response, label, byteLimit, timeoutPromise);
  return new TextDecoder().decode(bytes);
}
