// Gateway health route tests cover the machine-readable fast path and its error contract.
import { describe, expect, it, vi } from "vitest";
import { runGatewayHealthJsonRoute } from "./health-route.js";

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  };
}

describe("runGatewayHealthJsonRoute", () => {
  it("writes successful JSON without loading error-only dependencies", async () => {
    const runtime = createRuntime();
    const callGateway = vi.fn(async () => ({ ok: true, durationMs: 6 }));
    const readBestEffortConfig = vi.fn(async () => ({}));
    const emitReachableGatewayAuthDiagnostic = vi.fn(async () => false);
    const formatGatewayAuthErrorJson = vi.fn();
    const formatGatewayClientRequestErrorJson = vi.fn();
    const formatGatewayTransportErrorJson = vi.fn();

    await runGatewayHealthJsonRoute(
      {
        rpc: { json: true, timeout: "10000" },
      },
      runtime as never,
      {
        callGateway,
        readBestEffortConfig,
        emitReachableGatewayAuthDiagnostic: emitReachableGatewayAuthDiagnostic as never,
        formatGatewayAuthErrorJson: formatGatewayAuthErrorJson as never,
        formatGatewayClientRequestErrorJson: formatGatewayClientRequestErrorJson as never,
        formatGatewayTransportErrorJson: formatGatewayTransportErrorJson as never,
      },
    );

    expect(callGateway).toHaveBeenCalledWith(
      "health",
      { json: true, timeout: "10000" },
      undefined,
      { defaultTimeoutMs: 10_000 },
    );
    expect(runtime.writeJson).toHaveBeenCalledWith({ ok: true, durationMs: 6 }, 2);
    expect(readBestEffortConfig).not.toHaveBeenCalled();
    expect(emitReachableGatewayAuthDiagnostic).not.toHaveBeenCalled();
    expect(formatGatewayAuthErrorJson).not.toHaveBeenCalled();
    expect(formatGatewayClientRequestErrorJson).not.toHaveBeenCalled();
    expect(formatGatewayTransportErrorJson).not.toHaveBeenCalled();
  });

  it("projects a local port into the routed config", async () => {
    const runtime = createRuntime();
    const callGateway = vi.fn(async () => ({ ok: true }));
    const readBestEffortConfig = vi.fn(async () => ({
      gateway: { auth: { mode: "token" as const } },
    }));

    await runGatewayHealthJsonRoute(
      {
        rpc: { json: true, timeout: "10000" },
        localPortOverride: 19083,
      },
      runtime as never,
      { callGateway, readBestEffortConfig },
    );

    expect(callGateway).toHaveBeenCalledWith(
      "health",
      expect.objectContaining({
        localPortOverride: 19083,
        config: {
          gateway: { auth: { mode: "token" }, mode: "local", port: 19083 },
        },
      }),
      undefined,
      { defaultTimeoutMs: 10_000 },
    );
  });

  it("formats local config resolution failures", async () => {
    const runtime = createRuntime();
    const error = new Error("config unavailable");
    const callGateway = vi.fn();

    await runGatewayHealthJsonRoute(
      {
        rpc: { json: true, timeout: "10000" },
        localPortOverride: 19083,
      },
      runtime as never,
      {
        callGateway,
        readBestEffortConfig: vi.fn(async () => {
          throw error;
        }),
      },
    );

    expect(callGateway).not.toHaveBeenCalled();
    expect(runtime.writeJson).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(error.message);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("preserves structured transport errors", async () => {
    const runtime = createRuntime();
    const error = new Error("gateway unavailable");
    const callGateway = vi.fn(async () => {
      throw error;
    });
    const payload = { ok: false, error: { type: "gateway_transport_error" } };

    await runGatewayHealthJsonRoute({ rpc: { json: true, timeout: "10000" } }, runtime as never, {
      callGateway,
      readBestEffortConfig: async () => ({}),
      emitReachableGatewayAuthDiagnostic: vi.fn(async () => false) as never,
      formatGatewayAuthErrorJson: vi.fn(() => null) as never,
      formatGatewayClientRequestErrorJson: vi.fn(() => null) as never,
      formatGatewayTransportErrorJson: vi.fn(() => payload) as never,
    });

    expect(runtime.writeJson).toHaveBeenCalledWith(payload, 2);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("preserves structured auth errors when reachability is unknown", async () => {
    const runtime = createRuntime();
    const error = new Error("gateway health requires credentials");
    const callGateway = vi.fn(async () => {
      throw error;
    });
    const payload = {
      ok: false,
      error: {
        type: "gateway_credentials_required",
        message: "gateway health requires credentials",
      },
    };
    const formatGatewayAuthErrorJson = vi.fn(() => payload);
    const formatGatewayClientRequestErrorJson = vi.fn(() => null);
    const formatGatewayTransportErrorJson = vi.fn(() => null);

    await runGatewayHealthJsonRoute({ rpc: { json: true, timeout: "10000" } }, runtime as never, {
      callGateway,
      readBestEffortConfig: async () => ({}),
      emitReachableGatewayAuthDiagnostic: vi.fn(async () => false) as never,
      formatGatewayAuthErrorJson: formatGatewayAuthErrorJson as never,
      formatGatewayClientRequestErrorJson: formatGatewayClientRequestErrorJson as never,
      formatGatewayTransportErrorJson: formatGatewayTransportErrorJson as never,
    });

    expect(formatGatewayAuthErrorJson).toHaveBeenCalledWith(error);
    expect(formatGatewayClientRequestErrorJson).not.toHaveBeenCalled();
    expect(formatGatewayTransportErrorJson).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledWith(payload, 2);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
