// WebSocket frame helpers for gateway network E2E fixtures.
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

export function onceFrame(ws, filter, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      ws.off?.("message", onMessage);
      ws.off?.("error", onError);
      ws.off?.("close", onClose);
    };
    const settle = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn(value);
    };
    const onMessage = (data) => {
      let obj;
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
    const onError = (error) =>
      settle(reject, error instanceof Error ? error : new Error(String(error)));
    const onClose = (code, reason) => {
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
