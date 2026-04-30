import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const callGateway = vi.hoisted(() => vi.fn());

vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: vi.fn(() => ({
    message: "Gateway target: ws://127.0.0.1:18789",
  })),
  callGateway,
}));

vi.mock("./health.js", () => ({
  healthCommand: vi.fn(),
}));

import { checkGatewayHealth, probeGatewayMemoryStatus } from "./doctor-gateway-health.js";

describe("checkGatewayHealth", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    callGateway.mockReset();
  });

  it("uses a lightweight status RPC for the restart liveness gate", async () => {
    callGateway.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({});
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await expect(
      checkGatewayHealth({ runtime: runtime as never, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({ healthOk: true });

    expect(callGateway).toHaveBeenNthCalledWith(1, {
      method: "status",
      params: { includeChannelSummary: false },
      timeoutMs: 3000,
      config: cfg,
    });
    expect(callGateway).toHaveBeenNthCalledWith(2, {
      method: "channels.status",
      params: { probe: true, timeoutMs: 5000 },
      timeoutMs: 6000,
    });
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("does not run follow-up channel probes when liveness fails", async () => {
    callGateway.mockRejectedValueOnce(new Error("gateway timeout after 3000ms"));
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await expect(
      checkGatewayHealth({ runtime: runtime as never, cfg, timeoutMs: 3000 }),
    ).resolves.toEqual({ healthOk: false });

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Health check failed: Error: gateway timeout after 3000ms"),
    );
  });
});

describe("probeGatewayMemoryStatus", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    callGateway.mockReset();
  });

  it("requests cached memory status without a live embedding probe", async () => {
    callGateway.mockResolvedValue({ embedding: { ok: true } });

    await expect(probeGatewayMemoryStatus({ cfg, timeoutMs: 1234 })).resolves.toEqual({
      checked: true,
      ready: true,
      error: undefined,
      skipped: false,
    });

    expect(callGateway).toHaveBeenCalledWith({
      method: "doctor.memory.status",
      params: { probe: false },
      timeoutMs: 1234,
      config: cfg,
    });
  });

  it("treats outer gateway timeouts as inconclusive (skipped: false)", async () => {
    // A transport timeout must NOT be treated as a skipped probe. It is a real
    // diagnostic signal and the renderer should warn for key-optional providers.
    callGateway.mockRejectedValue(
      new Error("gateway timeout after 8000ms\nGateway target: ws://127.0.0.1:18789"),
    );

    await expect(probeGatewayMemoryStatus({ cfg })).resolves.toEqual({
      checked: false,
      ready: false,
      error: expect.stringContaining("gateway memory probe timed out"),
      skipped: false,
    });
  });

  it("propagates checked: false and skipped: true when gateway skipped the embedding probe", async () => {
    // Gateway returns checked: false when called with probe: false and no cached
    // availability data (SKIPPED_MEMORY_EMBEDDING_PROBE shape). The adapter must
    // also set skipped: true so renderers can distinguish this from a transport
    // timeout (which also returns checked: false but skipped: false).
    callGateway.mockResolvedValue({
      embedding: {
        ok: false,
        checked: false,
        error:
          "memory embedding readiness not checked; run `openclaw memory status --deep` to probe",
      },
    });

    await expect(probeGatewayMemoryStatus({ cfg })).resolves.toEqual({
      checked: false,
      ready: false,
      error: expect.stringContaining("not checked"),
      skipped: true,
    });
  });

  it("keeps gateway request timeouts as explicit failures", async () => {
    callGateway.mockRejectedValue(new Error("gateway request timeout for doctor.memory.status"));

    await expect(probeGatewayMemoryStatus({ cfg })).resolves.toEqual({
      checked: true,
      ready: false,
      error: "gateway memory probe unavailable: gateway request timeout for doctor.memory.status",
      skipped: false,
    });
  });

  it("keeps non-timeout gateway errors as explicit failures", async () => {
    callGateway.mockRejectedValue(new Error("gateway closed (1006): no close reason"));

    await expect(probeGatewayMemoryStatus({ cfg })).resolves.toEqual({
      checked: true,
      ready: false,
      error: "gateway memory probe unavailable: gateway closed (1006): no close reason",
      skipped: false,
    });
  });
});
