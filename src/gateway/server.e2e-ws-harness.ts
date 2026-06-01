import { WebSocket } from "ws";
import { captureEnv } from "../test-utils/env.js";
import {
  connectOk,
  getFreePort,
  startGatewayServer,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

export type GatewayWsClient = {
  ws: WebSocket;
  hello: unknown;
};

export type GatewayServerHarness = {
  port: number;
  server: Awaited<ReturnType<typeof startGatewayServer>>;
  openClient: (opts?: Parameters<typeof connectOk>[1]) => Promise<GatewayWsClient>;
  close: () => Promise<void>;
};

export async function startGatewayServerHarness(): Promise<GatewayServerHarness> {
  const envSnapshot = captureEnv(["OPENCLAW_GATEWAY_TOKEN"]);
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  const port = await getFreePort();
  const server = await startGatewayServer(port, {
    auth: { mode: "none" },
    bind: "loopback",
    controlUiEnabled: false,
  });

  const openClient = async (opts?: Parameters<typeof connectOk>[1]): Promise<GatewayWsClient> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    trackConnectChallengeNonce(ws);
    await new Promise<void>((resolve) => {
      ws.once("open", resolve);
    });
    const hello = await connectOk(ws, opts);
    return { ws, hello };
  };

  const close = async () => {
    await server.close();
    envSnapshot.restore();
  };

  return { port, server, openClient, close };
}
