import net from "node:net";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";

/**
 * Sends one JSONL request line, half-closes the write side, and waits for an accepted response line.
 */
export async function requestJsonlSocket<T>(params: {
  socketPath: string;
  requestLine: string;
  timeoutMs: number;
  accept: (msg: unknown) => T | null | undefined;
}): Promise<T | null> {
  const { socketPath, requestLine, timeoutMs, accept } = params;
  return await new Promise((resolve) => {
    const client = new net.Socket();
    let settled = false;
    let buffer = "";

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

    const timer = setNodeTimeout(() => finish(null), timeoutMs);

    client.on("error", () => finish(null));
    client.on("end", () => finish(null));
    client.on("close", () => finish(null));
    client.connect(socketPath, () => {
      client.end(`${requestLine}\n`);
    });
    client.on("data", (data) => {
      buffer += data.toString("utf8");
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
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
