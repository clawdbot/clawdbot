import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayTransportError } from "../../gateway/transport-error.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

const { refreshRunningGatewayAuthState } = await import("./auth-refresh.js");

describe("refreshRunningGatewayAuthState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stays silent when no gateway is listening", async () => {
    mocks.callGateway.mockRejectedValueOnce(
      new GatewayTransportError({
        kind: "closed",
        message: "gateway unreachable",
        reason: "connect ECONNREFUSED 127.0.0.1:18789",
        connectionDetails: {
          url: "ws://127.0.0.1:18789",
          urlSource: "local loopback",
          message: "Local target",
        },
      }),
    );
    const warn = vi.fn();

    await expect(refreshRunningGatewayAuthState("main", { error: warn })).resolves.toBe(
      "unavailable",
    );

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ requireLocalBackendSharedAuth: true }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when a running gateway rejects the auth refresh", async () => {
    mocks.callGateway.mockImplementationOnce(async (options: { onHelloOk?: () => void }) => {
      options.onHelloOk?.();
      throw new Error("refresh rejected");
    });
    const warn = vi.fn();

    await expect(refreshRunningGatewayAuthState("main", { error: warn })).resolves.toBe("failed");

    expect(warn).toHaveBeenCalledWith(
      "Warning: Model auth changes were saved, but the running gateway could not refresh them. Run `openclaw gateway restart` to apply the saved changes.",
    );
  });
});
