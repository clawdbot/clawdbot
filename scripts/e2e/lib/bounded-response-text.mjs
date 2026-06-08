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

export async function readBoundedResponseText(response, label, byteLimit, timeoutPromise) {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > byteLimit) {
      await response.body?.cancel().catch(() => {});
      throw bodyTooLargeError(label, byteLimit);
    }
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let text = "";
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
        return text + decoder.decode();
      }
      byteCount += value.byteLength;
      if (byteCount > byteLimit) {
        canceled = true;
        await reader.cancel().catch(() => {});
        throw bodyTooLargeError(label, byteLimit);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    if (!canceled) {
      reader.releaseLock();
    }
  }
}
