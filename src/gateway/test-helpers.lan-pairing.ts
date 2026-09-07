// Shared LAN self-connect harness for node pairing auto-approval suites.
// Tests bind the gateway to the primary LAN IPv4 and connect from that same
// address so the server observes a direct non-loopback client IP. Skips
// silently on hosts without a usable LAN interface.
import net from "node:net";
import { afterAll, beforeAll, describe } from "vitest";
import { WebSocket } from "ws";
import { getPairedDevice, removePairedDevice } from "../infra/device-pairing.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { loadDeviceIdentity } from "./device-authz.test-helpers.js";
import { pickPrimaryLanIPv4 } from "./net.js";
import { connectReq, startServer, trackConnectChallengeNonce } from "./test-helpers.js";

const LAN_NODE_PAIRING_TOKEN = "secret";

const NODE_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.NODE_HOST,
  version: "1.0.0",
  platform: "ios",
  mode: GATEWAY_CLIENT_MODES.NODE,
};

async function openLanGatewayWs(params: { host: string; port: number }): Promise<WebSocket> {
  const ws = new WebSocket(`ws://${params.host}:${params.port}`, {
    localAddress: params.host,
  });
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for ws open")), 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
  return ws;
}

async function canUseLanSelfConnect(host: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let client: net.Socket | undefined;
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.end("ok");
    });
    const done = (ok: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      client?.destroy();
      server.close(() => resolve(ok));
    };
    const timer = setTimeout(() => done(false), 1_000);
    server.once("error", () => done(false));
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        done(false);
        return;
      }
      let sawData = false;
      client = net.connect({ host, port: address.port, localAddress: host });
      client.on("data", () => {
        sawData = true;
      });
      client.once("error", () => done(false));
      client.once("close", () => done(sawData));
    });
  });
}

type LanNodePairingContext = {
  lanIp: string;
  loaded: ReturnType<typeof loadDeviceIdentity>;
  /** Open a fresh LAN WebSocket, run the node connect handshake, close it. */
  connectNode: () => Promise<Awaited<ReturnType<typeof connectReq>>>;
};

type LanNodePairingAttempt = (params: {
  identityName: string;
  configure?: (lanIp: string) => Promise<void>;
  run: (ctx: LanNodePairingContext) => Promise<void>;
}) => Promise<void>;

// Pairing config is read when each WebSocket handler attaches. Reuse the real
// Gateway while suite-scoped hooks reset mutable runtime state between cases.
export function describeWithLanNodePairingServer(
  name: string,
  defineTests: (attempt: LanNodePairingAttempt) => void,
): void {
  describe(name, () => {
    let lanIp: string | undefined;
    let started: Awaited<ReturnType<typeof startServer>> | undefined;
    const openSockets = new Set<WebSocket>();

    beforeAll(async () => {
      const candidate = pickPrimaryLanIPv4();
      if (!candidate || !(await canUseLanSelfConnect(candidate))) {
        return;
      }
      lanIp = candidate;
      started = await startServer(LAN_NODE_PAIRING_TOKEN, {
        bind: "lan",
        controlUiEnabled: false,
      });
    });

    afterAll(async () => {
      for (const ws of openSockets) {
        ws.terminate();
      }
      await started?.server.close();
      started?.envSnapshot.restore();
    });

    defineTests(async (params) => {
      const activeServer = started;
      const host = lanIp;
      if (!activeServer || !host) {
        return;
      }
      await params.configure?.(host);
      const loaded = loadDeviceIdentity(params.identityName);
      // The suite shares one state home under --isolate=false; drop any paired
      // record for this identity so a sibling suite's row cannot mask a fresh
      // pairing (a stale approvedVia would survive a re-approve by design).
      if (await getPairedDevice(loaded.identity.deviceId)) {
        await removePairedDevice(loaded.identity.deviceId);
      }
      const connectNode = async () => {
        const ws = await openLanGatewayWs({ host, port: activeServer.port });
        openSockets.add(ws);
        try {
          return await connectReq(ws, {
            token: LAN_NODE_PAIRING_TOKEN,
            role: "node",
            scopes: [],
            client: NODE_CLIENT,
            deviceIdentityPath: loaded.identityPath,
          });
        } finally {
          // These tests cover pairing, not the WebSocket close handshake. Terminate so
          // gateway cleanup never waits on a client that has already returned its result.
          openSockets.delete(ws);
          ws.terminate();
        }
      };
      await params.run({ lanIp: host, loaded, connectNode });
    });
  });
}
