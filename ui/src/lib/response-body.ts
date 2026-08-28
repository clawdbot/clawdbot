// Control UI response helpers own bounded browser body consumption.

type ResponseTextLimitOptions = {
  maxBytes: number;
  tooLargeMessage: string;
  missingBodyMessage?: string;
};

function parseContentLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (!raw) {
    return null;
  }
  if (!/^\d+$/u.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export async function readResponseTextWithLimit(
  response: Response,
  options: ResponseTextLimitOptions,
): Promise<string> {
  const contentLength = parseContentLength(response.headers);
  if (contentLength !== null && contentLength > options.maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(options.tooLargeMessage);
  }
  if (!response.body) {
    if (options.missingBodyMessage) {
      throw new Error(options.missingBodyMessage);
    }
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        const tail = decoder.decode();
        if (tail) {
          chunks.push(tail);
        }
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > options.maxBytes) {
        // Cancellation is best-effort; finally always releases this reader's lock.
        void reader.cancel().catch(() => undefined);
        throw new Error(options.tooLargeMessage);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }
  return chunks.join("");
}
