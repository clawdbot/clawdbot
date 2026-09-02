// Sends one-shot JSONL requests over Unix domain sockets.
import { addAbortListener } from "node:events";
import net from "node:net";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { err, ok, type Result } from "@openclaw/normalization-core/result";

const JSONL_SOCKET_MAX_LINE_BYTES = 16 * 1024 * 1024;
export type JsonlSocketFailure = "not-submitted" | "outcome-unknown" | "cancelled";

type JsonlSocketRequest<T> = {
  socketPath: string;
  requestLine: string;
  timeoutMs: number;
  signal?: AbortSignal;
  accept: (msg: unknown) => T | null | undefined;
};

/**
 * Sends one JSONL request line, half-closes the write side, and waits for an accepted response line.
 */
export async function requestJsonlSocket<T>(
  params: JsonlSocketRequest<T>,
): Promise<Result<T, JsonlSocketFailure>> {
  const { socketPath, requestLine, accept, signal } = params;
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  return await new Promise((resolve) => {
    const client = new net.Socket();
    let settled = false;
    let submitted = false;
    // Keep raw bytes until a line is complete so chunk boundaries cannot split
    // a UTF-8 code point before JSON parsing.
    let lineChunks: Buffer[] = [];
    let lineBytes = 0;

    const finish = (result: Result<T, JsonlSocketFailure>) => {
      if (settled) {
        return;
      }
      settled = true;
      clearNodeTimeout(timer);
      abortListener?.[Symbol.dispose]();
      client.destroy();
      resolve(result);
    };
    const fail = () => finish(err(submitted ? "outcome-unknown" : "not-submitted"));

    const appendLineChunk = (chunk: Buffer): boolean => {
      if (lineBytes + chunk.byteLength > JSONL_SOCKET_MAX_LINE_BYTES) {
        fail();
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

    const timer = setNodeTimeout(fail, timeoutMs);
    const abortListener = signal
      ? addAbortListener(signal, () => finish(err("cancelled")))
      : undefined;
    // Preparation may have yielded before reaching the transport. Never connect
    // or send for an invocation that has already lost its lifetime.
    if (signal?.aborted) {
      finish(err("cancelled"));
      return;
    }

    client.on("error", fail);
    client.on("end", fail);
    client.on("close", fail);
    client.connect(socketPath, () => {
      if (!settled) {
        // A failed write or missing reply cannot prove nonexecution once bytes
        // enter the transport. Record the boundary before attempting the write.
        submitted = true;
        client.end(`${requestLine}\n`);
      }
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
          finish(result === null ? err("outcome-unknown") : ok(result));
          return;
        } catch {
          // ignore
        }
      }
    });
  });
}
