// Probe close-drain tests ensure probeGateway waits for the WebSocket socket to
// close before resolving, preventing leaked handles in callers and test runs.
import { type AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "./minimal-gateway.test-helpers.js";
import { probeGateway } from "./probe.js";

const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-probe-close-drain-" });

function activeClientSocketsToPort(port: number): Socket[] {
  // Node has no public active-handle API; this regression must prove the probe
  // promise does not resolve while the client-side socket handle is still live.
  const getActiveHandles = Reflect.get(process, "_getActiveHandles") as
    | (() => unknown[])
    | undefined;
  const handles = getActiveHandles?.() ?? [];
  return handles.filter(
    (handle): handle is Socket => handle instanceof Socket && handle.remotePort === port,
  );
}

async function createTempStateDir(): Promise<string> {
  return await tempDirs.make("state");
}

describe("probeGateway close drain", () => {
  beforeAll(async () => {
    await tempDirs.setup();
  });

  afterAll(async () => {
    await tempDirs.cleanup();
  });

  it("waits for the real WebSocket client socket to close before resolving", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let sawConnect = false;

    wss.on("connection", (ws) => {
      sendMinimalGatewayConnectChallenge(ws);
      ws.on("message", (raw) => {
        const frame = parseMinimalGatewayRequestFrame(raw);
        if (frame.type !== "req" || frame.method !== "connect" || !frame.id) {
          return;
        }
        sawConnect = true;
        sendMinimalGatewayResponse(
          ws,
          frame.id,
          buildMinimalGatewayHelloOkPayload({
            auth: { role: "operator", scopes: ["operator.read"] },
          }),
        );
      });
    });

    try {
      await new Promise<void>((resolve) => {
        wss.once("listening", resolve);
      });
      const port = (wss.address() as AddressInfo).port;

      const result = await probeGateway({
        url: `ws://127.0.0.1:${port}`,
        auth: { token: "secret" },
        timeoutMs: 1_000,
        includeDetails: false,
        env: { ...process.env, OPENCLAW_STATE_DIR: await createTempStateDir() },
      });

      expect(result.ok).toBe(true);
      expect(sawConnect).toBe(true);
      expect(activeClientSocketsToPort(port)).toHaveLength(0);
    } finally {
      await closeMinimalGatewayServer(wss);
    }
  });
});
