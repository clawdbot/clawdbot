import { expect } from "vitest";
import { WebSocket } from "ws";
import { connectOk, rpcReq, trackConnectChallengeNonce } from "./test-helpers.js";

export async function openAuthenticatedGatewayWs(port: number, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  await connectOk(ws, { token });
  return ws;
}

export async function waitForGatewayWsClose(
  ws: WebSocket,
): Promise<{ code: number; reason: string }> {
  return await new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

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
