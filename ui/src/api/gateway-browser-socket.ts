import {
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  type GatewayProtocolSocket,
  type GatewayProtocolSocketHandlers,
} from "@openclaw/gateway-client/browser";

export const DEFAULT_GATEWAY_MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_GATEWAY_PREAUTH_MAX_PAYLOAD_BYTES = 64 * 1024;

export function validateGatewayRequestFrame(
  frame: string,
  method: string,
  maxPayloadBytes: number,
): void {
  const frameBytes = new TextEncoder().encode(frame).byteLength;
  const isConnect = method === "connect";
  const limit = isConnect ? DEFAULT_GATEWAY_PREAUTH_MAX_PAYLOAD_BYTES : maxPayloadBytes;
  if (frameBytes > limit) {
    throw new RangeError(
      `gateway request ${method} exceeds ${isConnect ? "pre-auth" : "negotiated"} max payload ` +
        `(${frameBytes} > ${limit} bytes)`,
    );
  }
}

export function resolveGatewayMaxPayloadBytes(
  policy: { maxPayload?: unknown } | null | undefined,
): number {
  return typeof policy?.maxPayload === "number" &&
    Number.isFinite(policy.maxPayload) &&
    policy.maxPayload > 0
    ? policy.maxPayload
    : DEFAULT_GATEWAY_MAX_PAYLOAD_BYTES;
}

export function createBrowserGatewaySocket(
  url: string,
  handlers: GatewayProtocolSocketHandlers,
): GatewayProtocolSocket {
  const socket = new WebSocket(url);
  let opening = true;
  let openingTimeoutReason: string | undefined;
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
    // Browsers erase locally initiated close reasons before the handshake finishes.
    handlers.close(event.code, event.reason || openingTimeoutReason || "");
  });
  socket.addEventListener("error", () => {
    finishOpening();
    if (!openingTimeoutReason) {
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
    openingTimeoutReason = `gateway websocket opening timed out after ${DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS}ms`;
    try {
      handlers.error(new Error(openingTimeoutReason));
    } finally {
      socket.close();
    }
  }, DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: (data) => socket.send(data),
    close: (code, reason) => {
      finishOpening();
      // Browser-initiated closes reject the shared protocol's 1008 policy code.
      socket.close(code === 1008 ? 4008 : code, reason);
    },
  };
}
