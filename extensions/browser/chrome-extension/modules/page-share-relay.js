const PAGE_SHARE_TIMEOUT_MS = 10_000;
const PAGE_SHARE_DISCONNECTED_ERROR =
  "Browser relay disconnected before OpenClaw acknowledged the page share.";

export function createPageShareRelay() {
  let nextRequestId = 1;
  /** @type {Map<number, {socket: WebSocket, resolve: (value: void) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout>}>} */
  const pending = new Map();

  function rejectSocket(socket) {
    // Socket ownership prevents a late close from rejecting a request that
    // belongs to a relay connection that has already replaced it.
    for (const [requestId, request] of pending) {
      if (request.socket !== socket) {
        continue;
      }
      pending.delete(requestId);
      clearTimeout(request.timer);
      request.reject(new Error(PAGE_SHARE_DISCONNECTED_ERROR));
    }
  }

  function settle(socket, result) {
    const request = pending.get(result.requestId);
    if (!request || request.socket !== socket) {
      return;
    }
    pending.delete(result.requestId);
    clearTimeout(request.timer);
    if (result.ok) {
      request.resolve();
    } else {
      request.reject(new Error(result.error || "Page share failed."));
    }
  }

  function send(socket, payload) {
    const requestId = nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Timed out waiting for OpenClaw."));
      }, PAGE_SHARE_TIMEOUT_MS);
      pending.set(requestId, { socket, resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ type: "pageShare", requestId, payload }));
      } catch (error) {
        pending.delete(requestId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  return { rejectSocket, send, settle };
}
