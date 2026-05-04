import { expect } from "vitest";
import { WebSocket } from "ws";
import { connectOk, rpcReq, trackConnectChallengeNonce } from "./test-helpers.js";

export async function openAuthenticatedGatewayWs(
  port: number,
  token: string,
  timeoutMs = 10_000,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`gateway websocket closed before open (${code}: ${reason.toString()})`));
    };
    const timer = setTimeout(() => {
      cleanup();
      ws.close();
      reject(new Error(`gateway websocket did not open within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
  await connectOk(ws, { token });
  return ws;
}

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
