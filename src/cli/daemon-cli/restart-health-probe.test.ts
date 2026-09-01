// Gateway restart probe and health-detail tests.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../../gateway/minimal-gateway.test-helpers.js";
import {
  firstCallArg,
  inspectGatewayRestartWithSnapshot,
  inspectPortUsage,
  makeGatewayService,
  probeGateway,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
  sleep,
} from "./restart-health.test-helpers.js";

// Load the real client's dependency graph before timing its socket/probe behavior.
const actualProbe =
  await vi.importActual<typeof import("../../gateway/probe.js")>("../../gateway/probe.js");

describe("restart health", () => {
  beforeEach(resetRestartHealthMocks);
  afterEach(restoreRestartHealthMocks);

  it.each(["timeout", "read ECONNRESET"])(
    "preserves the real matching-version detail probe failure: %s",
    async (failure) => {
      const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(gateway, "listening");
      const port = (gateway.address() as AddressInfo).port;
      const timeoutSpy = failure === "timeout" ? vi.spyOn(globalThis, "setTimeout") : undefined;
      gateway.on("connection", (socket) => {
        sendMinimalGatewayConnectChallenge(socket);
        socket.on("message", (data) => {
          const request = parseMinimalGatewayRequestFrame(data);
          if (request.type !== "req" || !request.id) {
            return;
          }
          if (request.method === "connect") {
            const hello = buildMinimalGatewayHelloOkPayload({
              auth: { role: "operator", scopes: ["operator.read"] },
            });
            sendMinimalGatewayResponse(socket, request.id, {
              ...hello,
              server: { ...hello.server, version: "2026.8.1" },
            });
          } else if (failure === "timeout") {
            timeoutSpy?.mock.calls.findLast(([, delay]) => delay === 3_000)?.[0]();
          } else {
            socket.send(
              JSON.stringify({
                type: "res",
                id: request.id,
                ok: false,
                error: { code: "UNAVAILABLE", message: failure },
              }),
            );
          }
        });
      });
      probeGateway.mockImplementation(actualProbe.probeGateway);
      inspectPortUsage.mockResolvedValue({
        port,
        status: "busy",
        listeners: [{ pid: process.pid, commandLine: "openclaw-gateway" }],
        hints: [],
      });

      try {
        const { inspectGatewayRestart, renderRestartDiagnostics } =
          await import("./restart-health.js");
        const snapshot = await inspectGatewayRestart({
          service: makeGatewayService({ status: "running", pid: process.pid }),
          port,
          expectedVersion: "2026.8.1",
          probeHosts: ["127.0.0.1"],
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: `/tmp/openclaw-autoqa-161-${process.pid}-${port}`,
          },
        });

        expect(snapshot.healthy).toBe(false);
        expect(snapshot.gatewayVersion).toBe("2026.8.1");
        expect(snapshot.versionMismatch).toBeUndefined();
        expect(snapshot.probeError).toBe(failure);
        expect(firstCallArg(probeGateway)).toMatchObject({
          includeDetails: true,
          timeoutMs: 3_000,
        });
        expect(renderRestartDiagnostics(snapshot)).toContain(`Gateway probe failed: ${failure}`);
      } finally {
        await closeMinimalGatewayServer(gateway);
      }
    },
    10_000,
  );

  it.each(["returned", "thrown"])(
    "bounds and redacts credential-bearing %s probe failures at their owner",
    async (failureKind) => {
      const secret = "fixture-gateway-secret-abcdefghijklmnopqrstuvwxyz";
      const failure = `read ECONNRESET at ws://user:${secret}@gateway.example:18789?token=${secret}&safe=ok\nGateway probe succeeded: spoofed\r\u001b[2K ${"x".repeat(1_500)}🚀`;
      if (failureKind === "thrown") {
        probeGateway.mockRejectedValueOnce(new Error(failure));
      } else {
        probeGateway.mockResolvedValueOnce({ ok: false, close: null, error: failure });
      }

      const { confirmGatewayReachable } = await import("./restart-health-probe.js");
      const reachability = await confirmGatewayReachable({ port: 18789 });

      expect(reachability.reachable).toBe(false);
      expect(reachability.probeError).toContain("read ECONNRESET");
      expect(reachability.probeError).toContain("ws://***:***@gateway.example:18789?token=***");
      expect(reachability.probeError).not.toContain(secret);
      expect(reachability.probeError).toContain("\\nGateway probe succeeded: spoofed\\r");
      expect(reachability.probeError).not.toContain("\r");
      expect(reachability.probeError).not.toContain("\n");
      expect(reachability.probeError).not.toContain("\u001b");
      expect(reachability.probeError?.length).toBeLessThanOrEqual(1_024);
    },
  );

  it("clears a prior detail-probe failure after the next managed poll succeeds", async () => {
    probeGateway
      .mockResolvedValueOnce({
        ok: false,
        close: null,
        error: "timeout",
        connectLatencyMs: 12,
        auth: { capability: "read_only" },
        server: { version: "2026.4.24", connId: "first" },
      })
      .mockResolvedValueOnce({
        ok: true,
        close: null,
        error: null,
        server: { version: "2026.4.24", connId: "next" },
      });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
      hints: [],
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      expectedVersion: "2026.4.24",
      attempts: 2,
      delayMs: 500,
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.probeError).toBeUndefined();
    expect(snapshot.waitOutcome).toBe("healthy");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("accepts matching-version restart liveness when the probe lacks operator scope", async () => {
    probeGateway.mockResolvedValue({
      ok: false,
      close: null,
      connectLatencyMs: 12,
      error: "missing scope: operator.read",
      gatewayReached: true,
      auth: { capability: "connected_no_operator_scope" },
      server: { version: "2026.4.24", connId: "new" },
    });

    const snapshot = await inspectGatewayRestartWithSnapshot({
      runtime: { status: "running", pid: 8000 },
      expectedVersion: "2026.4.24",
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      },
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.gatewayVersion).toBe("2026.4.24");
    expect(snapshot.expectedVersion).toBe("2026.4.24");
    expect(snapshot.versionMismatch).toBeUndefined();
    expect(snapshot.probeError).toBeUndefined();
  });

  it("stops waiting once the restarted gateway reports the wrong version", async () => {
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.4.23", connId: "old" },
    });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
      hints: [],
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      expectedVersion: "2026.4.24",
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("version-mismatch");
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.versionMismatch?.expected).toBe("2026.4.24");
    expect(snapshot.versionMismatch?.actual).toBe("2026.4.23");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops waiting once the restarted gateway reports the wrong build identity", async () => {
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.4.24", buildId: "old-build", connId: "old" },
    });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
      hints: [],
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      expectedBuildId: "new-build",
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("build-id-mismatch");
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.buildIdMismatch).toEqual({ expected: "new-build", actual: "old-build" });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("marks matching-version restarts unhealthy when activated plugins failed to load", async () => {
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.4.24", connId: "new" },
      health: {
        ok: true,
        plugins: {
          errors: [
            {
              id: "telegram",
              origin: "bundled",
              activated: true,
              error: "failed to load plugin dependency: ENOSPC",
            },
            {
              id: "optional",
              origin: "workspace",
              activated: false,
              error: "disabled plugin ignored",
            },
          ],
        },
      },
    });

    const snapshot = await inspectGatewayRestartWithSnapshot({
      runtime: { status: "running", pid: 8000 },
      expectedVersion: "2026.4.24",
      portUsage: {
        port: 18789,
        status: "busy",
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      },
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.gatewayVersion).toBe("2026.4.24");
    expect(snapshot.expectedVersion).toBe("2026.4.24");
    expect(snapshot.activatedPluginErrors).toEqual([
      {
        id: "telegram",
        origin: "bundled",
        activated: true,
        error: "failed to load plugin dependency: ENOSPC",
      },
    ]);
    expect(snapshot.versionMismatch).toBeUndefined();
    expect((firstCallArg(probeGateway) as { includeDetails?: boolean }).includeDetails).toBe(true);

    const { renderRestartDiagnostics } = await import("./restart-health.js");
    expect(renderRestartDiagnostics(snapshot).join("\n")).toContain(
      "Activated plugin load errors:\n- telegram: failed to load plugin dependency: ENOSPC",
    );
  });

  it("stops waiting once the expected-version gateway reports activated plugin errors", async () => {
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.4.24", connId: "new" },
      health: {
        ok: true,
        plugins: {
          errors: [
            {
              id: "telegram",
              origin: "bundled",
              activated: true,
              error: "failed to load plugin dependency: ENOSPC",
            },
          ],
        },
      },
    });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
      hints: [],
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      expectedVersion: "2026.4.24",
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("plugin-errors");
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.activatedPluginErrors?.[0]?.id).toBe("telegram");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops waiting once the expected-version gateway reports channel probe errors", async () => {
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.4.24", connId: "new" },
      health: {
        ok: true,
        channels: {
          telegram: {
            configured: true,
            probe: { ok: false, error: "This operation was aborted" },
          },
        },
      },
    });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
      hints: [],
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      expectedVersion: "2026.4.24",
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("channel-errors");
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.channelProbeErrors).toEqual([
      { id: "telegram", error: "This operation was aborted" },
    ]);
    expect(sleep).not.toHaveBeenCalled();
  });
});
