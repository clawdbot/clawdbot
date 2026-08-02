// Doctor gateway auth token tests cover token resolution, repair prompts, and credential status output.
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withTempHome, writeStateDirDotEnv } from "../config/test-helpers.js";
import { shouldRequireGatewayTokenForInstall } from "../gateway/auth-install-policy.js";
import { withSecureTestNodeCommand } from "../secrets/test-node-command.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveGatewayAuthTokenForService } from "./doctor-gateway-auth-token.js";
import { resolveGatewayInstallToken } from "./gateway-install-token.js";

const envVar = (...parts: string[]) => parts.join("_");

function createExecGatewayTokenConfig(
  markerPath: string,
  command = process.execPath,
): OpenClawConfig {
  return {
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
          command,
          allowInsecurePath: true,
          args: [
            "-e",
            [
              "const fs = require('node:fs');",
              `fs.writeFileSync(${JSON.stringify(markerPath)}, 'executed');`,
              "process.stdout.write(JSON.stringify({ protocolVersion: 1, values: { 'gateway/token': 'exec-token' } }));",
            ].join(""),
          ],
        },
      },
    },
  } as OpenClawConfig;
}

describe("resolveGatewayAuthTokenForService", () => {
  it("returns plaintext gateway.auth.token when configured", async () => {
    const resolved = await resolveGatewayAuthTokenForService(
      {
        gateway: {
          auth: {
            token: "config-token",
          },
        },
      } as OpenClawConfig,
      {} as NodeJS.ProcessEnv,
    );

    expect(resolved).toEqual({ token: "config-token" });
  });

  it("resolves SecretRef-backed gateway.auth.token", async () => {
    const resolved = await resolveGatewayAuthTokenForService(
      {
        gateway: {
          auth: {
            token: {
              source: "env",
              provider: "default",
              id: "CUSTOM_GATEWAY_TOKEN",
            },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      {
        CUSTOM_GATEWAY_TOKEN: "resolved-token",
      } as NodeJS.ProcessEnv,
    );

    expect(resolved).toEqual({ token: "resolved-token" });
  });

  it("resolves env-template gateway.auth.token via SecretRef resolution", async () => {
    const resolved = await resolveGatewayAuthTokenForService(
      {
        gateway: {
          auth: {
            token: "${CUSTOM_GATEWAY_TOKEN}",
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      {
        CUSTOM_GATEWAY_TOKEN: "resolved-token",
      } as NodeJS.ProcessEnv,
    );

    expect(resolved).toEqual({ token: "resolved-token" });
  });

  it("skips exec SecretRefs by default for service token checks", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-service-token-exec-ref-"));
    const markerPath = join(tmp, "exec-ran");
    try {
      const resolved = await resolveGatewayAuthTokenForService(
        createExecGatewayTokenConfig(markerPath),
        {} as NodeJS.ProcessEnv,
      );

      expect(resolved).toEqual({});
      await expect(fs.access(markerPath)).rejects.toThrow();
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("executes exec SecretRefs for service token checks when explicitly allowed", async () => {
    const tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-service-token-exec-ref-"));
    const markerPath = join(tmp, "exec-ran");
    try {
      await withSecureTestNodeCommand(async (command) => {
        const resolved = await resolveGatewayAuthTokenForService(
          createExecGatewayTokenConfig(markerPath, command),
          {} as NodeJS.ProcessEnv,
          { allowExecSecretRefs: true },
        );

        expect(resolved).toEqual({ token: "exec-token" });
        await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("executed");
      });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to OPENCLAW_GATEWAY_TOKEN when SecretRef is unresolved", async () => {
    const resolved = await resolveGatewayAuthTokenForService(
      {
        gateway: {
          auth: {
            token: {
              source: "env",
              provider: "default",
              id: "MISSING_GATEWAY_TOKEN",
            },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      {
        OPENCLAW_GATEWAY_TOKEN: "env-fallback-token",
      } as NodeJS.ProcessEnv,
    );

    expect(resolved).toEqual({ token: "env-fallback-token" });
  });

  it("falls back to OPENCLAW_GATEWAY_TOKEN when SecretRef resolves to empty", async () => {
    const resolved = await resolveGatewayAuthTokenForService(
      {
        gateway: {
          auth: {
            token: {
              source: "env",
              provider: "default",
              id: "CUSTOM_GATEWAY_TOKEN",
            },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      {
        CUSTOM_GATEWAY_TOKEN: "   ",
        OPENCLAW_GATEWAY_TOKEN: "env-fallback-token",
      } as NodeJS.ProcessEnv,
    );

    expect(resolved).toEqual({ token: "env-fallback-token" });
  });

  it("returns unavailableReason when SecretRef is unresolved without env fallback", async () => {
    const resolved = await resolveGatewayAuthTokenForService(
      {
        gateway: {
          auth: {
            token: {
              source: "env",
              provider: "default",
              id: "MISSING_GATEWAY_TOKEN",
            },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      {} as NodeJS.ProcessEnv,
    );

    expect(resolved.token).toBeUndefined();
    expect(resolved.unavailableReason).toBe(
      "gateway.auth.token SecretRef is configured but unresolved (gateway.auth.token SecretRef is unresolved (env:default:MISSING_GATEWAY_TOKEN).).",
    );
  });
});

describe("shouldRequireGatewayTokenForInstall", () => {
  it("requires token when auth mode is token", () => {
    const required = shouldRequireGatewayTokenForInstall(
      {
        gateway: {
          auth: {
            mode: "token",
          },
        },
      } as OpenClawConfig,
      {} as NodeJS.ProcessEnv,
    );
    expect(required).toBe(true);
  });

  it("does not require token when auth mode is password", () => {
    const required = shouldRequireGatewayTokenForInstall(
      {
        gateway: {
          auth: {
            mode: "password",
          },
        },
      } as OpenClawConfig,
      {} as NodeJS.ProcessEnv,
    );
    expect(required).toBe(false);
  });

  it("requires token in inferred mode when password env exists only in shell", async () => {
    await withEnvAsync(
      { [envVar("OPENCLAW", "GATEWAY", "PASSWORD")]: "password-from-env" },
      async () => {
        // pragma: allowlist secret
        const required = shouldRequireGatewayTokenForInstall(
          {
            gateway: {
              auth: {},
            },
          } as OpenClawConfig,
          process.env,
        );
        expect(required).toBe(true);
      },
    );
  });

  it("does not require token in inferred mode when password is configured", () => {
    const required = shouldRequireGatewayTokenForInstall(
      {
        gateway: {
          auth: {
            password: {
              source: "env",
              provider: "default",
              id: "CUSTOM_GATEWAY_PASSWORD",
            },
          },
        },
        secrets: {
          providers: {
            default: { source: "env" },
          },
        },
      } as OpenClawConfig,
      {} as NodeJS.ProcessEnv,
    );
    expect(required).toBe(false);
  });

  it("does not require token in inferred mode when password env is configured in config", () => {
    const required = shouldRequireGatewayTokenForInstall(
      {
        gateway: {
          auth: {},
        },
        env: {
          vars: {
            OPENCLAW_GATEWAY_PASSWORD: "configured-password", // pragma: allowlist secret
          },
        },
      } as OpenClawConfig,
      {} as NodeJS.ProcessEnv,
    );
    expect(required).toBe(false);
  });

  it("does not require token in inferred mode when password env exists in state-dir .env", async () => {
    await withTempHome(async (_home) => {
      await writeStateDirDotEnv("OPENCLAW_GATEWAY_PASSWORD=dotenv-password\n", {
        env: process.env,
      });

      const required = shouldRequireGatewayTokenForInstall(
        {
          gateway: {
            auth: {},
          },
        } as OpenClawConfig,
        process.env,
      );
      expect(required).toBe(false);
    });
  });

  it("requires token in inferred mode when no password candidate exists", () => {
    const required = shouldRequireGatewayTokenForInstall(
      {
        gateway: {
          auth: {},
        },
      } as OpenClawConfig,
      {} as NodeJS.ProcessEnv,
    );
    expect(required).toBe(true);
  });

  it("blocks install token resolution for tailscale serve with explicit no-auth", async () => {
    const resolved = await resolveGatewayInstallToken({
      config: {
        gateway: {
          auth: { mode: "none" },
          tailscale: { mode: "serve" },
        },
      } as OpenClawConfig,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(resolved.token).toBeUndefined();
    expect(resolved.unavailableReason).toBe(
      "gateway.auth.mode=none cannot be used with gateway.tailscale.mode=serve; configure token, password, or trusted-proxy auth before exposing the gateway through Tailscale",
    );
  });
});
