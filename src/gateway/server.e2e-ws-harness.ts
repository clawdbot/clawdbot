// Gateway websocket E2E harness.
// Starts an unauthenticated loopback gateway and opens connected test clients.
import { WebSocket } from "ws";
import { captureEnv } from "../test-utils/env.js";
import {
  connectOk,
  getFreePort,
  startGatewayServer,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

type GatewayWsClient = {
  ws: WebSocket;
  hello: unknown;
};

export type GatewayServerHarness = {
  port: number;
  server: Awaited<ReturnType<typeof startGatewayServer>>;
  openClient: (opts?: Parameters<typeof connectOk>[1]) => Promise<GatewayWsClient>;
  close: () => Promise<void>;
};

/** Start a loopback Gateway server with a helper for opening authenticated test clients. */
export async function startGatewayServerHarness(): Promise<GatewayServerHarness> {
  const envSnapshot = captureEnv(["OPENCLAW_GATEWAY_TOKEN"]);
  const clients = new Set<WebSocket>();
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  const port = await getFreePort();
  const server = await startGatewayServer(port, {
    auth: { mode: "none" },
    bind: "loopback",
    controlUiEnabled: false,
  });

  const openClient = async (opts?: Parameters<typeof connectOk>[1]): Promise<GatewayWsClient> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    clients.add(ws);
    ws.once("close", () => clients.delete(ws));
    trackConnectChallengeNonce(ws);
    try {
      await new Promise<void>((resolve) => {
        ws.once("open", resolve);
      });
      const hello = await connectOk(ws, opts);
      return { ws, hello };
    } catch (error) {
      ws.terminate();
      throw error;
    }
  };

  const close = async () => {
    const forceCloseTimer = setTimeout(() => {
      // Tests often call ws.close() without waiting for the closing handshake.
      // Force any stragglers down so suite teardown cannot block indefinitely.
      for (const ws of clients) {
        ws.terminate();
      }
    }, 5_000);
    forceCloseTimer.unref?.();
    try {
      await server.close();
    } finally {
      clearTimeout(forceCloseTimer);
      envSnapshot.restore();
    }
  };

  return { port, server, openClient, close };
}
