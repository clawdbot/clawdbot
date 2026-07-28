// Qqbot plugin module implements ws client behavior.
import type { Agent } from "node:http";
import { resolveAmbientNodeProxyAgent } from "openclaw/plugin-sdk/extension-shared";
import WebSocket from "ws";

// `ws` otherwise waits indefinitely for an HTTP upgrade. Keep the 30s channel
// precedent (Discord, Slack, Signal) so a half-open upgrade eventually closes,
// releases GatewayConnection.isConnecting, and allows reconnects.
const QQBOT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 30_000;

interface QQWSClientOptions {
  gatewayUrl: string;
  userAgent: string;
}

export async function createQQWSClient(options: QQWSClientOptions): Promise<WebSocket> {
  const wsAgent = await resolveAmbientNodeProxyAgent<Agent>();
  return new WebSocket(options.gatewayUrl, {
    headers: { "User-Agent": options.userAgent },
    handshakeTimeout: QQBOT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
    ...(wsAgent ? { agent: wsAgent } : {}),
  });
}
