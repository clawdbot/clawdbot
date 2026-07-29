// Hooks token reuse repair tests cover doctor repairs for reused gateway hook tokens.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { repairHooksTokenReuseGatewayAuth } from "./hooks-token-reuse-repair.js";

const ROTATED_HOOKS_TOKEN = "rotated-hooks-token-1234567890";

function repair(cfg: OpenClawConfig, env: NodeJS.ProcessEnv = {}) {
  return repairHooksTokenReuseGatewayAuth(cfg, env, () => ROTATED_HOOKS_TOKEN);
}

describe("repairHooksTokenReuseGatewayAuth", () => {
  it("rotates hooks.token when it reuses active gateway token auth from env", async () => {
    const result = await repair(
      {
        hooks: {
          enabled: true,
          token: "shared-gateway-token-1234567890",
        },
      },
      {
        OPENCLAW_GATEWAY_TOKEN: "shared-gateway-token-1234567890",
      } as NodeJS.ProcessEnv,
    );

    expect(result.config.hooks?.token).toBe(ROTATED_HOOKS_TOKEN);
    expect(result.changes).toContain(
      "Rotated hooks.token because it reused active Gateway shared-secret auth. Update external hook senders to use the new hooks.token.",
    );
  });

  it("rotates hooks.token when it reuses gateway password auth", async () => {
    const result = await repair({
      gateway: {
        auth: {
          mode: "password",
          password: "shared-gateway-password-1234567890", // pragma: allowlist secret
        },
      },
      hooks: {
        enabled: true,
        token: "shared-gateway-password-1234567890",
      },
    });

    expect(result.config.hooks?.token).toBe(ROTATED_HOOKS_TOKEN);
  });

  it("rotates hooks.token when it reuses gateway password auth from a SecretRef", async () => {
    const result = await repair(
      {
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
        gateway: {
          auth: {
            mode: "password",
            password: { source: "env", provider: "default", id: "GW_PASSWORD" },
          },
        },
        hooks: {
          enabled: true,
          token: "shared-gateway-password-1234567890",
        },
      },
      {
        GW_PASSWORD: "shared-gateway-password-1234567890", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
    );

    expect(result.config.hooks?.token).toBe(ROTATED_HOOKS_TOKEN);
  });

  it("does not abort when active gateway auth SecretRef is unavailable", async () => {
    const cfg = {
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
      gateway: {
        auth: {
          mode: "password",
          password: { source: "env", provider: "default", id: "MISSING_GW_PASSWORD" },
        },
      },
      hooks: {
        enabled: true,
        token: "shared-gateway-password-1234567890",
      },
    } satisfies OpenClawConfig;

    await expect(repair(cfg, {} as NodeJS.ProcessEnv)).resolves.toEqual({
      config: cfg,
      changes: [],
    });
  });

  it("does not execute gateway auth SecretRefs during repair", async () => {
    const cfg = {
      secrets: {
        providers: {
          vault: {
            source: "exec",
            command: "node",
            args: ["-e", "process.stdout.write('shared-gateway-password-1234567890')"],
          },
        },
      },
      gateway: {
        auth: {
          mode: "password",
          password: { source: "exec", provider: "vault", id: "GW_PASSWORD" },
        },
      },
      hooks: {
        enabled: true,
        token: "shared-gateway-password-1234567890",
      },
    } satisfies OpenClawConfig;

    await expect(repair(cfg, {} as NodeJS.ProcessEnv)).resolves.toEqual({
      config: cfg,
      changes: [],
    });
  });

  it("rotates hooks.token when it reuses trusted-proxy local password fallback", async () => {
    const result = await repair({
      gateway: {
        auth: {
          mode: "trusted-proxy",
          trustedProxy: { userHeader: "x-forwarded-user" },
          password: "trusted-proxy-local-password-1234567890", // pragma: allowlist secret
        },
      },
      hooks: {
        enabled: true,
        token: "trusted-proxy-local-password-1234567890",
      },
    });

    expect(result.config.hooks?.token).toBe(ROTATED_HOOKS_TOKEN);
  });

  it("rotates hooks.token when it reuses trusted-proxy password auth from a SecretRef", async () => {
    const result = await repair(
      {
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: { userHeader: "x-forwarded-user" },
            password: { source: "env", provider: "default", id: "GW_PASSWORD" },
          },
        },
        hooks: {
          enabled: true,
          token: "trusted-proxy-local-password-1234567890",
        },
      },
      {
        GW_PASSWORD: "trusted-proxy-local-password-1234567890", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
    );

    expect(result.config.hooks?.token).toBe(ROTATED_HOOKS_TOKEN);
  });

  it("does not rotate disabled hooks or distinct hook tokens", async () => {
    const disabled = {
      gateway: {
        auth: {
          mode: "token",
          token: "shared-gateway-token-1234567890",
        },
      },
      hooks: {
        enabled: false,
        token: "shared-gateway-token-1234567890",
      },
    } satisfies OpenClawConfig;
    const distinct = {
      gateway: {
        auth: {
          mode: "token",
          token: "shared-gateway-token-1234567890",
        },
      },
      hooks: {
        enabled: true,
        token: "distinct-hooks-token-1234567890",
      },
    } satisfies OpenClawConfig;

    await expect(repair(disabled)).resolves.toEqual({ config: disabled, changes: [] });
    await expect(repair(distinct)).resolves.toEqual({ config: distinct, changes: [] });
  });
});
