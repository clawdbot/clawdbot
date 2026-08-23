// Unmocked auth-policy coverage for the shared Gateway client bootstrap owner.
import { describe, expect, it } from "vitest";
import type { GatewayRemoteConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayClientBootstrap } from "./client-bootstrap.js";

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

async function expectInteractiveAuth(
  params: { config: OpenClawConfig; env?: NodeJS.ProcessEnv },
  expectedAuth: { token?: string; password?: string },
): Promise<void> {
  const result = await resolveGatewayClientBootstrap({
    config: params.config,
    env: params.env ?? {},
    authPolicy: "interactive",
  });
  expect(result.auth).toEqual(expectedAuth);
  expect(result).not.toHaveProperty("authFailureReason");
}

describe("resolveGatewayClientBootstrap interactive auth policy", () => {
  it("keeps configured local password ahead of OPENCLAW_GATEWAY_PASSWORD", async () => {
    await expectInteractiveAuth(
      {
        config: {
          gateway: {
            mode: "local",
            auth: { mode: "password", password: "local-config-auth-value" }, // pragma: allowlist secret
          },
        },
        env: { OPENCLAW_GATEWAY_PASSWORD: "shell-password-value" }, // pragma: allowlist secret
      },
      {
        token: undefined,
        password: "local-config-auth-value", // pragma: allowlist secret
      },
    );
  });

  it("falls back to OPENCLAW_GATEWAY_PASSWORD without configured local password", async () => {
    await expectInteractiveAuth(
      {
        config: { gateway: { mode: "local", auth: { mode: "password" } } },
        env: { OPENCLAW_GATEWAY_PASSWORD: "shell-password-value" }, // pragma: allowlist secret
      },
      {
        token: undefined,
        password: "shell-password-value", // pragma: allowlist secret
      },
    );
  });

  it("uses OPENCLAW_GATEWAY_TOKEN as remote interactive fallback", async () => {
    await expectInteractiveAuth(
      {
        config: remoteGatewayConfig(),
        env: { OPENCLAW_GATEWAY_TOKEN: "shell-token-value" },
      },
      { token: "shell-token-value", password: undefined },
    );
  });

  it("keeps configured remote token ahead of OPENCLAW_GATEWAY_TOKEN", async () => {
    await expectInteractiveAuth(
      {
        config: remoteGatewayConfig({ token: "remote-config-auth-value" }),
        env: { OPENCLAW_GATEWAY_TOKEN: "shell-token-value" },
      },
      { token: "remote-config-auth-value", password: undefined },
    );
  });

  it("falls back to OPENCLAW_GATEWAY_TOKEN when the remote token ref is unresolved", async () => {
    await expectInteractiveAuth(
      {
        config: remoteGatewayConfig({
          token: { source: "env", provider: "default", id: "ABSENT_BOOTSTRAP_REMOTE_TOKEN" },
        }),
        env: { OPENCLAW_GATEWAY_TOKEN: "shell-token-value" },
      },
      { token: "shell-token-value", password: undefined },
    );
  });

  it("never reuses config or env credentials for a CLI URL override", async () => {
    await expect(
      resolveGatewayClientBootstrap({
        config: {
          gateway: { mode: "local", auth: { token: "configured-auth-value" } },
        },
        gatewayUrl: "wss://override.example/rpc",
        env: { OPENCLAW_GATEWAY_TOKEN: "shell-token-value" },
        authPolicy: "interactive",
        overrideAuthErrorHint: "Fix: pass explicit auth.",
      }),
    ).rejects.toThrow("gateway url override requires explicit credentials");
  });

  it("uses only env credentials for an env URL override", async () => {
    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: { mode: "local", auth: { token: "configured-auth-value" } },
      },
      env: {
        OPENCLAW_GATEWAY_URL: "wss://override.example/rpc",
        OPENCLAW_GATEWAY_TOKEN: "shell-token-value",
      },
      authPolicy: "interactive",
      overrideAuthErrorHint: "Fix: pass explicit auth.",
    });

    expect(result.auth).toEqual({ token: "shell-token-value", password: undefined });
  });

  it("keeps explicit credentials ahead of every implicit source", async () => {
    const result = await resolveGatewayClientBootstrap({
      config: {
        gateway: { mode: "local", auth: { token: "configured-auth-value" } },
      },
      gatewayUrl: "wss://override.example/rpc",
      explicitAuth: { token: "caller-auth-value" },
      env: { OPENCLAW_GATEWAY_TOKEN: "shell-token-value" },
      authPolicy: "interactive",
      overrideAuthErrorHint: "Fix: pass explicit auth.",
    });

    expect(result.auth).toEqual({ token: "caller-auth-value", password: undefined });
  });

  it("allows stored auth only for the exact normalized URL origin", async () => {
    const seenScopes: string[] = [];
    await expect(
      resolveGatewayClientBootstrap({
        config: { gateway: { mode: "local" } },
        gatewayUrl: "wss://override.example/rpc/?ignored=1",
        env: {},
        authPolicy: "interactive",
        allowStoredOriginAuth: (scope) => {
          seenScopes.push(scope);
          return scope === "wss://override.example/rpc";
        },
        overrideAuthErrorHint: "Fix: pair this origin.",
      }),
    ).resolves.toMatchObject({
      deviceAuthScope: "wss://override.example/rpc",
      auth: { token: undefined, password: undefined },
    });
    expect(seenScopes).toEqual(["wss://override.example/rpc"]);

    await expect(
      resolveGatewayClientBootstrap({
        config: { gateway: { mode: "local" } },
        gatewayUrl: "wss://other.example/rpc",
        env: {},
        authPolicy: "interactive",
        allowStoredOriginAuth: (scope) => scope === "wss://override.example/rpc",
        overrideAuthErrorHint: "Fix: pair this origin.",
      }),
    ).rejects.toThrow("gateway url override requires explicit credentials");
  });
});
