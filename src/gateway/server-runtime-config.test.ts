// Runtime config tests cover gateway bind/auth resolution, trusted proxy rules,
// container defaults, and invalid config rejection before server startup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetContainerEnvironmentCacheForTest } from "../infra/container-environment.js";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";

const TRUSTED_PROXY_AUTH = {
  mode: "trusted-proxy" as const,
  trustedProxy: {
    userHeader: "x-forwarded-user",
  },
};

const TOKEN_AUTH = {
  mode: "token" as const,
  token: "test-token-123",
};

describe("resolveGatewayRuntimeConfig", () => {
  describe("trusted-proxy auth mode", () => {
    // This test validates BOTH validation layers:
    // 1. CLI validation in src/cli/gateway-cli/run.ts (line 246)
    // 2. Runtime config validation in src/gateway/server-runtime-config.ts (line 99)
    // Both must allow lan binding when authMode === "trusted-proxy"
    it.each([
      {
        name: "lan binding",
        cfg: {
          gateway: {
            bind: "lan" as const,
            auth: TRUSTED_PROXY_AUTH,
            trustedProxies: ["192.168.1.1"],
            controlUi: { allowedOrigins: ["https://control.example.com"] },
          },
        },
        expectedBindHost: "0.0.0.0",
      },
      {
        name: "loopback binding with 127.0.0.1 proxy",
        cfg: {
          gateway: {
            bind: "loopback" as const,
            auth: TRUSTED_PROXY_AUTH,
            trustedProxies: ["127.0.0.1"],
          },
        },
        expectedBindHost: "127.0.0.1",
      },
      {
        name: "loopback binding with ::1 proxy",
        cfg: {
          gateway: { bind: "loopback" as const, auth: TRUSTED_PROXY_AUTH, trustedProxies: ["::1"] },
        },
        expectedBindHost: "127.0.0.1",
      },
      {
        name: "loopback binding with loopback cidr proxy",
        cfg: {
          gateway: {
            bind: "loopback" as const,
            auth: TRUSTED_PROXY_AUTH,
            trustedProxies: ["127.0.0.0/8"],
          },
        },
        expectedBindHost: "127.0.0.1",
      },
    ])("allows $name", async ({ cfg, expectedBindHost }) => {
      const result = await resolveGatewayRuntimeConfig({ cfg, port: 18789 });
      expect(result.authMode).toBe("trusted-proxy");
      expect(result.bindHost).toBe(expectedBindHost);
    });

    it.each([
      {
        name: "loopback binding without trusted proxies",
        cfg: {
          gateway: { bind: "loopback" as const, auth: TRUSTED_PROXY_AUTH, trustedProxies: [] },
        },
        expectedMessage:
          "gateway auth mode=trusted-proxy requires gateway.trustedProxies to be configured",
      },
      {
        name: "lan binding without trusted proxies",
        cfg: {
          gateway: {
            bind: "lan" as const,
            auth: TRUSTED_PROXY_AUTH,
            trustedProxies: [],
            controlUi: { allowedOrigins: ["https://control.example.com"] },
          },
        },
        expectedMessage:
          "gateway auth mode=trusted-proxy requires gateway.trustedProxies to be configured",
      },
    ])("rejects $name", async ({ cfg, expectedMessage }) => {
      await expect(resolveGatewayRuntimeConfig({ cfg, port: 18789 })).rejects.toThrow(
        expectedMessage,
      );
    });

    it("allows loopback binding with non-loopback trusted proxies", async () => {
      const result = await resolveGatewayRuntimeConfig({
        cfg: {
          gateway: {
            bind: "loopback",
            auth: TRUSTED_PROXY_AUTH,
            trustedProxies: ["10.0.0.1"],
          },
        },
        port: 18789,
      });

      expect(result.authMode).toBe("trusted-proxy");
      expect(result.bindHost).toBe("127.0.0.1");
    });
  });

  describe("token/password auth modes", () => {
    let originalToken: string | undefined;

    beforeEach(() => {
      originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    });

    afterEach(() => {
      if (originalToken !== undefined) {
        process.env.OPENCLAW_GATEWAY_TOKEN = originalToken;
      } else {
        delete process.env.OPENCLAW_GATEWAY_TOKEN;
      }
    });

    it.each([
      {
        name: "lan binding with token",
        cfg: {
          gateway: {
            bind: "lan" as const,
            auth: TOKEN_AUTH,
            controlUi: { allowedOrigins: ["https://control.example.com"] },
          },
        },
        expectedAuthMode: "token",
        expectedBindHost: "0.0.0.0",
      },
      {
        name: "loopback binding with explicit none auth",
        cfg: { gateway: { bind: "loopback" as const, auth: { mode: "none" as const } } },
        expectedAuthMode: "none",
        expectedBindHost: "127.0.0.1",
      },
    ])("allows $name", async ({ cfg, expectedAuthMode, expectedBindHost }) => {
      const result = await resolveGatewayRuntimeConfig({ cfg, port: 18789 });
      expect(result.authMode).toBe(expectedAuthMode);
      expect(result.bindHost).toBe(expectedBindHost);
    });

    it.each([
      {
        name: "token mode without token",
        cfg: { gateway: { bind: "lan" as const, auth: { mode: "token" as const } } },
        expectedMessage:
          "gateway auth mode is token, but no token was configured (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN)",
      },
      {
        name: "lan binding with explicit none auth",
        cfg: { gateway: { bind: "lan" as const, auth: { mode: "none" as const } } },
        expectedMessage: "refusing to bind gateway",
      },
      {
        name: "loopback binding that resolves to non-loopback host",
        cfg: { gateway: { bind: "loopback" as const, auth: { mode: "none" as const } } },
        host: "0.0.0.0",
        expectedMessage: "gateway bind=loopback resolved to non-loopback host",
      },
      {
        name: "tailnet binding that falls through to wildcard",
        cfg: { gateway: { bind: "tailnet" as const, auth: TOKEN_AUTH } },
        host: "0.0.0.0",
        expectedMessage: "gateway bind=tailnet could not resolve a Tailscale or loopback address",
      },
      {
        name: "custom bind without customBindHost",
        cfg: { gateway: { bind: "custom" as const, auth: TOKEN_AUTH } },
        expectedMessage: "gateway.bind=custom requires gateway.customBindHost",
      },
      {
        name: "custom bind with invalid customBindHost",
        cfg: {
          gateway: {
            bind: "custom" as const,
            customBindHost: "192.168.001.100",
            auth: TOKEN_AUTH,
          },
        },
        expectedMessage: "gateway.bind=custom requires a valid IPv4 customBindHost",
      },
      {
        name: "custom bind with mismatched resolved host",
        cfg: {
          gateway: {
            bind: "custom" as const,
            customBindHost: "192.168.1.100",
            auth: TOKEN_AUTH,
          },
        },
        host: "0.0.0.0",
        expectedMessage: "gateway bind=custom requested 192.168.1.100 but resolved 0.0.0.0",
      },
    ])("rejects $name", async ({ cfg, host, expectedMessage }) => {
      await expect(resolveGatewayRuntimeConfig({ cfg, port: 18789, host })).rejects.toThrow(
        expectedMessage,
      );
    });

    it.each([
      {
        name: "rejects non-loopback control UI when allowed origins are missing",
        cfg: {
          gateway: {
            bind: "lan" as const,
            auth: TOKEN_AUTH,
          },
        },
        expectedError: "non-loopback Control UI requires gateway.controlUi.allowedOrigins",
      },
      {
        name: "allows non-loopback control UI without allowed origins when dangerous fallback is enabled",
        cfg: {
          gateway: {
            bind: "lan" as const,
            auth: TOKEN_AUTH,
            controlUi: {
              dangerouslyAllowHostHeaderOriginFallback: true,
            },
          },
        },
        expectedBindHost: "0.0.0.0",
      },
      {
        name: "allows non-loopback control UI when allowed origins collapse after trimming",
        cfg: {
          gateway: {
            bind: "lan" as const,
            auth: TOKEN_AUTH,
            controlUi: {
              allowedOrigins: ["  https://control.example.com  "],
            },
          },
        },
        expectedBindHost: "0.0.0.0",
      },
    ])("$name", async ({ cfg, expectedError, expectedBindHost }) => {
      if (expectedError) {
        await expect(resolveGatewayRuntimeConfig({ cfg, port: 18789 })).rejects.toThrow(
          expectedError,
        );
        return;
      }
      const result = await resolveGatewayRuntimeConfig({ cfg, port: 18789 });
      expect(result.bindHost).toBe(expectedBindHost);
    });
  });

  describe("container-aware bind default", () => {
    afterEach(() => {
      resetContainerEnvironmentCacheForTest();
      vi.restoreAllMocks();
    });

    it("defaults to auto (0.0.0.0) inside a container with auth configured", async () => {
      const fs = require("node:fs");
      vi.spyOn(fs, "accessSync").mockImplementation(() => undefined); // /.dockerenv exists
      const result = await resolveGatewayRuntimeConfig({
        cfg: {
          gateway: {
            auth: TOKEN_AUTH,
            controlUi: { allowedOrigins: ["https://control.example.com"] },
          },
        },
        port: 18789,
      });
      expect(result.bindHost).toBe("0.0.0.0");
    });

    it("rejects container auto-bind with auth but without allowedOrigins (origin check preserved)", async () => {
      const fs = require("node:fs");
      vi.spyOn(fs, "accessSync").mockImplementation(() => undefined); // /.dockerenv exists
      await expect(
        resolveGatewayRuntimeConfig({
          cfg: { gateway: { auth: TOKEN_AUTH } },
          port: 18789,
        }),
      ).rejects.toThrow(/non-loopback Control UI requires gateway\.controlUi\.allowedOrigins/);
    });

    it("rejects container auto-bind without auth (security invariant preserved)", async () => {
      const fs = require("node:fs");
      vi.spyOn(fs, "accessSync").mockImplementation(() => undefined); // /.dockerenv exists
      await expect(
        resolveGatewayRuntimeConfig({
          cfg: { gateway: { auth: { mode: "none" } } },
          port: 18789,
        }),
      ).rejects.toThrow(/refusing to bind gateway/);
    });

    it("rejects tailscale serve with explicit no-auth", async () => {
      await expect(
        resolveGatewayRuntimeConfig({
          cfg: {
            gateway: {
              auth: { mode: "none" },
              tailscale: { mode: "serve" },
            },
          },
          port: 18789,
        }),
      ).rejects.toThrow("gateway.auth.mode=none cannot be used with gateway.tailscale.mode=serve");
    });

    it("respects explicit loopback config even inside a container", async () => {
      const fs = require("node:fs");
      vi.spyOn(fs, "accessSync").mockImplementation(() => undefined); // /.dockerenv exists
      const result = await resolveGatewayRuntimeConfig({
        cfg: { gateway: { bind: "loopback", auth: { mode: "none" } } },
        port: 18789,
      });
      expect(result.bindHost).toBe("127.0.0.1");
    });

    it("falls back to loopback inside a container when tailscale serve is enabled", async () => {
      const fs = require("node:fs");
      vi.spyOn(fs, "accessSync").mockImplementation(() => undefined); // /.dockerenv exists
      const result = await resolveGatewayRuntimeConfig({
        cfg: {
          gateway: {
            auth: TOKEN_AUTH,
            tailscale: { mode: "serve" },
          },
        },
        port: 18789,
      });
      // Tailscale serve requires loopback — container auto-detection must not
      // override this constraint when bind is unset.
      expect(result.bindHost).toBe("127.0.0.1");
    });

    it("falls back to loopback inside a container when tailscale funnel is enabled", async () => {
      const fs = require("node:fs");
      vi.spyOn(fs, "accessSync").mockImplementation(() => undefined); // /.dockerenv exists
      const result = await resolveGatewayRuntimeConfig({
        cfg: {
          gateway: {
            auth: { mode: "password", password: "test-pw" },
            tailscale: { mode: "funnel" },
          },
        },
        port: 18789,
      });
      expect(result.bindHost).toBe("127.0.0.1");
    });

    it("respects explicit lan config inside a container (requires auth)", async () => {
      const fs = require("node:fs");
      vi.spyOn(fs, "accessSync").mockImplementation(() => undefined); // /.dockerenv exists
      const result = await resolveGatewayRuntimeConfig({
        cfg: {
          gateway: {
            bind: "lan",
            auth: TOKEN_AUTH,
            controlUi: { allowedOrigins: ["https://control.example.com"] },
          },
        },
        port: 18789,
      });
      expect(result.bindHost).toBe("0.0.0.0");
    });
  });

  describe("HTTP security headers", () => {
    const cases = [
      {
        name: "resolves strict transport security headers from config",
        strictTransportSecurity: "  max-age=31536000; includeSubDomains  ",
        expected: "max-age=31536000; includeSubDomains",
      },
      {
        name: "does not set strict transport security when explicitly disabled",
        strictTransportSecurity: false,
        expected: undefined,
      },
      {
        name: "does not set strict transport security when the value is blank",
        strictTransportSecurity: "   ",
        expected: undefined,
      },
    ] satisfies ReadonlyArray<{
      name: string;
      strictTransportSecurity: string | false;
      expected: string | undefined;
    }>;

    it.each(cases)("$name", async ({ strictTransportSecurity, expected }) => {
      const result = await resolveGatewayRuntimeConfig({
        cfg: {
          gateway: {
            bind: "loopback",
            auth: { mode: "none" },
            http: {
              securityHeaders: {
                strictTransportSecurity,
              },
            },
          },
        },
        port: 18789,
      });

      expect(result.strictTransportSecurityHeader).toBe(expected);
    });
  });
});
