import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../transports/transport-utils.js";
import { createSseByteGuard } from "../utils/streaming-byte-guard.js";

const OPENAI_CHATGPT_RESPONSES_SUCCESS_BODY_MAX_BYTES = 16 * 1024 * 1024;

export class CodexProtocolError extends Error {
  readonly payload?: unknown;

  constructor(message: string, options?: { payload?: unknown; cause?: unknown }) {
    super(message);
    this.name = "CodexProtocolError";
    this.payload = options?.payload;
    this.cause = options?.cause;
  }
}

export async function* parseOpenAIChatGptResponsesSse(
  response: Response,
): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  // Cap the streaming 200 success-body read at 16 MiB, mirroring the
  // non-streaming response cap so a hostile endpoint cannot exhaust memory.
  const guard = createSseByteGuard(reader, {
    maxBytes: OPENAI_CHATGPT_RESPONSES_SUCCESS_BODY_MAX_BYTES,
    onOverflow: ({ size, maxBytes }) =>
      new Error(
        `OpenAI ChatGPT Responses success body exceeded ${maxBytes} bytes (received ${size})`,
      ),
  });
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await guard.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) {
        buffer += decoder.decode();
      }

      while (true) {
        // Defer a possible CRLF only when CR does not already complete a blank line.
        const deferTrailingCr =
          !done && buffer.endsWith("\r") && !buffer.endsWith("\r\r") && !buffer.endsWith("\n\r");
        const searchable = deferTrailingCr ? buffer.slice(0, -1) : buffer;
        // A CRLF is one line ending: never backtrack its CR into a false blank line.
        const boundary = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/.exec(searchable);
        if (!boundary) {
          break;
        }
        const chunk = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);

        const dataLines = chunk
          .split(/\r\n|\r|\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (dataLines.length > 0) {
          const data = dataLines.join("\n").trim();
          if (data && data !== "[DONE]") {
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(data) as Record<string, unknown>;
            } catch (cause) {
              if (!(cause instanceof SyntaxError)) {
                throw cause;
              }
              throw new CodexProtocolError(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, { cause });
            }
            // Keep suspension outside the parse catch so consumer failures stay consumer-owned.
            yield event;
          }
        }
      }

      if (done) {
        break;
      }
    }
  } finally {
    try {
      await guard.cancel();
    } catch {}
    try {
      reader.releaseLock();
    } catch {}
  }
}
