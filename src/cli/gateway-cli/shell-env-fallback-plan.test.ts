import { describe, expect, it } from "vitest";
import { resolveGatewayShellEnvFallbackPlan } from "./shell-env-fallback-plan.js";

describe("Gateway shell environment fallback plan", () => {
  it("reports the exact missing bindings without mutating the base environment", () => {
    const env = {
      OPENCLAW_GATEWAY_PASSWORD: "explicit-password",
    };

    const result = resolveGatewayShellEnvFallbackPlan(
      {
        env: { shellEnv: { enabled: true } },
      },
      env,
    );

    expect(result).toMatchObject({
      enabled: true,
      expectedKeys: expect.arrayContaining(["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"]),
      missingKeys: expect.arrayContaining(["OPENCLAW_GATEWAY_TOKEN"]),
    });
    expect(result.enabled && result.missingKeys).not.toContain("OPENCLAW_GATEWAY_PASSWORD");
    expect(env).toEqual({
      OPENCLAW_GATEWAY_PASSWORD: "explicit-password",
    });
  });

  it.each([
    {
      name: "fallback is disabled",
      config: {},
      env: {},
    },
    {
      name: "fallback is deferred",
      config: { env: { shellEnv: { enabled: true } } },
      env: { OPENCLAW_DEFER_SHELL_ENV_FALLBACK: "1" },
    },
  ])("returns disabled when $name", ({ config, env }) => {
    expect(resolveGatewayShellEnvFallbackPlan(config, env)).toEqual({ enabled: false });
  });

  it("treats config-provided runtime values as explicit bindings", () => {
    const result = resolveGatewayShellEnvFallbackPlan(
      {
        env: {
          shellEnv: { enabled: true },
          vars: {
            OPENCLAW_GATEWAY_PASSWORD: "config-password",
            OPENCLAW_GATEWAY_TOKEN: "config-token",
          },
        },
      },
      {},
    );

    expect(result).toMatchObject({
      enabled: true,
      missingKeys: expect.not.arrayContaining([
        "OPENCLAW_GATEWAY_PASSWORD",
        "OPENCLAW_GATEWAY_TOKEN",
      ]),
    });
  });
});
