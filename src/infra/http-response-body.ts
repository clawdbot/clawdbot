// Response readers do not depend on inbound request lifecycle or logging policy.
import { decodeTextPrefix } from "@openclaw/normalization-core";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  withResponseBodyIdleTimeout,
  withResponseBodyTimeout,
} from "./http-response-body-timeout.js";

/** Requests cancellation only when no consumer has started reading the body. */
export async function cancelUnreadResponseBody(response: Response | undefined): Promise<void> {
  if (response && !response.bodyUsed) {
    // A capture tee must not delay errors or the caller's bounded dispatcher release.
    void response.body?.cancel().catch(() => undefined);
  }
}

type ReadResponsePrefixResult = {
  materializeBuffer: () => Buffer;
  size: number;
  truncated: boolean;
};

export type ReadResponseTextPrefixOptions = {
  chunkTimeoutMs?: number;
  onIdleTimeout?: (params: { chunkTimeoutMs: number }) => Error;
  /** Static timeout or lazy resolver evaluated immediately before body consumption. */
  timeoutMs?: number | (() => number);
  onTimeout?: (params: { timeoutMs: number }) => Error;
};

type ReadResponsePrefixOptions = ReadResponseTextPrefixOptions & {
  stopAtLimit?: boolean;
};

async function readResponsePrefixFromReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
  options?: ReadResponsePrefixOptions,
): Promise<ReadResponsePrefixResult> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    await withResponseBodyIdleTimeout(
      reader,
      options?.chunkTimeoutMs || undefined,
      options?.onIdleTimeout,
      async (refreshTimeout) => {
        while (true) {
          refreshTimeout?.();
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (!value?.length) {
            continue;
          }
          const remaining = maxBytes - size;
          size += value.length;
          if (size > maxBytes || (options?.stopAtLimit && size === maxBytes)) {
            if (remaining > 0) {
              chunks.push(value.subarray(0, remaining));
            }
            truncated = true;
            // A capture tee can retain cancellation until the caller releases its request.
            void reader.cancel().catch(() => undefined);
            break;
          }
          chunks.push(value);
        }
      },
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  return {
    // Full-body readers reject overflow before allocating a contiguous copy.
    // MiB limits can yield fractional bytes; retained slices contain only whole bytes.
    materializeBuffer: () => Buffer.concat(chunks, Math.floor(Math.min(size, maxBytes))),
    size,
    truncated,
  };
}

async function readResponsePrefix(
  response: Response,
  maxBytes: number,
  options?: ReadResponsePrefixOptions,
): Promise<ReadResponsePrefixResult> {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxBytes must be a non-negative finite number: ${maxBytes}`);
  }
  let timeoutMs: number | undefined;
  try {
    timeoutMs = typeof options?.timeoutMs === "function" ? options.timeoutMs() : options?.timeoutMs;
  } catch (error) {
    void response.body?.cancel(error).catch(() => undefined);
    throw error;
  }
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    return await withResponseBodyTimeout({
      timeoutMs,
      onTimeout: options?.onTimeout,
      cancel: async (error) => await body?.cancel(error),
      read: async () => {
        const fallback = Buffer.from(await response.arrayBuffer());
        const truncated = fallback.length > maxBytes;
        return {
          materializeBuffer: () => (truncated ? fallback.subarray(0, maxBytes) : fallback),
          size: fallback.length,
          truncated,
        };
      },
    });
  }

  const reader = body.getReader();
  return await withResponseBodyTimeout({
    timeoutMs,
    onTimeout: options?.onTimeout,
    cancel: async (error) => await reader.cancel(error),
    read: async () => await readResponsePrefixFromReader(reader, maxBytes, options),
  });
}

export type ReadResponseTextPrefixResult = {
  text: string;
  size: number;
  truncated: boolean;
};

/** Reads and decodes a bounded text prefix while cancelling unread overflow. */
export async function readResponseTextPrefix(
  response: Response,
  maxBytes: number,
  options?: ReadResponseTextPrefixOptions,
): Promise<ReadResponseTextPrefixResult> {
  const prefix = await readResponsePrefix(response, maxBytes, {
    ...options,
    stopAtLimit: true,
  });
  return {
    text: decodeTextPrefix(prefix.materializeBuffer(), { truncated: prefix.truncated }),
    size: prefix.size,
    truncated: prefix.truncated,
  };
}

/** Reads a response body under byte, idle, and overall timeout bounds. */
export async function readResponseWithLimit(
  response: Response,
  maxBytes: number,
  options?: ReadResponseTextPrefixOptions & {
    onOverflow?: (params: { size: number; maxBytes: number; res: Response }) => Error;
  },
): Promise<Buffer> {
  const onOverflow = options?.onOverflow;
  const prefix = await readResponsePrefix(response, maxBytes, {
    chunkTimeoutMs: options?.chunkTimeoutMs,
    onIdleTimeout: options?.onIdleTimeout,
    timeoutMs: options?.timeoutMs,
    onTimeout: options?.onTimeout,
  });
  if (prefix.truncated) {
    throw onOverflow
      ? onOverflow({ size: prefix.size, maxBytes, res: response })
      : new Error(`Content too large: ${prefix.size} bytes (limit: ${maxBytes} bytes)`);
  }
  return prefix.materializeBuffer();
}

/** Reads a small collapsed text prefix from a response body for diagnostics/errors. */
export async function readResponseTextSnippet(
  response: Response,
  options?: ReadResponseTextPrefixOptions & {
    maxBytes?: number;
    maxChars?: number;
  },
): Promise<string | undefined> {
  const maxBytes = options?.maxBytes ?? 8 * 1024;
  const maxChars = options?.maxChars ?? 200;
  const prefix = await readResponseTextPrefix(response, maxBytes, {
    chunkTimeoutMs: options?.chunkTimeoutMs,
    onIdleTimeout: options?.onIdleTimeout,
    timeoutMs: options?.timeoutMs,
    onTimeout: options?.onTimeout,
  });
  if (!prefix.text) {
    return undefined;
  }

  const collapsed = prefix.text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return undefined;
  }
  if (collapsed.length > maxChars) {
    return `${truncateUtf16Safe(collapsed, maxChars)}…`;
  }
  return prefix.truncated ? `${collapsed}…` : collapsed;
}
