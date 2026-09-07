export function resolveGatewayWebSocketUrl(
  wsUrl: string,
  gatewayUrl = globalThis.location?.href,
): string {
  const base = new URL(gatewayUrl ?? globalThis.location.href, globalThis.location?.href);
  if (base.protocol === "http:") {
    base.protocol = "ws:";
  } else if (base.protocol === "https:") {
    base.protocol = "wss:";
  }
  const resolved = new URL(wsUrl, base);
  if (resolved.protocol === "http:") {
    resolved.protocol = "ws:";
  } else if (resolved.protocol === "https:") {
    resolved.protocol = "wss:";
  }
  if (resolved.protocol !== "ws:" && resolved.protocol !== "wss:") {
    throw new Error("Gateway stream URL must use WebSocket transport");
  }
  return resolved.toString();
}
