import type {
  GatewayProtocolSocket,
  GatewayProtocolSocketHandlers,
} from "@openclaw/gateway-client/browser";

export function createBrowserGatewaySocket(
  url: string,
  handlers: GatewayProtocolSocketHandlers,
): GatewayProtocolSocket {
  const socket = new WebSocket(url);
  socket.addEventListener("open", handlers.open);
  socket.addEventListener("message", (event) => handlers.message(String(event.data ?? "")));
  socket.addEventListener("close", (event) => handlers.close(event.code, event.reason ?? ""));
  socket.addEventListener("error", () => handlers.error(new Error("websocket error")));
  return {
    isOpen: () => socket.readyState === WebSocket.OPEN,
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
  };
}
