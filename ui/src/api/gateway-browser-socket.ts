import {
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  type GatewayProtocolSocket,
  type GatewayProtocolSocketHandlers,
} from "@openclaw/gateway-client/browser";

export function createBrowserGatewaySocket(
  url: string,
  handlers: GatewayProtocolSocketHandlers,
): GatewayProtocolSocket {
  const socket = new WebSocket(url);
  let opening = true;
  let openingTimedOut = false;
  let openingTimer: ReturnType<typeof setTimeout> | undefined;
  const finishOpening = () => {
    opening = false;
    if (openingTimer !== undefined) {
      clearTimeout(openingTimer);
      openingTimer = undefined;
    }
  };

  socket.addEventListener("open", () => {
    finishOpening();
    handlers.open();
  });
  socket.addEventListener("message", (event) => handlers.message(String(event.data ?? "")));
  socket.addEventListener("close", (event) => {
    finishOpening();
    handlers.close(event.code, event.reason ?? "");
  });
  socket.addEventListener("error", () => {
    finishOpening();
    if (!openingTimedOut) {
      handlers.error(new Error("websocket error"));
    }
  });

  // The protocol challenge timer starts after `open`. Bound the browser's
  // opening phase to the same default preauth budget used by the Node client.
  openingTimer = setTimeout(() => {
    openingTimer = undefined;
    if (!opening) {
      return;
    }
    opening = false;
    openingTimedOut = true;
    try {
      handlers.error(
        new Error(
          `gateway websocket opening timed out after ${DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS}ms`,
        ),
      );
    } finally {
      socket.close();
    }
  }, DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: (data) => socket.send(data),
    close: (code, reason) => {
      finishOpening();
      socket.close(code, reason);
    },
  };
}
