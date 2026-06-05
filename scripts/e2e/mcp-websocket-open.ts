// Mcp Websocket Open script supports OpenClaw repository automation.
type WebSocketOpenHandle = {
  close?: () => void;
  off?: (event: "open" | "error" | "close", listener: (...args: unknown[]) => void) => void;
  on?: (event: "error", listener: (...args: unknown[]) => void) => void;
  once: (event: "open" | "error" | "close", listener: (...args: unknown[]) => void) => void;
  terminate?: () => void;
};

function formatCloseValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString();
  }
  return JSON.stringify(value) ?? "";
}

export function waitForWebSocketOpen(
  ws: WebSocketOpenHandle,
  timeoutMs: number,
  message = "gateway ws open timeout",
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      ws.off?.("open", onOpen);
      ws.off?.("error", onError);
      ws.off?.("close", onClose);
    };
    const resolveOpen = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const rejectOpen = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onOpen = () => resolveOpen();
    const onError = (error: unknown) => rejectOpen(error);
    const onClose = (code?: unknown, reason?: unknown) => {
      const closeDetails = [formatCloseValue(code), formatCloseValue(reason)]
        .filter(Boolean)
        .join(" ");
      const suffix = closeDetails ? `: ${closeDetails}` : "";
      rejectOpen(new Error(`closed before open${suffix}`));
    };
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      const consumeAbortError = () => {};
      const removeAbortErrorConsumer = () => {
        ws.off?.("error", consumeAbortError);
        ws.off?.("close", removeAbortErrorConsumer);
      };
      try {
        ws.off?.("error", onError);
        ws.off?.("close", onClose);
        ws.on?.("error", consumeAbortError);
        ws.once?.("close", removeAbortErrorConsumer);
        ws.terminate?.();
        if (typeof ws.terminate !== "function") {
          ws.close?.();
        }
      } finally {
        rejectOpen(new Error(message));
      }
    }, timeoutMs);

    timer.unref?.();
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}
