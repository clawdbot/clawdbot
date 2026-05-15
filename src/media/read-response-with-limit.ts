async function readChunkWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunkTimeoutMs: number,
  onIdleTimeout?: (params: { chunkTimeoutMs: number }) => Error,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  return await new Promise((resolve, reject) => {
    const clear = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    timeoutId = setTimeout(() => {
      timedOut = true;
      const error =
        onIdleTimeout?.({ chunkTimeoutMs }) ??
        new Error(`Media download stalled: no data received for ${chunkTimeoutMs}ms`);
      clear();
      void reader.cancel(error).catch(() => undefined);
      reject(error);
    }, chunkTimeoutMs);

    void reader.read().then(
      (result) => {
        clear();
        if (!timedOut) {
          resolve(result);
        }
      },
      (err) => {
        clear();
        if (!timedOut) {
          reject(err);
        }
      },
    );
  });
}

type ReadResponsePrefixResult = {
  buffer: Buffer;
  size: number;
  truncated: boolean;
};

async function readResponsePrefix(
  res: Response,
  maxBytes: number,
  opts?: {
    chunkTimeoutMs?: number;
    onIdleTimeout?: (params: { chunkTimeoutMs: number }) => Error;
  },
): Promise<ReadResponsePrefixResult> {
  const chunkTimeoutMs = opts?.chunkTimeoutMs;
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    const fallback = Buffer.from(await res.arrayBuffer());
    if (fallback.length > maxBytes) {
      return {
        buffer: fallback.subarray(0, maxBytes),
        size: fallback.length,
        truncated: true,
      };
    }
    return { buffer: fallback, size: fallback.length, truncated: false };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = chunkTimeoutMs
        ? await readChunkWithIdleTimeout(reader, chunkTimeoutMs, opts?.onIdleTimeout)
        : await reader.read();
      if (done) {
        size = total;
        break;
      }
      if (!value?.length) {
        continue;
      }
      const nextTotal = total + value.length;
      if (nextTotal > maxBytes) {
        const remaining = maxBytes - total;
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
        }
        size = nextTotal;
        truncated = true;
        try {
          await reader.cancel();
        } catch {}
        break;
      }
      chunks.push(value);
      total = nextTotal;
      size = total;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  return {
    buffer: Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      total,
    ),
    size,
    truncated,
  };
}

export async function readResponseWithLimit(
  res: Response,
  maxBytes: number,
  opts?: {
    onOverflow?: (params: { size: number; maxBytes: number; res: Response }) => Error;
    chunkTimeoutMs?: number;
    onIdleTimeout?: (params: { chunkTimeoutMs: number }) => Error;
  },
): Promise<Buffer> {
  const onOverflow =
    opts?.onOverflow ??
    ((params: { size: number; maxBytes: number }) =>
      new Error(`Content too large: ${params.size} bytes (limit: ${params.maxBytes} bytes)`));
  const prefix = await readResponsePrefix(res, maxBytes, {
    chunkTimeoutMs: opts?.chunkTimeoutMs,
    onIdleTimeout: opts?.onIdleTimeout,
  });
  if (prefix.truncated) {
    throw onOverflow({ size: prefix.size, maxBytes, res });
  }
  return prefix.buffer;
}

export async function readResponseTextSnippet(
  res: Response,
  opts?: {
    maxBytes?: number;
    maxChars?: number;
    chunkTimeoutMs?: number;
    onIdleTimeout?: (params: { chunkTimeoutMs: number }) => Error;
  },
): Promise<string | undefined> {
  const maxBytes = opts?.maxBytes ?? 8 * 1024;
  const maxChars = opts?.maxChars ?? 200;
  const prefix = await readResponsePrefix(res, maxBytes, {
    chunkTimeoutMs: opts?.chunkTimeoutMs,
    onIdleTimeout: opts?.onIdleTimeout,
  });
  if (prefix.buffer.length === 0) {
    return undefined;
  }

  const text = new TextDecoder().decode(prefix.buffer);
  if (!text) {
    return undefined;
  }

  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return undefined;
  }
  if (collapsed.length > maxChars) {
    return `${collapsed.slice(0, maxChars)}…`;
  }
  return prefix.truncated ? `${collapsed}…` : collapsed;
}
