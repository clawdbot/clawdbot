export function waitForWebSocketOpen(ws, timeoutMs, message = "gateway ws open timeout") {
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
      fn(value);
    };
    const onOpen = () => settle(resolve);
    const onError = (error) => settle(reject, error);
    const timer = setTimeout(() => {
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
        settle(reject, new Error(message));
      }
    }, timeoutMs);

    timer.unref?.();
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}
