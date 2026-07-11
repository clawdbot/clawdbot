// Gateway Network Client tests cover gateway network client script behavior.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  assertGatewaySuspendingError,
  assertReadySuspensionResponse,
  assertSuspendedProbes,
  runGatewayNetworkClient,
} from "../../scripts/e2e/lib/gateway-network/client.mjs";
import { readGatewayNetworkClientConnectTimeoutMs } from "../../scripts/e2e/lib/gateway-network/limits.mjs";
import { onceFrame } from "../../scripts/e2e/lib/gateway-network/ws-frames.mjs";

describe("gateway network WebSocket open guard", () => {
  function healthResponse() {
    return {
      ok: true,
      payload: {
        agents: [],
        channelOrder: [],
        channels: {},
        defaultAgentId: "codex",
        durationMs: 3,
        ok: true,
        sessions: { count: 0, path: "/state/sessions", recent: [] },
        ts: Date.now(),
      },
    };
  }

  it("rejects loose client timeout env values instead of parsing prefixes", () => {
    expect(() =>
      readGatewayNetworkClientConnectTimeoutMs({
        OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS: "100ms",
      }),
    ).toThrow("invalid OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS: 100ms");
    expect(() =>
      readGatewayNetworkClientConnectTimeoutMs({
        OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS: "1e3",
      }),
    ).toThrow("invalid OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS: 1e3");
    expect(() =>
      readGatewayNetworkClientConnectTimeoutMs({
        OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS: "0",
      }),
    ).toThrow("invalid OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS: 0");
  });

  it("prefers the explicit client timeout over the connect-ready fallback", () => {
    expect(
      readGatewayNetworkClientConnectTimeoutMs({
        OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS: "5000",
        OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS: "1000",
      }),
    ).toBe(5000);
    expect(
      readGatewayNetworkClientConnectTimeoutMs({
        OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS: "3000",
      }),
    ).toBe(3000);
  });

  it("resolves matching frames and ignores unrelated frames", async () => {
    const ws = new EventEmitter();
    const frame = onceFrame(ws, (message) => message?.id === "target", 1000);

    ws.emit("message", JSON.stringify({ id: "noise" }));
    ws.emit("message", JSON.stringify({ id: "target", ok: true }));

    await expect(frame).resolves.toEqual({ id: "target", ok: true });
  });

  it("times out when no matching frame arrives", async () => {
    const ws = new EventEmitter();
    const frame = onceFrame(ws, () => false, 10);

    ws.emit("message", JSON.stringify({ id: "noise" }));

    await expect(frame).rejects.toThrow("timeout");
  });

  it("rejects frame waits immediately when the socket closes", async () => {
    const ws = new EventEmitter();
    const startedAt = Date.now();
    const frame = onceFrame(ws, () => false, 1000);

    ws.emit("close", 1006, Buffer.from("bye"));

    await expect(frame).rejects.toThrow("closed before frame: 1006 bye");
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("rejects frame waits immediately on socket errors", async () => {
    const ws = new EventEmitter();
    const frame = onceFrame(ws, () => false, 1000);

    ws.emit("error", new Error("socket exploded"));

    await expect(frame).rejects.toThrow("socket exploded");
  });

  it("rejects invalid JSON frames instead of crashing the process", async () => {
    const ws = new EventEmitter();
    const frame = onceFrame(ws, () => false, 1000);

    ws.emit("message", "{nope");

    await expect(frame).rejects.toThrow();
  });

  function createNetworkClientHarness(
    responses: Array<{ error?: { message?: string }; ok: boolean }>,
  ) {
    const frames = [...responses];
    const sentMethods: string[] = [];
    const stdout: string[] = [];
    let closeCount = 0;
    const socket = {
      close: () => {
        closeCount += 1;
      },
      send: (payload: string) => {
        sentMethods.push(JSON.parse(payload).method);
      },
    };

    return {
      get closeCount() {
        return closeCount;
      },
      sentMethods,
      stdout,
      deps: {
        delay: async () => {},
        onceFrame: async (
          _ws: unknown,
          predicate: (frame: unknown) => boolean,
          _timeoutMs?: number,
        ) => {
          const frame = {
            type: "res",
            id: sentMethods.at(-1) === "connect" ? "c1" : "h1",
            ...frames.shift(),
          };
          expect(predicate(frame)).toBe(true);
          return frame;
        },
        openSocket: async () => socket,
        protocolVersion: 1,
        stdout: (message: string) => {
          stdout.push(message);
        },
      },
    };
  }

  it("proves health after the authenticated connect handshake", async () => {
    const harness = createNetworkClientHarness([{ ok: true }, healthResponse()]);

    await runGatewayNetworkClient(
      { token: "secret-token", url: "ws://127.0.0.1:12345", timeoutMs: 1000 },
      harness.deps,
    );

    expect(harness.sentMethods).toEqual(["connect", "health"]);
    expect(harness.stdout).toEqual(["ok"]);
    expect(harness.closeCount).toBe(1);
  });

  it("bounds socket and frame waits by the client deadline", async () => {
    const harness = createNetworkClientHarness([{ ok: true }, healthResponse()]);
    const openSocket = vi.fn(harness.deps.openSocket);
    const onceFrame = vi.fn(harness.deps.onceFrame);

    await runGatewayNetworkClient(
      { token: "secret-token", url: "ws://127.0.0.1:12345", timeoutMs: 250 },
      {
        ...harness.deps,
        onceFrame,
        openSocket,
      },
    );

    expect(openSocket.mock.calls[0]?.[1]).toBeGreaterThan(0);
    expect(openSocket.mock.calls[0]?.[1]).toBeLessThanOrEqual(250);
    expect(onceFrame.mock.calls.map((call) => call[2])).toHaveLength(2);
    for (const frameTimeoutMs of onceFrame.mock.calls.map((call) => call[2])) {
      expect(frameTimeoutMs).toBeGreaterThan(0);
      expect(frameTimeoutMs).toBeLessThanOrEqual(250);
    }
  });

  it("does not sleep past the remaining client deadline between retries", async () => {
    const delays: number[] = [];
    let now = 1_000;

    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await expect(
        runGatewayNetworkClient(
          { token: "secret-token", url: "ws://127.0.0.1:12345", timeoutMs: 250 },
          {
            delay: async (ms: number) => {
              delays.push(ms);
              now += ms;
            },
            openSocket: async () => {
              now += 200;
              throw new Error("ECONNREFUSED");
            },
            protocolVersion: 1,
            stdout: () => {},
          },
        ),
      ).rejects.toThrow("ECONNREFUSED");
    } finally {
      dateSpy.mockRestore();
    }

    expect(delays).toEqual([50]);
  });

  it("fails a connected socket whose health success lacks summary evidence", async () => {
    const harness = createNetworkClientHarness([{ ok: true }, { ok: true }]);

    await expect(
      runGatewayNetworkClient(
        { token: "secret-token", url: "ws://127.0.0.1:12345", timeoutMs: 1000 },
        harness.deps,
      ),
    ).rejects.toThrow("health failed: missing health summary payload");

    expect(harness.sentMethods).toEqual(["connect", "health"]);
    expect(harness.stdout).toEqual([]);
    expect(harness.closeCount).toBe(1);
  });

  it("fails a connected socket whose health probe fails", async () => {
    const harness = createNetworkClientHarness([
      { ok: true },
      { ok: false, error: { message: "health unavailable" } },
    ]);

    await expect(
      runGatewayNetworkClient(
        { token: "secret-token", url: "ws://127.0.0.1:12345", timeoutMs: 1000 },
        harness.deps,
      ),
    ).rejects.toThrow("health failed: health unavailable");

    expect(harness.sentMethods).toEqual(["connect", "health"]);
    expect(harness.closeCount).toBe(1);
  });

  it("accepts only an idle future suspension lease", () => {
    const payload = {
      status: "ready",
      suspensionId: "lease-1",
      expiresAtMs: 2_000,
      activeCount: 0,
      blockers: [],
    };
    const response = (overrides = {}) => ({
      status: 200,
      body: { ok: true, payload: { ...payload, ...overrides } },
    });

    expect(assertReadySuspensionResponse(response(), 1_000)).toEqual(payload);
    expect(() => assertReadySuspensionResponse(response({ expiresAtMs: 999 }), 1_000)).toThrow(
      "expire in the future",
    );
    expect(() => assertReadySuspensionResponse(response({ activeCount: 1 }), 1_000)).toThrow(
      "no active work",
    );
  });

  it("requires canonical prepared-suspension RPC and probe evidence", () => {
    const suspendedError = {
      ok: false,
      error: {
        code: "UNAVAILABLE",
        retryable: true,
        details: { reason: "gateway-suspending", phase: "prepared" },
      },
    };
    const health = { status: 200, body: { ok: true, status: "live" } };
    const readiness = { status: 503, body: { ready: false, failing: ["gateway-draining"] } };

    expect(() => assertGatewaySuspendingError(suspendedError)).not.toThrow();
    expect(() => assertSuspendedProbes(health, readiness)).not.toThrow();
    expect(() =>
      assertGatewaySuspendingError({
        ...suspendedError,
        error: {
          ...suspendedError.error,
          details: { reason: "gateway-restarting", phase: "prepared" },
        },
      }),
    ).toThrow("identify gateway suspension");
    expect(() =>
      assertSuspendedProbes(health, {
        status: 503,
        body: { ready: false, failing: ["channels"] },
      }),
    ).toThrow("identify gateway-draining");
  });
});
