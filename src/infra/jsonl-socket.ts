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

class JsonlSocketConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonlSocketConnectionError";
  }
}

class JsonlSocketTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonlSocketTimeoutError";
  }
}

async function requestJsonlSocketWithMaxLineBytes<T>(
  params: JsonlSocketRequest<T>,
  maxLineBytes: number,
): Promise<T> {
  const { socketPath, requestLine, accept } = params;
  const timeoutMs = resolveJsonlSocketTimeoutMs(params.timeoutMs);
  return await new Promise((resolve, reject) => {
    const client = new net.Socket();
    let settled = false;
    // Keep raw bytes until a line is complete so chunk boundaries cannot split
    // a UTF-8 code point before JSON parsing.
    let lineChunks: Buffer[] = [];
    let lineBytes = 0;

    const finish = (value: T) => {
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

    const finishError = (error: Error) => {
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
      reject(error);
    };

    const appendLineChunk = (chunk: Buffer): boolean => {
      if (lineBytes + chunk.byteLength > maxLineBytes) {
        finishError(new JsonlSocketConnectionError(`peer line exceeded ${maxLineBytes} bytes`));
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

    const timer = setNodeTimeout(
      () => finishError(new JsonlSocketTimeoutError(`jsonl socket timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    client.on("error", (err) =>
      finishError(new JsonlSocketConnectionError(`jsonl socket error: ${err.message}`)),
    );
    client.on("close", () =>
      finishError(new JsonlSocketConnectionError("jsonl socket closed by peer")),
    );
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

export { JsonlSocketConnectionError, JsonlSocketTimeoutError };

export async function requestJsonlSocket<T>(params: JsonlSocketRequest<T>): Promise<T> {
  return await requestJsonlSocketWithMaxLineBytes(params, JSONL_SOCKET_MAX_LINE_BYTES);
}
