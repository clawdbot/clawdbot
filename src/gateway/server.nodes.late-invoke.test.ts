import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";

import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";

vi.mock("../infra/update-runner.js", () => ({
  runGatewayUpdate: vi.fn(async () => ({
    status: "ok",
    mode: "git",
    root: "/repo",
    steps: [],
    durationMs: 12,
  })),
}));

import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: WebSocket;
let port: number;

beforeAll(async () => {
  const token = "test-gateway-token-1234567890";
  const started = await startServerWithClient(token);
  server = started.server;
  ws = started.ws;
  port = started.port;
  await connectOk(ws, { token });
});

afterAll(async () => {
  ws.close();
  await server.close();
});

describe("late-arriving invoke results", () => {
  test("returns success for unknown invoke id (late arrival after timeout)", async () => {
    // Create a node client WebSocket
    const nodeWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => nodeWs.once("open", resolve));

    try {
      // Connect as a node with device identity
      const identity = loadOrCreateDeviceIdentity();
      const nodeId = identity.deviceId;

      await connectOk(nodeWs, {
        role: "node",
        client: {
          id: GATEWAY_CLIENT_NAMES.NODE_HOST,
          version: "1.0.0",
          platform: "ios",
          mode: GATEWAY_CLIENT_MODES.NODE,
        },
        commands: ["canvas.snapshot"],
        token: "test-gateway-token-1234567890",
      });

      // Send an invoke result with an unknown ID (simulating late arrival after timeout)
      const result = await rpcReq<{ ok?: boolean; ignored?: boolean }>(
        nodeWs,
        "node.invoke.result",
        {
          id: "unknown-invoke-id-12345",
          nodeId,
          ok: true,
          payloadJSON: JSON.stringify({ result: "late" }),
        },
      );

      // Late-arriving results return success instead of error to reduce log noise
      expect(result.ok).toBe(true);
      expect(result.payload?.ok).toBe(true);
      expect(result.payload?.ignored).toBe(true);
    } finally {
      nodeWs.close();
    }
  });

  test("returns success for unknown invoke id with error payload", async () => {
    // Verifies late results are accepted regardless of their ok/error status
    const nodeWs = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => nodeWs.once("open", resolve));

    try {
      await connectOk(nodeWs, {
        role: "node",
        client: {
          id: GATEWAY_CLIENT_NAMES.NODE_HOST,
          version: "1.0.0",
          platform: "darwin",
          mode: GATEWAY_CLIENT_MODES.NODE,
        },
        commands: [],
      });

      const identity = loadOrCreateDeviceIdentity();
      const nodeId = identity.deviceId;

      // Late invoke result with error payload - should still return success
      const result = await rpcReq<{ ok?: boolean; ignored?: boolean }>(
        nodeWs,
        "node.invoke.result",
        {
          id: "another-unknown-invoke-id",
          nodeId,
          ok: false,
          error: { code: "FAILED", message: "test error" },
        },
      );

      expect(result.ok).toBe(true);
      expect(result.payload?.ok).toBe(true);
      expect(result.payload?.ignored).toBe(true);
    } finally {
      nodeWs.close();
    }
  });
});
