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

import { probeGatewayMemoryStatus } from "./doctor-gateway-health.js";

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
    });

    expect(callGateway).toHaveBeenCalledWith({
      method: "doctor.memory.status",
      params: { probe: false },
      timeoutMs: 1234,
      config: cfg,
    });
  });

  it("treats outer gateway timeouts as inconclusive", async () => {
    callGateway.mockRejectedValue(
      new Error("gateway timeout after 8000ms\nGateway target: ws://127.0.0.1:18789"),
    );

    await expect(probeGatewayMemoryStatus({ cfg })).resolves.toEqual({
      checked: false,
      ready: false,
      error: expect.stringContaining("gateway memory probe timed out"),
    });
  });

  it("keeps gateway request timeouts as explicit failures", async () => {
    callGateway.mockRejectedValue(new Error("gateway request timeout for doctor.memory.status"));

    await expect(probeGatewayMemoryStatus({ cfg })).resolves.toEqual({
      checked: true,
      ready: false,
      error: "gateway memory probe unavailable: gateway request timeout for doctor.memory.status",
    });
  });

  it("keeps non-timeout gateway errors as explicit failures", async () => {
    callGateway.mockRejectedValue(new Error("gateway closed (1006): no close reason"));

    await expect(probeGatewayMemoryStatus({ cfg })).resolves.toEqual({
      checked: true,
      ready: false,
      error: "gateway memory probe unavailable: gateway closed (1006): no close reason",
    });
  });
});
