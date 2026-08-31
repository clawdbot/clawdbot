import { once } from "node:events";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { ensureGatewayReadyForOperation } from "../../commands/gateway-readiness.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
  startMinimalRealGateway,
} from "../../gateway/minimal-gateway.test-helpers.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { probeGatewayStatus } from "./probe.js";
import type { DaemonStatus } from "./status.gather.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function checkDashboardReadiness(url: string, rpc: NonNullable<DaemonStatus["rpc"]>) {
  const port = Number(new URL(url).port);
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const confirm = vi.fn();
  const startGateway = vi.fn();
  const installGateway = vi.fn();
  const result = await ensureGatewayReadyForOperation({
    runtime,
    operation: "open the dashboard",
    readyWhenReachable: true,
    interactive: true,
    deps: {
      confirm,
      startGateway,
      installGateway,
      gatherStatus: async () => ({
        service: {
          label: "synthetic stopped service",
          loaded: false,
          loadState: { status: "not-loaded" },
          loadedText: "loaded",
          notLoadedText: "not loaded",
          command: null,
          runtime: { status: "stopped" },
        },
        port: { port, status: "busy", listeners: [], hints: [] },
        rpc: { ...rpc, url },
        extraServices: [],
      }),
    },
  });
  expect(confirm).not.toHaveBeenCalled();
  expect(startGateway).not.toHaveBeenCalled();
  expect(installGateway).not.toHaveBeenCalled();
  return { result, output: runtime.log.mock.calls.flat().join("\n") };
}

describe("Gateway reachability over real sockets", () => {
  it.each(["terminate", "policy-close", "silent", "upgrade-rejected"] as const)(
    "does not start a second service or accept a %s listener",
    async (mode) => {
      const state = await createOpenClawTestState();
      cleanups.push(() => state.cleanup());
      const wss = new WebSocketServer({
        host: "127.0.0.1",
        port: 0,
        ...(mode === "upgrade-rejected" ? { verifyClient: () => false } : {}),
      });
      cleanups.push(() => closeMinimalGatewayServer(wss));
      wss.on("connection", (ws) => {
        if (mode === "terminate") {
          ws.terminate();
        } else if (mode === "policy-close") {
          ws.close(1008, "pairing required");
        }
      });
      await once(wss, "listening");
      const address = wss.address();
      if (typeof address === "string" || !address) {
        throw new Error("missing test listener address");
      }
      const url = `ws://127.0.0.1:${address.port}`;
      const rpc = await probeGatewayStatus({ url, config: {}, timeoutMs: 400, json: true });
      assert(!rpc.ok);
      expect(rpc.gatewayReached).toBeUndefined();
      if (mode === "terminate") {
        expect(rpc.error).toContain("gateway closed (1006)");
      }
      const { result, output } = await checkDashboardReadiness(url, rpc);
      expect(result).toMatchObject({ ready: false, recoverable: false });
      expect(output).toContain("Gateway probe failed:");
      expect(output).not.toContain("Gateway is not running");
      expect(output).not.toContain("gateway start");
    },
  );

  it("preserves the accepted handshake when a subsequent status RPC fails", async () => {
    const state = await createOpenClawTestState();
    cleanups.push(() => state.cleanup());
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    cleanups.push(() => closeMinimalGatewayServer(wss));
    wss.on("connection", (ws) => {
      sendMinimalGatewayConnectChallenge(ws);
      ws.on("message", (data) => {
        const frame = parseMinimalGatewayRequestFrame(data);
        if (frame.method === "connect") {
          sendMinimalGatewayResponse(
            ws,
            frame.id!,
            buildMinimalGatewayHelloOkPayload({
              methods: ["status"],
              auth: { role: "operator", scopes: ["operator.read"] },
            }),
          );
        } else {
          ws.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { code: "UNAVAILABLE", message: "synthetic status failure" },
            }),
          );
        }
      });
    });
    await once(wss, "listening");
    const address = wss.address();
    if (typeof address === "string" || !address) {
      throw new Error("missing test listener address");
    }
    const url = `ws://127.0.0.1:${address.port}`;
    const rpc = await probeGatewayStatus({
      url,
      token: "synthetic-token",
      config: {},
      timeoutMs: 2_000,
      json: true,
      requireRpc: true,
    });
    expect(rpc).toMatchObject({
      ok: false,
      gatewayReached: true,
      error: "synthetic status failure",
      capability: "read_only",
      server: { version: "test", connId: "conn-test" },
    });
    expect((await checkDashboardReadiness(url, rpc)).result.ready).toBe(true);
  });

  it("accepts a real Gateway auth rejection as reachable without starting another service", async () => {
    const gateway = await startMinimalRealGateway();
    cleanups.push(() => gateway.close());
    const rejected = await probeGatewayStatus({
      url: gateway.url,
      token: "synthetic-wrong-token",
      config: {},
      timeoutMs: 5_000,
      json: true,
    });
    expect(rejected).toMatchObject({
      ok: false,
      gatewayReached: true,
      connectFailure: { kind: "auth-rejected" },
    });
    expect((await checkDashboardReadiness(gateway.url, rejected)).result.ready).toBe(true);
    const accepted = await probeGatewayStatus({
      url: gateway.url,
      token: gateway.token,
      config: {},
      timeoutMs: 5_000,
      json: true,
    });
    expect(accepted.ok).toBe(true);
    expect((await checkDashboardReadiness(gateway.url, accepted)).result.ready).toBe(true);
  });
});
