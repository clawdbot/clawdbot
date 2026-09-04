import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayLocalBackendSharedAuthUnavailableError } from "../../gateway/call.js";
import { GatewayTransportError } from "../../gateway/transport-error.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  isImplicitLocalGatewayTarget: vi.fn(),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
  GatewayLocalBackendSharedAuthUnavailableError: class extends Error {},
  isImplicitLocalGatewayTarget: mocks.isImplicitLocalGatewayTarget,
}));

const { refreshRunningGatewayAuthState } = await import("./auth-refresh.js");

describe("refreshRunningGatewayAuthState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isImplicitLocalGatewayTarget.mockResolvedValue(true);
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

    await expect(refreshRunningGatewayAuthState("main", { error: warn })).resolves.toBeUndefined();

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

    await expect(refreshRunningGatewayAuthState("main", { error: warn })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "Warning: Model auth changes were saved, but the running Gateway could not refresh them. Run `openclaw gateway restart` to apply the saved changes.",
    );
  });

  it("warns when the gateway cannot publish refreshed auth state", async () => {
    mocks.callGateway.mockImplementationOnce(async (options: { onHelloOk?: () => void }) => {
      options.onHelloOk?.();
      return {
        unavailable: {
          code: "PREPARED_MODEL_AUTH_UNAVAILABLE",
          message: "replacement unavailable",
        },
      };
    });
    const warn = vi.fn();

    await expect(refreshRunningGatewayAuthState("main", { error: warn })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "Warning: Model auth changes were saved, but the running Gateway could not refresh them. Run `openclaw gateway restart` to apply the saved changes.",
    );
  });

  it("directs remote clients to run auth changes on the gateway host", async () => {
    mocks.isImplicitLocalGatewayTarget.mockResolvedValueOnce(false);
    mocks.callGateway.mockRejectedValueOnce(
      new GatewayLocalBackendSharedAuthUnavailableError(
        "local backend shared auth is limited to the configured local gateway",
      ),
    );
    const warn = vi.fn();

    await expect(refreshRunningGatewayAuthState("main", { error: warn })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "Warning: Model auth changes were saved on this host, but the configured Gateway does not share this auth state. Run the auth command on the Gateway host (the far end of any SSH tunnel).",
    );
  });

  it("does not guess a restart host when target classification fails", async () => {
    mocks.isImplicitLocalGatewayTarget.mockRejectedValueOnce(new Error("invalid config"));
    const warn = vi.fn();

    await expect(refreshRunningGatewayAuthState("main", { error: warn })).resolves.toBeUndefined();

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "Warning: Model auth changes were saved, but the configured Gateway could not be identified or refreshed. Apply the auth change on the Gateway host, or restart it there.",
    );
  });
});
