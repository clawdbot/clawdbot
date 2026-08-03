// WebSocket open/close wait helper for E2E clients.
function formatCloseValue(value) {
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

export function waitForWebSocketOpen(ws, timeoutMs, message = "ws open timeout") {
  return new Promise((resolve, reject) => {
    let settled = false;

    const settle = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      ws.off?.("open", onOpen);
      ws.off?.("error", onError);
      ws.off?.("close", onClose);
      fn(value);
    };
    const onOpen = () => settle(resolve);
    const onError = (error) =>
      settle(reject, error instanceof Error ? error : new Error(String(error)));
    const onClose = (code, reason) => {
      const closeDetails = [formatCloseValue(code), formatCloseValue(reason)]
        .filter(Boolean)
        .join(" ");
      const suffix = closeDetails ? `: ${closeDetails}` : "";
      settle(reject, new Error(`closed before open${suffix}`));
    };
    const timer = setTimeout(() => {
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
        settle(reject, new Error(message));
      }
    }, timeoutMs);

    timer.unref?.();
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}
