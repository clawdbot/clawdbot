/**
 * Raw-socket HTTP request driver for webhook tests.
 *
 * `fetch` cannot express a server that answers while the sender is still uploading and
 * then closes: undici surfaces the failed upload and discards the response it already
 * received. Body-limit rejections are exactly that shape, so asserting them needs a
 * client that reports the status line and the connection outcome independently.
 */
import net from "node:net";

export type RawHttpResult = {
  /** First line of the response, or an empty string when the server sent nothing. */
  statusLine: string;
  /** Response body after the header block. */
  body: string;
  /** True when the server closed the connection rather than leaving it open. */
  closedByServer: boolean;
};

/**
 * Reassembles a chunked response body so callers can assert the payload the server sent.
 *
 * Chunk sizes count bytes, so the scan stays on the Buffer: decoding first would make a
 * multi-byte character consume one slice position and misplace every later boundary.
 */
function decodeChunkedBody(raw: Buffer): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = raw.indexOf("\r\n", offset, "latin1");
    if (lineEnd === -1) {
      break;
    }
    const size = Number.parseInt(raw.toString("latin1", offset, lineEnd).trim(), 16);
    if (!Number.isFinite(size) || size <= 0) {
      break;
    }
    parts.push(raw.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

export async function postRawWebhook(params: {
  /** Absolute URL of the webhook endpoint. */
  url: string;
  /** Request body. */
  body: string;
  headers?: Record<string, string>;
  /** How long to keep the socket open before reporting it as retained. */
  idleTimeoutMs?: number;
  /**
   * Send the body incrementally instead of in one write, so the server decides while the
   * upload is still active rather than from the declared length alone.
   */
  chunk?: { bytes: number; intervalMs: number };
  /** Content-Length to declare; defaults to the body's real length. */
  contentLength?: number;
  /**
   * Send with chunked transfer encoding and no Content-Length, so a size limit can only be
   * detected from the bytes that actually arrive rather than from a declared length.
   */
  chunkedEncoding?: boolean;
}): Promise<RawHttpResult> {
  const target = new URL(params.url);
  const port = Number(target.port);
  const payload = Buffer.from(params.body, "utf-8");
  const idleTimeoutMs = params.idleTimeoutMs ?? 2_000;
  const headerLines = Object.entries(params.headers ?? {})
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  const head =
    `POST ${target.pathname}${target.search} HTTP/1.1\r\n` +
    `Host: ${target.hostname}:${port}\r\n` +
    headerLines +
    (params.chunkedEncoding
      ? `Transfer-Encoding: chunked\r\n\r\n`
      : `Content-Length: ${params.contentLength ?? payload.length}\r\n\r\n`);

  return await new Promise<RawHttpResult>((resolve) => {
    const socket = net.connect(port, target.hostname);
    const received: Buffer[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (closedByServer: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      socket.destroy();
      const raw = Buffer.concat(received);
      const headerEnd = raw.indexOf("\r\n\r\n", 0, "latin1");
      const headBlock =
        headerEnd === -1 ? raw.toString("latin1") : raw.toString("latin1", 0, headerEnd);
      const rawBody = headerEnd === -1 ? Buffer.alloc(0) : raw.subarray(headerEnd + 4);
      const chunked = /transfer-encoding:\s*chunked/i.test(headBlock);
      resolve({
        statusLine: (headBlock.split("\r\n")[0] ?? "").trim(),
        body: (chunked ? decodeChunkedBody(rawBody) : rawBody).toString("utf-8"),
        closedByServer,
      });
    };

    // Chunk framing is ASCII and the body is raw bytes. Writing them together through a
    // string would re-encode every byte above 0x7f after its length was already declared.
    const writeBody = (slice: Buffer) => {
      if (!params.chunkedEncoding) {
        socket.write(slice);
        return;
      }
      socket.write(`${slice.length.toString(16)}\r\n`);
      socket.write(slice);
      socket.write("\r\n");
    };

    socket.on("connect", () => {
      socket.write(head);
      if (!params.chunk) {
        writeBody(payload);
        if (params.chunkedEncoding) {
          socket.write("0\r\n\r\n");
        }
      } else {
        const { bytes, intervalMs } = params.chunk;
        let offset = 0;
        const pump = () => {
          if (settled || socket.destroyed) {
            return;
          }
          if (offset >= payload.length) {
            if (params.chunkedEncoding) {
              socket.write(`0\r\n\r\n`);
            }
            return;
          }
          const end = Math.min(offset + bytes, payload.length);
          writeBody(payload.subarray(offset, end));
          offset = end;
          setTimeout(pump, intervalMs).unref?.();
        };
        pump();
      }
      // Only the idle timeout reports a retained connection; a server that answers and
      // closes always reaches "close" below.
      timer = setTimeout(() => settle(false), idleTimeoutMs);
      timer.unref?.();
    });
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk);
    });
    // Rejecting mid-upload makes the write fail on this side; the response may already be
    // buffered, so wait for "close" rather than settling on the write error.
    socket.on("error", () => {});
    socket.on("close", () => settle(true));
  });
}
