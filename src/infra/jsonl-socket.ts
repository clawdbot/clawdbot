// Sends one-shot JSONL requests over Unix domain sockets.
import net from "node:net";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";

const JSONL_SOCKET_MAX_LINE_BYTES = 16 * 1024 * 1024;

type JsonlSocketRequest<T> = {
  socketPath: string;
  requestLine: string;
  timeoutMs: number;
  accept: (msg: unknown) => T | null | undefined;
};

/**
 * Sends one JSONL request line, half-closes the write side, and waits for an accepted response line.
 */
function resolveJsonlSocketTimeoutMs(timeoutMs: number): number {
  return resolveTimerTimeoutMs(timeoutMs, 1);
}

async function requestJsonlSocketWithMaxLineBytes<T>(
  params: JsonlSocketRequest<T>,
  maxLineBytes: number,
): Promise<T | null> {
  const { socketPath, requestLine, accept } = params;
  const timeoutMs = resolveJsonlSocketTimeoutMs(params.timeoutMs);
  return await new Promise((resolve) => {
    const client = new net.Socket();
    let settled = false;
    // Keep raw bytes until a line is complete so chunk boundaries cannot split
    // a UTF-8 code point before JSON parsing.
    let lineChunks: Buffer[] = [];
    let lineBytes = 0;

    const finish = (value: T | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearNodeTimeout(timer);
      try {
        client.destroy();
      } catch {
        // ignore
      }
      resolve(value);
    };

    const appendLineChunk = (chunk: Buffer): boolean => {
      if (lineBytes + chunk.byteLength > maxLineBytes) {
        finish(null);
        return false;
      }
      if (chunk.byteLength > 0) {
        lineChunks.push(chunk);
        lineBytes += chunk.byteLength;
      }
      return true;
    };

    const takeLine = (): string => {
      const line = Buffer.concat(lineChunks, lineBytes).toString("utf8").trim();
      lineChunks = [];
      lineBytes = 0;
      return line;
    };

    const timer = setNodeTimeout(() => finish(null), timeoutMs);

    client.on("error", () => finish(null));
    client.on("end", () => finish(null));
    client.on("close", () => finish(null));
    client.connect(socketPath, () => {
      client.end(`${requestLine}\n`);
    });
    client.on("data", (data: Buffer) => {
      let offset = 0;
      while (offset < data.byteLength) {
        const newlineIndex = data.indexOf(0x0a, offset);
        if (newlineIndex === -1) {
          appendLineChunk(data.subarray(offset));
          return;
        }
        // Bound bytes before concatenating or parsing; both complete and unterminated
        // peer-controlled lines must stay below the same allocation ceiling.
        if (!appendLineChunk(data.subarray(offset, newlineIndex))) {
          return;
        }
        const line = takeLine();
        offset = newlineIndex + 1;
        if (!line) {
          continue;
        }
        try {
          const msg = JSON.parse(line) as unknown;
          const result = accept(msg);
          if (result === undefined) {
            continue;
          }
          finish(result);
          return;
        } catch {
          // ignore
        }
      }
    });
  });
}

export async function requestJsonlSocket<T>(params: JsonlSocketRequest<T>): Promise<T | null> {
  return await requestJsonlSocketWithMaxLineBytes(params, JSONL_SOCKET_MAX_LINE_BYTES);
}

export const testApi = {
  JSONL_SOCKET_MAX_LINE_BYTES,
  requestJsonlSocketWithMaxLineBytes,
  resolveJsonlSocketTimeoutMs,
};
