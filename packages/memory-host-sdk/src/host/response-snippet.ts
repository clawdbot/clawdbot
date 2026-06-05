// Memory Host SDK module implements response snippet behavior.
const DEFAULT_ERROR_BODY_MAX_BYTES = 8 * 1024;
const DEFAULT_ERROR_BODY_MAX_CHARS = 1_000;
const DEFAULT_JSON_BODY_MAX_BYTES = 64 * 1024 * 1024;
const TRUNCATED_SUFFIX = "... [truncated]";

// Bounded response readers for provider/remote HTTP errors and JSON bodies.
type ResponseTextSnippetOptions = {
  maxBytes?: number;
  maxChars?: number;
};

type ResponseJsonOptions = {
  maxBytes?: number;
  errorPrefix: string;
};

type ResponsePrefix = {
  bytes: Uint8Array[];
  length: number;
  truncated: boolean;
};

/** Read a small collapsed text snippet from a response body. */
export async function readResponseTextSnippet(
  res: Response,
  options: ResponseTextSnippetOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_ERROR_BODY_MAX_BYTES;
  const maxChars = options.maxChars ?? DEFAULT_ERROR_BODY_MAX_CHARS;
  const prefix = await readResponsePrefix(res, maxBytes);
  if (prefix.length === 0) {
    return "";
  }

  const text = new TextDecoder().decode(joinChunks(prefix.bytes, prefix.length));
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "";
  }
  if (prefix.truncated || collapsed.length > maxChars) {
    return `${collapsed.slice(0, maxChars)}${TRUNCATED_SUFFIX}`;
  }
  return collapsed;
}

/** Read and parse JSON while enforcing a hard byte limit. */
export async function readResponseJsonWithLimit(
  res: Response,
  options: ResponseJsonOptions,
): Promise<unknown> {
  const maxBytes = options.maxBytes ?? DEFAULT_JSON_BODY_MAX_BYTES;
  const contentLength = parseContentLength(res.headers.get("content-length"), options.errorPrefix);
  if (typeof contentLength === "number" && contentLength > maxBytes) {
    await cancelResponseBody(res);
    throw responseTooLarge(options.errorPrefix, contentLength, maxBytes);
  }

  const text = await readResponseTextWithLimit(res, maxBytes, options.errorPrefix);

  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`${options.errorPrefix}: malformed JSON response`, { cause });
  }
}

async function readResponsePrefix(res: Response, maxBytes: number): Promise<ResponsePrefix> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    return { bytes: [], length: 0, truncated: false };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value?.length) {
        continue;
      }

      const remaining = maxBytes - length;
      if (value.length >= remaining) {
        // Keep only the configured prefix and cancel the body so callers do not
        // accidentally buffer large provider error responses.
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          length += remaining;
        }
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }

      chunks.push(value);
      length += value.length;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  return { bytes: chunks, length, truncated };
}

async function readResponseTextWithLimit(
  res: Response,
  maxBytes: number,
  errorPrefix: string,
): Promise<string> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    return "";
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value?.length) {
        continue;
      }

      const nextLength = length + value.length;
      if (nextLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw responseTooLarge(errorPrefix, nextLength, maxBytes);
      }

      chunks.push(value);
      length = nextLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  return new TextDecoder().decode(joinChunks(chunks, length));
}

async function cancelResponseBody(res: Response): Promise<void> {
  const body = res.body;
  if (!body || typeof body.cancel !== "function") {
    return;
  }
  await body.cancel().catch(() => undefined);
}

function parseContentLength(raw: string | null, errorPrefix: string): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^(0|[1-9]\d*)$/.test(trimmed)) {
    throw new Error(`${errorPrefix}: invalid content-length header: ${raw}`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${errorPrefix}: invalid content-length header: ${raw}`);
  }
  return value;
}

function responseTooLarge(errorPrefix: string, size: number, maxBytes: number): Error {
  return new Error(responseTooLargeMessage(errorPrefix, size, maxBytes));
}

function responseTooLargeMessage(errorPrefix: string, size: number, maxBytes: number): string {
  return `${errorPrefix}: response body too large: ${size} bytes (limit: ${maxBytes} bytes)`;
}

function joinChunks(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]?.length === length) {
    return chunks[0];
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}
