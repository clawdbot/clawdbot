type WebSocketOpenHandle = {
  close?: () => void;
  off?: (event: "open" | "error" | "close", listener: (...args: unknown[]) => void) => void;
  on?: (event: "error", listener: (...args: unknown[]) => void) => void;
  once: (event: "open" | "error" | "close", listener: (...args: unknown[]) => void) => void;
  terminate?: () => void;
};

export function waitForWebSocketOpen(
  ws: WebSocketOpenHandle,
  timeoutMs: number,
  message = "gateway ws open timeout",
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timer);
      ws.off?.("open", onOpen);
      ws.off?.("error", onError);
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
    timer = setTimeout(() => {
      const consumeAbortError = () => {};
      const removeAbortErrorConsumer = () => {
        ws.off?.("error", consumeAbortError);
        ws.off?.("close", removeAbortErrorConsumer);
      };
      try {
        ws.off?.("error", onError);
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
  });
}
