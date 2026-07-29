// Covers gateway auth mode validation when token and password inputs are both
// configured directly or via secret defaults.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  assertExplicitGatewayAuthModeWhenBothConfigured,
  hasAmbiguousGatewayAuthModeConfig,
} from "./auth-mode-policy.js";

describe("gateway auth mode policy", () => {
  it("does not flag config when auth mode is explicit", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          mode: "token",
          token: "token-value",
          password: "password-value", // pragma: allowlist secret
        },
      },
    };
    expect(hasAmbiguousGatewayAuthModeConfig(cfg)).toBe(false);
  });

  it("does not flag config when only one auth credential is configured", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          token: "token-value",
        },
      },
    };
    expect(hasAmbiguousGatewayAuthModeConfig(cfg)).toBe(false);
  });

  it("flags config when both token and password are configured and mode is unset", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          token: "token-value",
          password: "password-value", // pragma: allowlist secret
        },
      },
    };
    expect(hasAmbiguousGatewayAuthModeConfig(cfg)).toBe(true);
  });

  it("flags config when both token/password SecretRefs are configured and mode is unset", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          token: { source: "env", provider: "default", id: "GW_TOKEN" },
          password: { source: "env", provider: "default", id: "GW_PASSWORD" },
        },
      },
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
    };
    expect(hasAmbiguousGatewayAuthModeConfig(cfg)).toBe(true);
  });

  it("throws the shared explicit-mode error for ambiguous dual auth config", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: {
          token: "token-value",
          password: "password-value", // pragma: allowlist secret
        },
      },
    };
    expect(() => assertExplicitGatewayAuthModeWhenBothConfigured(cfg)).toThrow(
      /gateway\.auth\.mode is unset/u,
    );
  });
});
