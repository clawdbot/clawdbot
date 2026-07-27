import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ callGatewayFromCli: vi.fn() }));

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  callGatewayFromCli: mocks.callGatewayFromCli,
}));

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as RuntimeEnv["exit"],
  };
}

describe("verifyBuzzAfterSetup", () => {
  beforeEach(() => {
    mocks.callGatewayFromCli.mockReset();
  });

  it("verifies authenticated Buzz membership without sending a message", async () => {
    mocks.callGatewayFromCli
      .mockResolvedValueOnce({
        appliedConfigHash: "saved",
        configRevisionHash: "saved",
      })
      .mockResolvedValueOnce({
        channelAccounts: {
          buzz: [
            {
              accountId: "default",
              probe: {
                ok: true,
                rooms: [{ id: "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c" }],
              },
            },
          ],
        },
      });
    const runtime = createRuntime();
    const { verifyBuzzAfterSetup } = await import("./setup-verify.js");

    await verifyBuzzAfterSetup({
      accountId: "default",
      target: "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c",
      runtime,
    });

    expect(mocks.callGatewayFromCli).toHaveBeenCalledTimes(2);
    expect(mocks.callGatewayFromCli.mock.calls[0]?.[0]).toBe("config.get");
    expect(mocks.callGatewayFromCli.mock.calls[1]?.[0]).toBe("channels.status");
    expect(mocks.callGatewayFromCli.mock.calls[1]?.[2]).toEqual({
      channel: "buzz",
      probe: true,
      timeoutMs: 10_000,
    });
    expect(mocks.callGatewayFromCli).not.toHaveBeenCalledWith(
      "send",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("reports when the authenticated probe is unavailable", async () => {
    mocks.callGatewayFromCli
      .mockResolvedValueOnce({
        appliedConfigHash: "saved",
        configRevisionHash: "saved",
      })
      .mockResolvedValueOnce({
        channelAccounts: { buzz: [{ accountId: "default" }] },
      });
    const runtime = createRuntime();
    const { verifyBuzzAfterSetup } = await import("./setup-verify.js");

    await verifyBuzzAfterSetup({
      accountId: "default",
      target: "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c",
      runtime,
    });

    expect(mocks.callGatewayFromCli).toHaveBeenCalledTimes(2);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("did not confirm authenticated membership"),
    );
  });

  it("prints the exact start command when the Gateway is stopped", async () => {
    mocks.callGatewayFromCli.mockRejectedValue(
      Object.assign(new Error("gateway closed (1006): no listener"), {
        name: "GatewayTransportError",
        kind: "closed",
        code: 1006,
      }),
    );
    const runtime = createRuntime();
    const { verifyBuzzAfterSetup } = await import("./setup-verify.js");

    await verifyBuzzAfterSetup({
      accountId: "default",
      target: "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c",
      runtime,
    });

    expect(runtime.log).toHaveBeenCalledWith(
      "Buzz config was saved. Start OpenClaw to connect: openclaw gateway",
    );
  });

  it("keeps the verification error for an unrelated abnormal Gateway closure", async () => {
    mocks.callGatewayFromCli.mockRejectedValue(
      Object.assign(new Error("gateway connection dropped during verification"), {
        name: "GatewayTransportError",
        kind: "closed",
        code: 1006,
      }),
    );
    const runtime = createRuntime();
    const { verifyBuzzAfterSetup } = await import("./setup-verify.js");

    await verifyBuzzAfterSetup({
      accountId: "default",
      target: "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c",
      runtime,
    });

    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("post-setup verification did not complete"),
    );
  });
});
