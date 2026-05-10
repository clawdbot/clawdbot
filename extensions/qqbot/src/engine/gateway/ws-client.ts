import type { Agent } from "node:http";
import { resolveAmbientNodeProxyAgent } from "openclaw/plugin-sdk/extension-shared";
import WebSocket from "ws";

export interface QQWSClientOptions {
  gatewayUrl: string;
  userAgent: string;
}

export async function createQQWSClient(options: QQWSClientOptions): Promise<WebSocket> {
  const wsAgent = await resolveAmbientNodeProxyAgent<Agent>();
  return new WebSocket(options.gatewayUrl, {
    headers: { "User-Agent": options.userAgent },
    ...(wsAgent ? { agent: wsAgent } : {}),
  });
}
