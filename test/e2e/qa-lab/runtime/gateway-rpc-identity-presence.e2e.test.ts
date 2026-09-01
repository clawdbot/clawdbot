import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openAuthenticatedGatewayWs } from "../../../../src/gateway/shared-auth.test-helpers.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import {
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
} from "../../../../src/gateway/test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const TOKEN = `rpc-identity-presence-${process.pid}`;
let started: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

beforeAll(async () => {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required");
  }
  started = await startGatewayWithClient({
    cfg: { gateway: { auth: { mode: "token", token: TOKEN } } },
    configPath: path.join(stateDir, "openclaw.json"),
    token: TOKEN,
    clientDisplayName: "rpc-identity-presence-bootstrap",
  });
});

afterAll(async () => {
  if (!started) {
    return;
  }
  await disconnectGatewayClient(started.client).catch(() => undefined);
  await started.server.close({ reason: "gateway RPC identity and presence proof complete" });
});

describe("gateway RPC identity and presence", () => {
  it("exposes stable identity, host information, presence broadcasts, and heartbeat controls", async () => {
    if (!started) {
      throw new Error("Gateway did not start");
    }
    const writer = await openAuthenticatedGatewayWs(started.port, TOKEN);
    const observer = await openAuthenticatedGatewayWs(started.port, TOKEN);

    try {
      const writerIdentity = await rpcReq<{
        deviceId: string;
        publicKey: string;
      }>(writer, "gateway.identity.get");
      const observerIdentity = await rpcReq<{
        deviceId: string;
        publicKey: string;
      }>(observer, "gateway.identity.get");
      expect(writerIdentity).toMatchObject({ ok: true });
      expect(observerIdentity.payload).toEqual(writerIdentity.payload);
      expect(writerIdentity.payload).toEqual({
        deviceId: expect.any(String),
        publicKey: expect.any(String),
      });

      const systemInfo = await rpcReq<{
        arch: string;
        cpuCount: number;
        hostname: string;
        memoryTotalBytes: number;
        nodeVersion: string;
        platform: string;
        processInstanceId: string;
      }>(writer, "system.info");
      expect(systemInfo).toMatchObject({
        ok: true,
        payload: {
          arch: expect.any(String),
          cpuCount: expect.any(Number),
          hostname: expect.any(String),
          memoryTotalBytes: expect.any(Number),
          nodeVersion: expect.any(String),
          platform: expect.any(String),
          processInstanceId: expect.any(String),
        },
      });
      expect(systemInfo.payload?.cpuCount).toBeGreaterThan(0);
      expect(systemInfo.payload?.memoryTotalBytes).toBeGreaterThan(0);

      const before = await rpcReq<{ length: number }>(observer, "system-presence");
      expect(before.ok).toBe(true);
      expect(Array.isArray(before.payload)).toBe(true);

      const presenceEvent = onceMessage(
        observer,
        (frame) =>
          frame.type === "event" &&
          frame.event === "presence" &&
          Array.isArray(frame.payload?.presence) &&
          frame.payload.presence.some(
            (entry: { deviceId?: string }) => entry.deviceId === "rpc-catalog-device",
          ),
      );
      const systemEvent = await rpcReq<{ ok: boolean }>(writer, "system-event", {
        text: "Node: rpc-catalog-host (127.0.0.2) · app 1.0.0 · last input 2s ago · mode qa · reason catalog-proof",
        deviceId: "rpc-catalog-device",
        instanceId: "rpc-catalog-instance",
        host: "rpc-catalog-host",
        ip: "127.0.0.2",
        mode: "qa",
        reason: "catalog-proof",
        version: "1.0.0",
      });
      expect(systemEvent).toMatchObject({ ok: true, payload: { ok: true } });
      expect(await presenceEvent).toMatchObject({
        event: "presence",
        stateVersion: { presence: expect.any(Number) },
        type: "event",
      });

      const after = await rpcReq<{
        find: unknown;
      }>(observer, "system-presence");
      expect(after.ok).toBe(true);
      expect(after.payload).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            deviceId: "rpc-catalog-device",
            host: "rpc-catalog-host",
            mode: "qa",
            reason: "catalog-proof",
          }),
        ]),
      );

      const lastHeartbeat = await rpcReq<Record<string, unknown>>(writer, "last-heartbeat");
      expect(lastHeartbeat.ok).toBe(true);
      expect(lastHeartbeat.payload === null || typeof lastHeartbeat.payload === "object").toBe(
        true,
      );

      try {
        expect(await rpcReq(writer, "set-heartbeats", { enabled: false })).toMatchObject({
          ok: true,
          payload: { enabled: false, ok: true },
        });
      } finally {
        expect(await rpcReq(writer, "set-heartbeats", { enabled: true })).toMatchObject({
          ok: true,
          payload: { enabled: true, ok: true },
        });
      }
    } finally {
      writer.close();
      observer.close();
    }
  });
});
