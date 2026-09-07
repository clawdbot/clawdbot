/** Map the HTTP aliases accepted by WebSocket clients onto their canonical schemes. */
export function normalizeWebSocketProtocol(protocol: string): string {
  return protocol === "https:" ? "wss:" : protocol === "http:" ? "ws:" : protocol;
}
