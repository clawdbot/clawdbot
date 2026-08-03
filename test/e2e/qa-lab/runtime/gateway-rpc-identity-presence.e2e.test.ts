import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startGatewayServerHarness,
  type GatewayServerHarness,
} from "../../../../src/gateway/server.e2e-ws-harness.js";
import {
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
} from "../../../../src/gateway/test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let harness: GatewayServerHarness;

beforeAll(async () => {
  harness = await startGatewayServerHarness();
});

afterAll(async () => {
  await harness.close();
});

describe("gateway RPC identity and presence", () => {
  it("exposes stable identity, host information, presence broadcasts, and heartbeat controls", async () => {
    const writer = await harness.openClient();
    const observer = await harness.openClient();

    const writerIdentity = await rpcReq<{
      deviceId: string;
      publicKey: string;
    }>(writer.ws, "gateway.identity.get");
    const observerIdentity = await rpcReq<{
      deviceId: string;
      publicKey: string;
    }>(observer.ws, "gateway.identity.get");
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
    }>(writer.ws, "system.info");
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

    const before = await rpcReq<{ length: number }>(observer.ws, "system-presence");
    expect(before.ok).toBe(true);
    expect(Array.isArray(before.payload)).toBe(true);

    const presenceEvent = onceMessage(
      observer.ws,
      (frame) =>
        frame.type === "event" &&
        frame.event === "presence" &&
        Array.isArray(frame.payload?.presence) &&
        frame.payload.presence.some(
          (entry: { deviceId?: string }) => entry.deviceId === "rpc-catalog-device",
        ),
    );
    const systemEvent = await rpcReq<{ ok: boolean }>(writer.ws, "system-event", {
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
    }>(observer.ws, "system-presence");
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

    const lastHeartbeat = await rpcReq<Record<string, unknown>>(writer.ws, "last-heartbeat");
    expect(lastHeartbeat.ok).toBe(true);
    expect(lastHeartbeat.payload === null || typeof lastHeartbeat.payload === "object").toBe(true);

    try {
      expect(await rpcReq(writer.ws, "set-heartbeats", { enabled: false })).toMatchObject({
        ok: true,
        payload: { enabled: false, ok: true },
      });
    } finally {
      expect(await rpcReq(writer.ws, "set-heartbeats", { enabled: true })).toMatchObject({
        ok: true,
        payload: { enabled: true, ok: true },
      });
      writer.ws.close();
      observer.ws.close();
    }
  });
});
