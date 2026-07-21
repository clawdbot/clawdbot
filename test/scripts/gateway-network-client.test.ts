// Gateway Network Client tests cover gateway network client script behavior.
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type GatewayFrame,
  assertGatewaySuspendingError,
  assertReadySuspensionResponse,
  assertSuspendedProbes,
  prepareReadySuspension,
  runGatewayNetworkClient,
  runGatewaySuspensionPostRestartClient,
  runGatewaySuspensionPreRestartClient,
} from "../../scripts/e2e/lib/gateway-network/client.mjs";
import { readGatewayNetworkClientConnectTimeoutMs } from "../../scripts/e2e/lib/gateway-network/limits.mjs";
import { onceFrame } from "../../scripts/e2e/lib/gateway-network/ws-frames.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("gateway network client", () => {
  function rejectWhenAborted(signal: AbortSignal | null | undefined): Promise<never> {
    expect(signal).toBeInstanceOf(AbortSignal);
    const requestSignal = signal as AbortSignal;
    return new Promise((_, reject) => {
      const rejectWithReason = () => reject(requestSignal.reason);
      if (requestSignal.aborted) {
        rejectWithReason();
        return;
      }
      requestSignal.addEventListener("abort", rejectWithReason, { once: true });
    });
  }

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

  it("retries busy suspension preparation using the server delay", async () => {
    const expiresAtMs = Date.now() + 10_000;
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        body: {
          ok: true,
          payload: { status: "busy", retryAfterMs: 250, activeCount: 1, blockers: ["agent"] },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          ok: true,
          payload: {
            status: "ready",
            suspensionId: "lease-1",
            expiresAtMs,
            activeCount: 0,
            blockers: [],
          },
        },
      });
    const delayImpl = vi.fn(async () => undefined);

    await expect(
      prepareReadySuspension(
        { deadline: Date.now() + 5_000, requestId: "request-1", rpc },
        { delayImpl },
      ),
    ).resolves.toMatchObject({ status: "ready", suspensionId: "lease-1" });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenNthCalledWith(1, "gateway.suspend.prepare", {
      requestId: "request-1",
    });
    expect(delayImpl).toHaveBeenCalledWith(250);
  });

  it("retries retryable suspension recovery responses using the server delay", async () => {
    const expiresAtMs = Date.now() + 10_000;
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        status: 503,
        body: {
          ok: false,
          error: {
            code: "UNAVAILABLE",
            retryable: true,
            retryAfterMs: 125,
            details: { reason: "scheduler-resume-failed" },
          },
        },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: {
          ok: true,
          payload: {
            status: "ready",
            suspensionId: "lease-recovered",
            expiresAtMs,
            activeCount: 0,
            blockers: [],
          },
        },
      });
    const delayImpl = vi.fn(async () => undefined);

    await expect(
      prepareReadySuspension(
        { deadline: Date.now() + 5_000, requestId: "request-recovery", rpc },
        { delayImpl },
      ),
    ).resolves.toMatchObject({ status: "ready", suspensionId: "lease-recovered" });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(delayImpl).toHaveBeenCalledWith(125);
  });

  it("rejects non-retryable suspension errors immediately", async () => {
    const rpc = vi.fn(async () => ({
      status: 503,
      body: {
        ok: false,
        error: { code: "UNAVAILABLE", retryable: false },
      },
    }));
    const delayImpl = vi.fn(async () => undefined);

    await expect(
      prepareReadySuspension(
        { deadline: Date.now() + 5_000, requestId: "request-rejected", rpc },
        { delayImpl },
      ),
    ).rejects.toThrow("suspension prepare must return HTTP 200");
    expect(rpc).toHaveBeenCalledOnce();
    expect(delayImpl).not.toHaveBeenCalled();
  });

  it("stops busy suspension retries at the client deadline", async () => {
    let nowMs = 1_000;
    const rpc = vi.fn(async () => ({
      status: 200,
      body: {
        ok: true,
        payload: { status: "busy", retryAfterMs: 250, activeCount: 1, blockers: ["agent"] },
      },
    }));
    const delayImpl = vi.fn(async (ms: number) => {
      nowMs += ms;
    });

    await expect(
      prepareReadySuspension(
        { deadline: 1_250, requestId: "request-busy", rpc },
        { delayImpl, now: () => nowMs },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(rpc).toHaveBeenCalledOnce();
    expect(delayImpl).toHaveBeenCalledWith(250);
  });

  it("bounds a stalled suspension admin request by the client deadline", async () => {
    let requestSignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      requestSignal = init?.signal;
      return rejectWhenAborted(requestSignal);
    });

    const startedAt = Date.now();
    await expect(
      runGatewaySuspensionPreRestartClient(
        {
          statePath: "/tmp/unused-gateway-network-state.json",
          token: "x",
          url: "ws://127.0.0.1:12345",
          timeoutMs: 25,
        },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps a stalled suspension response body inside the client deadline", async () => {
    let callCount = 0;
    let bodySignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      callCount += 1;
      if (callCount === 1) {
        return Response.json({
          ok: true,
          payload: {
            status: "ready",
            suspensionId: "lease-1",
            expiresAtMs: Date.now() + 10_000,
            activeCount: 0,
            blockers: [],
          },
        });
      }
      bodySignal = init?.signal;
      const response = new Response(null, { status: 200 });
      vi.spyOn(response, "json").mockImplementation(() => rejectWhenAborted(bodySignal));
      return response;
    });

    const startedAt = Date.now();
    await expect(
      runGatewaySuspensionPreRestartClient(
        {
          statePath: "/tmp/unused-gateway-network-state.json",
          token: "x",
          url: "ws://127.0.0.1:12345",
          timeoutMs: 25,
        },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(bodySignal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("/healthz");
  });

  it("bounds a stalled post-restart admin request by the client deadline", async () => {
    const workDir = tempDirs.make("openclaw-gateway-network-post-restart-");
    const statePath = join(workDir, "suspension.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        requestId: "gateway-network-restart-contract",
        suspensionId: "lease-before-restart",
        expiresAtMs: Date.now() + 10_000,
      }),
    );
    let requestSignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      requestSignal = init?.signal;
      return rejectWhenAborted(requestSignal);
    });

    const startedAt = Date.now();
    await expect(
      runGatewaySuspensionPostRestartClient(
        {
          statePath,
          token: "x",
          url: "ws://127.0.0.1:12345",
          timeoutMs: 25,
        },
        { fetchImpl },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
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
          predicate: (frame: GatewayFrame) => boolean,
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
      { token: "test-token", url: "ws://127.0.0.1:12345", timeoutMs: 1000 },
      harness.deps,
    );

    expect(harness.sentMethods).toEqual(["connect", "health"]);
    expect(harness.stdout).toEqual(["ok"]);
    expect(harness.closeCount).toBe(1);
  });

  it("bounds socket and frame waits by the client deadline", async () => {
    const harness = createNetworkClientHarness([{ ok: true }, healthResponse()]);
    const openSocket = vi.fn(harness.deps.openSocket);
    const onceFrameMock = vi.fn(harness.deps.onceFrame);

    await runGatewayNetworkClient(
      { token: "test-token", url: "ws://127.0.0.1:12345", timeoutMs: 250 },
      {
        ...harness.deps,
        onceFrame: onceFrameMock,
        openSocket,
      },
    );

    const openSocketCalls = openSocket.mock.calls as unknown as Array<[unknown, number]>;
    const onceFrameCalls = onceFrameMock.mock.calls as unknown as Array<[unknown, unknown, number]>;
    expect(openSocketCalls[0]?.[1]).toBeGreaterThan(0);
    expect(openSocketCalls[0]?.[1]).toBeLessThanOrEqual(250);
    expect(onceFrameCalls.map((call) => call[2])).toHaveLength(2);
    for (const frameTimeoutMs of onceFrameCalls.map((call) => call[2])) {
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
          { token: "test-token", url: "ws://127.0.0.1:12345", timeoutMs: 250 },
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
        { token: "test-token", url: "ws://127.0.0.1:12345", timeoutMs: 1000 },
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
        { token: "test-token", url: "ws://127.0.0.1:12345", timeoutMs: 1000 },
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
