// Interactive surface auth tests document token precedence for remote gateway
// surfaces that need browser or control-UI access.
import { describe, expect, it } from "vitest";
import type { GatewayRemoteConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayInteractiveSurfaceAuth } from "./auth-surface-resolution.js";

function remoteGatewayConfig(remote?: GatewayRemoteConfig): OpenClawConfig {
  return {
    gateway: {
      mode: "remote",
      remote: {
        url: "wss://remote.example/ws",
        ...remote,
      },
    },
  };
}

describe("resolveGatewayInteractiveSurfaceAuth", () => {
  it("keeps configured local password ahead of OPENCLAW_GATEWAY_PASSWORD", async () => {
    await expect(
      resolveGatewayInteractiveSurfaceAuth({
        config: {
          gateway: {
            mode: "local",
            auth: { mode: "password", password: "config-password" }, // pragma: allowlist secret
          },
        },
        env: { OPENCLAW_GATEWAY_PASSWORD: "env-password" }, // pragma: allowlist secret
        surface: "local",
      }),
    ).resolves.toEqual({
      token: undefined,
      password: "config-password", // pragma: allowlist secret
      failureReason: undefined,
    });
  });

  it("falls back to OPENCLAW_GATEWAY_PASSWORD without configured local password", async () => {
    await expect(
      resolveGatewayInteractiveSurfaceAuth({
        config: { gateway: { mode: "local", auth: { mode: "password" } } },
        env: { OPENCLAW_GATEWAY_PASSWORD: "env-password" }, // pragma: allowlist secret
        surface: "local",
      }),
    ).resolves.toEqual({
      token: undefined,
      password: "env-password", // pragma: allowlist secret
      failureReason: undefined,
    });
  });

  it("uses OPENCLAW_GATEWAY_TOKEN as remote interactive fallback", async () => {
    await expect(
      resolveGatewayInteractiveSurfaceAuth({
        config: remoteGatewayConfig(),
        env: {
          OPENCLAW_GATEWAY_TOKEN: "env-token",
        },
        surface: "remote",
      }),
    ).resolves.toEqual({
      token: "env-token",
      password: undefined,
    });
  });

  it("keeps configured remote token ahead of OPENCLAW_GATEWAY_TOKEN", async () => {
    await expect(
      resolveGatewayInteractiveSurfaceAuth({
        config: remoteGatewayConfig({ token: "remote-token" }),
        env: {
          OPENCLAW_GATEWAY_TOKEN: "env-token",
        },
        surface: "remote",
      }),
    ).resolves.toEqual({
      token: "remote-token",
      password: undefined,
    });
  });

  it("falls back to OPENCLAW_GATEWAY_TOKEN when the remote token ref is unresolved", async () => {
    await expect(
      resolveGatewayInteractiveSurfaceAuth({
        config: {
          ...remoteGatewayConfig({
            token: { source: "env", provider: "default", id: "MISSING_REMOTE_TOKEN" },
          }),
        },
        env: {
          OPENCLAW_GATEWAY_TOKEN: "env-token",
        },
        surface: "remote",
      }),
    ).resolves.toEqual({
      token: "env-token",
      password: undefined,
    });
  });
});
