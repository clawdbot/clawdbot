// Minimal Gateway websocket test helpers.
// Provides small fake-server frames for client/backend tests.
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

/** Parses a raw WebSocket frame into the small request shape used by tests. */
export function parseMinimalGatewayRequestFrame(
  data: WebSocket.RawData,
): MinimalGatewayRequestFrame {
  return JSON.parse(rawDataToString(data)) as MinimalGatewayRequestFrame;
}

/** Sends the connect challenge event expected by minimal gateway clients. */
export function sendMinimalGatewayConnectChallenge(ws: WebSocket, nonce = "test-nonce"): void {
  ws.send(
    JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce },
    }),
  );
}

/** Builds a minimal hello-ok payload for fake gateway servers. */
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

/** Sends a successful response frame from a fake gateway server. */
export function sendMinimalGatewayResponse(ws: WebSocket, id: string, payload: unknown): void {
  ws.send(JSON.stringify({ type: "res", id, ok: true, payload }));
}

/** Terminates all clients and closes a fake WebSocket gateway server. */
export async function closeMinimalGatewayServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve, reject) => {
    wss.close((error) => (error ? reject(error) : resolve()));
  });
}
