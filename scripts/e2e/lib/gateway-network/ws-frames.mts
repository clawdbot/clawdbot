// WebSocket frame helpers for gateway network E2E fixtures.
import { formatCloseValue } from "../websocket-open.mjs";

type FrameSocket = {
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  on: (event: "message", listener: (data: unknown) => void) => unknown;
  once: {
    (event: "error", listener: (error: unknown) => void): unknown;
    (event: "close", listener: (code: unknown, reason: unknown) => void): unknown;
  };
};

function isFrameSocket(value: unknown): value is FrameSocket {
  return (
    typeof value === "object" &&
    value !== null &&
    "on" in value &&
    typeof value.on === "function" &&
    "once" in value &&
    typeof value.once === "function"
  );
}

export function onceFrame(
  ws: unknown,
  filter: (message: Record<string, unknown>) => boolean,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  if (!isFrameSocket(ws)) {
    return Promise.reject(new Error("websocket frame source does not expose event handlers"));
  }
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      ws.off?.("message", onMessage);
      ws.off?.("error", onError);
      ws.off?.("close", onClose);
    };
    const settle = <Value,>(fn: (value: Value) => void, value: Value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn(value);
    };
    const onMessage = (data: unknown) => {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(String(data));
        if (!filter(obj)) {
          return;
        }
      } catch (error) {
        settle(reject, error instanceof Error ? error : new Error(String(error)));
        return;
      }
      settle(resolve, obj);
    };
    const onError = (error: unknown) =>
      settle(reject, error instanceof Error ? error : new Error(String(error)));
    const onClose = (code: unknown, reason: unknown) => {
      const closeDetails = [formatCloseValue(code), formatCloseValue(reason)]
        .filter(Boolean)
        .join(" ");
      const suffix = closeDetails ? `: ${closeDetails}` : "";
      settle(reject, new Error(`closed before frame${suffix}`));
    };
    const timer = setTimeout(() => {
      settle(reject, new Error("timeout"));
    }, timeoutMs);
    timer.unref?.();

    ws.on("message", onMessage);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}
