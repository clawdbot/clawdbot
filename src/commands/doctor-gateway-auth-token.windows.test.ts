// Windows Doctor service-token tests cover detailed SecretRef diagnostic rendering.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  resolveGatewayAuthToken: vi.fn(),
}));

vi.mock("../gateway/auth-token-resolution.js", () => ({
  resolveGatewayAuthToken: mocks.resolveGatewayAuthToken,
}));

const { resolveGatewayAuthTokenForService } = await import("./doctor-gateway-auth-token.js");

describe("resolveGatewayAuthTokenForService Windows diagnostics", () => {
  beforeEach(() => {
    mocks.resolveGatewayAuthToken.mockReset();
  });

  it("preserves the detailed path-free ACL recovery from the canonical resolver", async () => {
    const privateCommand = String.raw`C:\private\gateway-token-provider.cmd`;
    const recovery =
      "Windows path security could not be verified. Restore Windows path security verification, or use an existing provider command whose owner and ACLs OpenClaw can verify.";
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          token: {
            source: "exec",
            provider: "execmain",
            id: "gateway/token",
          },
        },
      },
      secrets: {
        providers: {
          execmain: {
            source: "exec",
            command: privateCommand,
          },
        },
      },
    };
    const env = {} as NodeJS.ProcessEnv;
    mocks.resolveGatewayAuthToken.mockResolvedValue({
      secretRefConfigured: true,
      unresolvedRefReason: recovery,
    });

    const resolved = await resolveGatewayAuthTokenForService(cfg, env, {
      allowExecSecretRefs: true,
    });

    expect(resolved).toEqual({
      unavailableReason: `gateway.auth.token SecretRef is configured but unresolved (${recovery}).`,
    });
    expect(resolved.unavailableReason).not.toContain(privateCommand);
    expect(mocks.resolveGatewayAuthToken).toHaveBeenCalledWith({
      cfg,
      env,
      unresolvedReasonStyle: "detailed",
    });
  });
});
