import type WebSocket from "ws";
import type { WebSocketServer } from "ws";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import { rawDataToString } from "../infra/ws.js";

export type MinimalGatewayRequestFrame = {
  type?: string;
  id?: string;
  method?: string;
  params?: Record<string, unknown> & {
    auth?: { token?: string };
    device?: { nonce?: string };
  };
};

export function parseMinimalGatewayRequestFrame(
  data: WebSocket.RawData,
): MinimalGatewayRequestFrame {
  return JSON.parse(rawDataToString(data)) as MinimalGatewayRequestFrame;
}

export function sendMinimalGatewayConnectChallenge(ws: WebSocket, nonce = "test-nonce"): void {
  ws.send(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce },
    }),
  );
}

export function buildMinimalGatewayHelloOkPayload(params?: {
  connId?: string;
  methods?: string[];
  snapshot?: Record<string, unknown>;
  auth?: { role: string; scopes: string[] };
  policy?: {
    maxPayload: number;
    maxBufferedBytes: number;
    tickIntervalMs: number;
  };
}) {
  return {
    type: "hello-ok",
    protocol: PROTOCOL_VERSION,
    server: { version: "test", connId: params?.connId ?? "conn-test" },
    features: { methods: params?.methods ?? [], events: ["connect.challenge"] },
    snapshot: params?.snapshot ?? {},
    ...(params?.auth ? { auth: params.auth } : {}),
    policy: params?.policy ?? {
      maxPayload: 1_000_000,
      maxBufferedBytes: 1_000_000,
      tickIntervalMs: 60_000,
    },
  };
}

export function sendMinimalGatewayResponse(ws: WebSocket, id: string, payload: unknown): void {
  ws.send(JSON.stringify({ type: "res", id, ok: true, payload }));
}

export async function closeMinimalGatewayServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve, reject) => {
    wss.close((error) => (error ? reject(error) : resolve()));
  });
}
