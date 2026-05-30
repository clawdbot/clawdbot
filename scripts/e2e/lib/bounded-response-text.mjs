function bodyTooLargeError(label, byteLimit) {
  return Object.assign(new Error(`${label} response body exceeded ${byteLimit} bytes`), {
    code: "ETOOBIG",
  });
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
  try {
    while (true) {
      const { done, value } = await (timeoutPromise
        ? Promise.race([reader.read(), timeoutPromise])
        : reader.read());
      if (done) {
        return text + decoder.decode();
      }
      byteCount += value.byteLength;
      if (byteCount > byteLimit) {
        await reader.cancel().catch(() => {});
        throw bodyTooLargeError(label, byteLimit);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}
