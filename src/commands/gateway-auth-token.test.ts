import { beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayAuthTokenCommand } from "./gateway-auth-token.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
  writeJson: vi.fn(),
  writeStdout: vi.fn(),
};

describe("gatewayAuthTokenCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      sourceConfig: {
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "GATEWAY_TOKEN" },
          },
        },
      },
      config: {},
    });
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: {
        gateway: { auth: { mode: "token", token: "resolved-value" } },
      },
      diagnostics: [],
      targetStatesByPath: { "gateway.auth.token": "resolved_gateway" },
      hadUnresolvedTargets: false,
    });
  });

  it("prints only the resolved token for an interactive operator", async () => {
    const env = { OPENCLAW_GATEWAY_TOKEN: "environment-value" };

    await gatewayAuthTokenCommand(runtime, { env, interactive: true });

    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalledWith({
      config: {
        gateway: {
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "GATEWAY_TOKEN" },
          },
        },
      },
      commandName: "gateway auth-token",
      targetIds: new Set(["gateway.auth.token"]),
      mode: "enforce_resolved",
      allowedPaths: new Set(["gateway.auth.token"]),
    });
    expect(runtime.writeStdout).toHaveBeenCalledWith("resolved-value\n");
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("refuses non-interactive output before reading config or secrets", async () => {
    await expect(gatewayAuthTokenCommand(runtime, { interactive: false })).rejects.toThrow(
      "outside an interactive terminal",
    );

    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
    expect(runtime.writeStdout).not.toHaveBeenCalled();
  });

  it("fails actionably when no configured token is available", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      sourceConfig: { gateway: { auth: { mode: "token" } } },
      config: {},
    });
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: { gateway: { auth: { mode: "token" } } },
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    });

    await expect(gatewayAuthTokenCommand(runtime, { env: {}, interactive: true })).rejects.toThrow(
      "openclaw doctor --generate-gateway-token",
    );

    expect(runtime.writeStdout).not.toHaveBeenCalled();
  });

  it("does not fall back to ambient env when the configured SecretRef is unresolved", async () => {
    mocks.resolveCommandSecretRefsViaGateway.mockRejectedValue(
      new Error("gateway.auth.token SecretRef is unresolved"),
    );

    await expect(
      gatewayAuthTokenCommand(runtime, {
        interactive: true,
        env: { OPENCLAW_GATEWAY_TOKEN: "ambient-fallback" },
      }),
    ).rejects.toThrow("gateway.auth.token SecretRef is unresolved");

    expect(runtime.writeStdout).not.toHaveBeenCalled();
  });

  it.each(["password", "none", "trusted-proxy"] as const)(
    "refuses an inactive token when auth mode is %s",
    async (mode) => {
      mocks.readConfigFileSnapshot.mockResolvedValue({
        valid: true,
        sourceConfig: {
          gateway: { auth: { mode, token: "stale-token", password: "active-password" } },
        },
        config: {},
      });

      await expect(gatewayAuthTokenCommand(runtime, { interactive: true })).rejects.toThrow(
        `Gateway auth mode is ${mode}`,
      );

      expect(mocks.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
      expect(runtime.writeStdout).not.toHaveBeenCalled();
    },
  );

  it("requires an explicit mode when token and password are both configured", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      sourceConfig: {
        gateway: { auth: { token: "candidate-token", password: "candidate-password" } },
      },
      config: {},
    });

    await expect(gatewayAuthTokenCommand(runtime, { interactive: true })).rejects.toThrow(
      "gateway.auth.mode",
    );

    expect(mocks.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
    expect(runtime.writeStdout).not.toHaveBeenCalled();
  });

  it("does not reveal a configured token when an environment password selects password auth", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      sourceConfig: { gateway: { auth: { token: "inactive-token" } } },
      config: {},
    });

    await expect(
      gatewayAuthTokenCommand(runtime, {
        interactive: true,
        env: { OPENCLAW_GATEWAY_PASSWORD: "active-password" },
      }),
    ).rejects.toThrow("Gateway auth mode is password");

    expect(mocks.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
    expect(runtime.writeStdout).not.toHaveBeenCalled();
  });

  it("refuses to recover credentials from a remote-client config", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      sourceConfig: {
        gateway: { mode: "remote", auth: { mode: "token", token: "stale-local-token" } },
      },
      config: {},
    });

    await expect(gatewayAuthTokenCommand(runtime, { interactive: true })).rejects.toThrow(
      "must run on the Gateway host",
    );

    expect(mocks.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
    expect(runtime.writeStdout).not.toHaveBeenCalled();
  });
});
