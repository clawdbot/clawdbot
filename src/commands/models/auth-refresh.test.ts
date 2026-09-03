import { beforeEach, describe, expect, it, vi } from "vitest";

const callGateway = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway,
  isGatewayClientRequestError: (value: unknown) =>
    value instanceof Error && value.name === "GatewayClientRequestError",
}));

import { refreshRunningGatewayAuthState } from "./auth-refresh.js";

describe("refreshRunningGatewayAuthState", () => {
  beforeEach(() => {
    callGateway.mockReset().mockResolvedValue({ refreshed: true });
  });

  it("routes login refresh through the canonical Gateway mutation owner", async () => {
    await expect(refreshRunningGatewayAuthState("main", "login")).resolves.toBe("refreshed");
    expect(callGateway).toHaveBeenCalledOnce();
    expect(callGateway).toHaveBeenCalledWith({
      method: "models.authRefresh",
      params: { agentId: "main", operation: "login" },
      timeoutMs: 3000,
    });
  });

  it("records an unreachable Gateway without undoing the credential write", async () => {
    callGateway.mockRejectedValueOnce(new Error("gateway unavailable"));

    await expect(refreshRunningGatewayAuthState("main", "login")).resolves.toBe(
      "gateway-unreachable",
    );
  });

  it("distinguishes a rejected refresh from an unreachable Gateway", async () => {
    callGateway.mockRejectedValueOnce(
      Object.assign(new Error("unknown agent"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
        retryable: false,
      }),
    );

    await expect(refreshRunningGatewayAuthState("main", "login")).resolves.toBe("gateway-rejected");
  });
});
