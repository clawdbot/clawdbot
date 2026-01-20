import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import { HANDSHAKE_TIMEOUT_MS } from "./server-constants.js";
import {
  connectReq,
  getFreePort,
  installGatewayTestHooks,
  onceMessage,
  startGatewayServer,
  startServerWithClient,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks();

async function waitForWsClose(ws: WebSocket, timeoutMs: number): Promise<boolean> {
  if (ws.readyState === WebSocket.CLOSED) return true;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(ws.readyState === WebSocket.CLOSED), timeoutMs);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

describe("gateway server auth/connect", () => {
  test("closes silent handshakes after timeout", { timeout: 60_000 }, async () => {
    vi.useRealTimers();
    const { server, ws } = await startServerWithClient();
    const closed = await waitForWsClose(ws, HANDSHAKE_TIMEOUT_MS + 2_000);
    expect(closed).toBe(true);
    await server.close();
  });

  test("connect (req) handshake returns hello-ok payload", async () => {
    const { CONFIG_PATH_CLAWDBOT, STATE_DIR_CLAWDBOT } = await import("../config/config.js");
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws.once("open", resolve));

    const res = await connectReq(ws);
    expect(res.ok).toBe(true);
    const payload = res.payload as
      | {
          type?: unknown;
          snapshot?: { configPath?: string; stateDir?: string };
        }
      | undefined;
    expect(payload?.type).toBe("hello-ok");
    expect(payload?.snapshot?.configPath).toBe(CONFIG_PATH_CLAWDBOT);
    expect(payload?.snapshot?.stateDir).toBe(STATE_DIR_CLAWDBOT);

    ws.close();
    await server.close();
  });

  test("rejects protocol mismatch", async () => {
    const { server, ws } = await startServerWithClient();
    try {
      const res = await connectReq(ws, {
        minProtocol: PROTOCOL_VERSION + 1,
        maxProtocol: PROTOCOL_VERSION + 2,
      });
      expect(res.ok).toBe(false);
    } catch {
      // If the server closed before we saw the frame, that's acceptable.
    }
    ws.close();
    await server.close();
  });

  test("rejects invalid token", async () => {
    const { server, ws, prevToken } = await startServerWithClient("secret");
    const res = await connectReq(ws, { token: "wrong" });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("unauthorized");
    ws.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.CLAWDBOT_GATEWAY_TOKEN;
    } else {
      process.env.CLAWDBOT_GATEWAY_TOKEN = prevToken;
    }
  });

  test("accepts password auth when configured", async () => {
    testState.gatewayAuth = { mode: "password", password: "secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws.once("open", resolve));

    const res = await connectReq(ws, { password: "secret" });
    expect(res.ok).toBe(true);

    ws.close();
    await server.close();
  });

  test("accepts device token auth for paired device", async () => {
    const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
    const { approveDevicePairing, getPairedDevice, listDevicePairing } = await import(
      "../infra/device-pairing.js"
    );
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    const res = await connectReq(ws, { token: "secret" });
    if (!res.ok) {
      const list = await listDevicePairing();
      const pending = list.pending.at(0);
      expect(pending?.requestId).toBeDefined();
      if (pending?.requestId) {
        await approveDevicePairing(pending.requestId);
      }
    }

    const identity = loadOrCreateDeviceIdentity();
    const paired = await getPairedDevice(identity.deviceId);
    const deviceToken = paired?.tokens?.operator?.token;
    expect(deviceToken).toBeDefined();

    ws.close();

    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws2.once("open", resolve));
    const res2 = await connectReq(ws2, { token: deviceToken });
    expect(res2.ok).toBe(true);

    ws2.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.CLAWDBOT_GATEWAY_TOKEN;
    } else {
      process.env.CLAWDBOT_GATEWAY_TOKEN = prevToken;
    }
  });

  test("rejects revoked device token", async () => {
    const { loadOrCreateDeviceIdentity } = await import("../infra/device-identity.js");
    const { approveDevicePairing, getPairedDevice, listDevicePairing, revokeDeviceToken } =
      await import("../infra/device-pairing.js");
    const { server, ws, port, prevToken } = await startServerWithClient("secret");
    const res = await connectReq(ws, { token: "secret" });
    if (!res.ok) {
      const list = await listDevicePairing();
      const pending = list.pending.at(0);
      expect(pending?.requestId).toBeDefined();
      if (pending?.requestId) {
        await approveDevicePairing(pending.requestId);
      }
    }

    const identity = loadOrCreateDeviceIdentity();
    const paired = await getPairedDevice(identity.deviceId);
    const deviceToken = paired?.tokens?.operator?.token;
    expect(deviceToken).toBeDefined();

    await revokeDeviceToken({ deviceId: identity.deviceId, role: "operator" });

    ws.close();

    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws2.once("open", resolve));
    const res2 = await connectReq(ws2, { token: deviceToken });
    expect(res2.ok).toBe(false);

    ws2.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.CLAWDBOT_GATEWAY_TOKEN;
    } else {
      process.env.CLAWDBOT_GATEWAY_TOKEN = prevToken;
    }
  });

  test("rejects invalid password", async () => {
    testState.gatewayAuth = { mode: "password", password: "secret" };
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws.once("open", resolve));

    const res = await connectReq(ws, { password: "wrong" });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("unauthorized");

    ws.close();
    await server.close();
  });

  test("rejects non-connect first request", async () => {
    const { server, ws } = await startServerWithClient();
    ws.send(JSON.stringify({ type: "req", id: "h1", method: "health" }));
    const res = await onceMessage<{ ok: boolean; error?: unknown }>(
      ws,
      (o) => o.type === "res" && o.id === "h1",
    );
    expect(res.ok).toBe(false);
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));
    await server.close();
  });

  test(
    "invalid connect params surface in response and close reason",
    { timeout: 60_000 },
    async () => {
      const { server, ws } = await startServerWithClient();
      const closeInfoPromise = new Promise<{ code: number; reason: string }>((resolve) => {
        ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
      });

      ws.send(
        JSON.stringify({
          type: "req",
          id: "h-bad",
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: "bad-client",
              version: "dev",
              platform: "web",
              mode: "webchat",
            },
            device: {
              id: 123,
              publicKey: "bad",
              signature: "bad",
              signedAt: "bad",
            },
          },
        }),
      );

      const res = await onceMessage<{
        ok: boolean;
        error?: { message?: string };
      }>(
        ws,
        (o) => (o as { type?: string }).type === "res" && (o as { id?: string }).id === "h-bad",
      );
      expect(res.ok).toBe(false);
      expect(String(res.error?.message ?? "")).toContain("invalid connect params");

      const closeInfo = await closeInfoPromise;
      expect(closeInfo.code).toBe(1008);
      expect(closeInfo.reason).toContain("invalid connect params");

      await server.close();
    },
  );
});
