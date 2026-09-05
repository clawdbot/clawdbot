// Shared-auth websocket test helpers.
// Opens authenticated gateway sockets and reads config snapshots in tests.
import { expect } from "vitest";
import { WebSocket } from "ws";
import { acquireGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { connectOk, rpcReq, trackConnectChallengeNonce } from "./test-helpers.js";

export async function openAuthenticatedGatewayWs(
  port: number,
  token: string,
  timeoutMs = 10_000,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  return await acquireGatewayTestWebSocket(ws, timeoutMs, () => connectOk(ws, { token }));
}

/** Waits for a gateway websocket to close and returns the close details. */
export async function waitForGatewayWsClose(
  ws: WebSocket,
  timeoutMs = 10_000,
): Promise<{ code: number; reason: string }> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("close", onClose);
      reject(
        new Error(`gateway websocket did not close within ${timeoutMs}ms (state=${ws.readyState})`),
      );
    }, timeoutMs);
    timer.unref?.();
    const onClose = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    };
    ws.once("close", onClose);
  });
}

/** Loads the current config through the gateway RPC API for mutation tests. */
export async function loadGatewayConfig(ws: WebSocket): Promise<{
  hash: string;
  config: Record<string, unknown>;
}> {
  const current = await rpcReq<{
    hash?: string;
    config?: Record<string, unknown>;
  }>(ws, "config.get", {});
  expect(current.ok).toBe(true);
  expect(typeof current.payload?.hash).toBe("string");
  return {
    hash: String(current.payload?.hash),
    config: structuredClone(current.payload?.config ?? {}),
  };
}
