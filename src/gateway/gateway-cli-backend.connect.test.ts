// Gateway CLI backend connect tests exercise the minimal WebSocket handshake,
// device identity payload, auth token forwarding, and backend request framing.
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { connectTestGatewayClient } from "./gateway-cli-backend.live-helpers.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "./minimal-gateway.test-helpers.js";

const GATEWAY_CONNECT_OPERATION_TIMEOUT_MS = 1_000;
const GATEWAY_CONNECT_TEST_TIMEOUT_MS = 15_000;
const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-gateway-connect-" });

async function createTempDeviceIdentity() {
  const tempRoot = await tempDirs.make("device");
  return loadOrCreateDeviceIdentity(path.join(tempRoot, "device.json"));
}

async function startMinimalGatewayServer(params: { token: string }) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const requests: string[] = [];
  let connectParams: Record<string, unknown> | undefined;

  wss.on("connection", (ws) => {
    sendMinimalGatewayConnectChallenge(ws);
    ws.on("message", (data) => {
      const frame = parseMinimalGatewayRequestFrame(data);
      if (frame.type !== "req" || !frame.id) {
        return;
      }
      requests.push(frame.method ?? "");
      if (frame.method === "connect") {
        connectParams = frame.params as Record<string, unknown> | undefined;
        expect(frame.params?.auth?.token).toBe(params.token);
        expect(frame.params?.device?.nonce).toBe("test-nonce");
        sendMinimalGatewayResponse(
          ws,
          frame.id,
          buildMinimalGatewayHelloOkPayload({
            connId: "conn-1",
            methods: ["health"],
            snapshot: {
              presence: [],
              health: { ok: true },
              stateVersion: { presence: 0, health: 0 },
              uptimeMs: 0,
            },
            policy: {
              maxPayload: 1,
              maxBufferedBytes: 1,
              tickIntervalMs: 60_000,
            },
          }),
        );
        return;
      }
      if (frame.method === "health") {
        sendMinimalGatewayResponse(ws, frame.id, { ok: true });
      }
    });
  });

  await new Promise<void>((resolve) => {
    wss.once("listening", resolve);
  });
  const address = wss.address() as AddressInfo;
  return {
    requests,
    get connectParams() {
      return connectParams;
    },
    url: `ws://127.0.0.1:${address.port}`,
    close: async () => {
      await closeMinimalGatewayServer(wss);
    },
  };
}

describe("gateway cli backend connect", () => {
  beforeAll(async () => {
    await tempDirs.setup();
  });

  afterAll(async () => {
    await tempDirs.cleanup();
  });

  it(
    "connects a test gateway client through the live helper",
    async () => {
      const token = `test-${Date.now()}`;
      const deviceIdentity = await createTempDeviceIdentity();
      const server = await startMinimalGatewayServer({ token });
      let client: Awaited<ReturnType<typeof connectTestGatewayClient>> | undefined;

      try {
        client = await connectTestGatewayClient({
          url: server.url,
          token,
          deviceIdentity,
          timeoutMs: GATEWAY_CONNECT_OPERATION_TIMEOUT_MS,
          maxAttemptTimeoutMs: GATEWAY_CONNECT_OPERATION_TIMEOUT_MS,
          requestTimeoutMs: GATEWAY_CONNECT_OPERATION_TIMEOUT_MS,
          waitForEventLoopReady: false,
        });
        const health = await client.request("health", undefined, {
          timeoutMs: GATEWAY_CONNECT_OPERATION_TIMEOUT_MS,
        });
        const connectClient = server.connectParams?.client as Record<string, unknown> | undefined;
        expect(health.ok).toBe(true);
        expect(connectClient?.id).toBe(GATEWAY_CLIENT_NAMES.TEST);
        expect(connectClient?.displayName).toBe("vitest-live");
        expect(connectClient?.version).toBe("dev");
        expect(connectClient?.mode).toBe(GATEWAY_CLIENT_MODES.TEST);
        expect(server.requests).toEqual(["connect", "health"]);
      } finally {
        await client
          ?.stopAndWait({ timeoutMs: GATEWAY_CONNECT_OPERATION_TIMEOUT_MS })
          .catch(() => {});
        await server.close();
      }
    },
    GATEWAY_CONNECT_TEST_TIMEOUT_MS,
  );
});
