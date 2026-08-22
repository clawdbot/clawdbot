// Non-interactive gateway config tests cover port, bind, auth token, and SecretRef preservation behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { withEnv } from "../../../test-utils/env.js";
import type { OnboardOptions } from "../../onboard-types.js";
import { applyNonInteractiveGatewayConfig } from "./gateway-config.js";

// Narrow mock: reproduce normalize semantics (typeof-string + trim, reject
// "undefined"/"null" literals) and stub randomToken so we can assert when a
// fresh token is generated vs. reused from the resolution chain.
const randomToken = vi.hoisted(() => vi.fn(() => "generated-random-token"));
vi.mock("../../onboard-helpers.js", () => ({
  normalizeGatewayTokenInput: (value: unknown): string => {
    if (typeof value !== "string") {
      return "";
    }
    const trimmed = value.trim();
    if (trimmed === "undefined" || trimmed === "null") {
      return "";
    }
    return trimmed;
  },
  randomToken,
}));

function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

const baseOpts = {} as OnboardOptions;

const SAMPLE_SECRET_REF = {
  source: "env" as const,
  provider: "default",
  id: "OPENCLAW_GATEWAY_TOKEN_REF",
};

function createTokenConfig(token: unknown): OpenClawConfig {
  return {
    gateway: { auth: { mode: "token", token } },
  } as unknown as OpenClawConfig;
}

function applyGatewayConfig({
  nextConfig = {} as OpenClawConfig,
  opts = baseOpts,
  runtime = createRuntime(),
  env = {},
}: {
  nextConfig?: OpenClawConfig;
  opts?: OnboardOptions;
  runtime?: ReturnType<typeof createRuntime>;
  env?: Record<string, string | undefined>;
} = {}) {
  return withEnv(
    {
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      [SAMPLE_SECRET_REF.id]: undefined,
      ...env,
    },
    () => {
      return applyNonInteractiveGatewayConfig({
        nextConfig,
        opts,
        runtime: runtime as never,
        defaultPort: 18789,
      });
    },
  );
}

describe("applyNonInteractiveGatewayConfig auth resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Plaintext preservation (the original regression) ---

  it("preserves existing plaintext gateway.auth.token when no flag or env override is provided", () => {
    const nextConfig = createTokenConfig("existing-user-token");

    const result = applyGatewayConfig({ nextConfig });

    expect(result?.nextConfig.gateway?.auth?.token).toBe("existing-user-token");
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("prefers existing plaintext token over ambient OPENCLAW_GATEWAY_TOKEN on re-onboard", () => {
    // A stale shell/launchd OPENCLAW_GATEWAY_TOKEN must not rotate a
    // persisted token — that would break already-paired clients.
    const nextConfig = createTokenConfig("existing-user-token");

    const result = applyGatewayConfig({
      nextConfig,
      env: { OPENCLAW_GATEWAY_TOKEN: "stale-env-token" },
    });

    expect(result?.nextConfig.gateway?.auth?.token).toBe("existing-user-token");
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("prefers --gateway-token flag over existing plaintext token", () => {
    const nextConfig = createTokenConfig("existing-user-token");

    const result = applyGatewayConfig({
      nextConfig,
      opts: { gatewayToken: "flag-token" } as OnboardOptions,
    });

    expect(result?.nextConfig.gateway?.auth?.token).toBe("flag-token");
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("selects token auth when --gateway-token overrides a no-auth config", () => {
    const result = applyGatewayConfig({
      nextConfig: { gateway: { auth: { mode: "none" } } },
      opts: { gatewayToken: "flag-token" } as OnboardOptions,
    });

    expect(result?.nextConfig.gateway?.auth).toEqual({ mode: "token", token: "flag-token" });
  });

  it.each([
    { name: "a fresh gateway", nextConfig: {} },
    { name: "an existing plaintext token", nextConfig: createTokenConfig("existing-user-token") },
    { name: "an existing token SecretRef", nextConfig: createTokenConfig(SAMPLE_SECRET_REF) },
  ])("selects password auth when --gateway-password overrides $name", ({ nextConfig }) => {
    const result = applyGatewayConfig({
      nextConfig,
      opts: { gatewayPassword: "explicit-password" } as OnboardOptions,
    });

    expect(result?.nextConfig.gateway?.auth).toMatchObject({
      mode: "password",
      password: "explicit-password",
    });
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("stores an explicit password as a reference to the configured env provider", () => {
    const result = applyGatewayConfig({
      nextConfig: {
        secrets: {
          defaults: { env: "gatewayenv" },
          providers: { gatewayenv: { source: "env" } },
        },
      },
      opts: {
        gatewayPassword: "gateway-password-from-env",
        secretInputMode: "ref",
      },
      env: { OPENCLAW_GATEWAY_PASSWORD: "gateway-password-from-env" },
    });

    expect(result?.nextConfig.gateway?.auth).toMatchObject({
      mode: "password",
      password: {
        source: "env",
        provider: "gatewayenv",
        id: "OPENCLAW_GATEWAY_PASSWORD",
      },
    });
  });

  it.each([
    {
      name: "an existing plaintext password",
      password: "existing-password",
    },
    {
      name: "an existing password SecretRef",
      password: {
        source: "env" as const,
        provider: "default",
        id: "EXISTING_GATEWAY_PASSWORD",
      },
    },
  ])("preserves $name in reference mode without an explicit replacement", ({ password }) => {
    const result = applyGatewayConfig({
      nextConfig: { gateway: { auth: { mode: "password", password } } },
      opts: { secretInputMode: "ref" },
    });

    expect(result?.nextConfig.gateway?.auth?.password).toEqual(password);
  });

  it.each([
    { name: "an explicit auth mode", opts: { gatewayAuth: "token" as const } },
    { name: "an explicit token credential", opts: { gatewayToken: "flag-token" } },
  ])("keeps $name authoritative over --gateway-password", ({ opts }) => {
    const result = applyGatewayConfig({
      opts: { ...opts, gatewayPassword: "explicit-password" } as OnboardOptions,
    });

    expect(result?.nextConfig.gateway?.auth?.mode).toBe("token");
  });

  it("keeps password auth when a token-only rerun targets an existing Funnel", () => {
    const result = applyGatewayConfig({
      nextConfig: {
        gateway: {
          auth: { mode: "password", password: "test-password" },
          tailscale: { mode: "funnel" },
        },
      },
      opts: { gatewayToken: "flag-token" } as OnboardOptions,
    });

    expect(result?.nextConfig.gateway?.auth).toEqual({
      mode: "password",
      password: "test-password",
    });
  });

  it("uses OPENCLAW_GATEWAY_TOKEN to fill an empty config on first-run", () => {
    const result = applyGatewayConfig({ env: { OPENCLAW_GATEWAY_TOKEN: "env-token" } });

    expect(result?.nextConfig.gateway?.auth?.token).toBe("env-token");
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("generates a random token only when flag, env, and existing config are all empty", () => {
    const result = applyGatewayConfig();

    expect(randomToken).toHaveBeenCalledOnce();
    expect(result?.nextConfig.gateway?.auth?.token).toBe("generated-random-token");
  });

  it("establishes token auth when explicitly enabling Tailscale Serve from no-auth", () => {
    const result = applyGatewayConfig({
      nextConfig: {
        gateway: {
          bind: "loopback",
          auth: { mode: "none" },
          tailscale: { mode: "off" },
        },
      },
      opts: { tailscale: "serve" } as OnboardOptions,
    });

    expect(result?.nextConfig.gateway?.auth).toEqual({
      mode: "token",
      token: "generated-random-token",
    });
    expect(result?.nextConfig.gateway?.tailscale?.mode).toBe("serve");
  });

  // --- SecretRef preservation ---

  it("preserves an existing SecretRef when no flag or env override is provided", () => {
    const nextConfig = createTokenConfig(SAMPLE_SECRET_REF);

    const result = applyGatewayConfig({ nextConfig });

    expect(result?.nextConfig.gateway?.auth?.token).toEqual(SAMPLE_SECRET_REF);
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("preserves an existing SecretRef even when ambient OPENCLAW_GATEWAY_TOKEN is set", () => {
    // A stale ambient env must not declassify a configured SecretRef.
    const nextConfig = createTokenConfig(SAMPLE_SECRET_REF);

    const result = applyGatewayConfig({
      nextConfig,
      env: { OPENCLAW_GATEWAY_TOKEN: "stale-env-token" },
    });

    expect(result?.nextConfig.gateway?.auth?.token).toEqual(SAMPLE_SECRET_REF);
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("leaves env-source SecretRef resolution to the health probe path", () => {
    const nextConfig = createTokenConfig(SAMPLE_SECRET_REF);

    const result = applyGatewayConfig({
      nextConfig,
      env: { [SAMPLE_SECRET_REF.id]: "resolved-secret-value" },
    });

    expect(result?.nextConfig.gateway?.auth?.token).toEqual(SAMPLE_SECRET_REF);
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("overrides an existing SecretRef when --gateway-token flag is provided", () => {
    const nextConfig = createTokenConfig(SAMPLE_SECRET_REF);

    const result = applyGatewayConfig({
      nextConfig,
      opts: { gatewayToken: "flag-token" } as OnboardOptions,
    });

    expect(result?.nextConfig.gateway?.auth?.token).toBe("flag-token");
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("overrides an existing SecretRef when --gateway-token-ref-env is provided", () => {
    const newRefId = "OPENCLAW_GATEWAY_TOKEN_NEW_REF";
    const nextConfig = createTokenConfig(SAMPLE_SECRET_REF);

    const result = applyGatewayConfig({
      nextConfig,
      opts: { gatewayTokenRefEnv: newRefId } as OnboardOptions,
      env: { [newRefId]: "resolved-new-ref-value" },
    });

    const newToken = result?.nextConfig.gateway?.auth?.token;
    expect(typeof newToken).toBe("object");
    const newTokenRef = typeof newToken === "object" && newToken !== null ? newToken : undefined;
    expect(newTokenRef?.source).toBe("env");
    expect(newTokenRef?.id).toBe(newRefId);
    expect(newToken).not.toEqual(SAMPLE_SECRET_REF);
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("selects token auth when --gateway-token-ref-env overrides password auth", () => {
    const newRefId = "OPENCLAW_GATEWAY_TOKEN_NEW_REF";
    const result = applyGatewayConfig({
      nextConfig: { gateway: { auth: { mode: "password", password: "test-password" } } },
      opts: { gatewayTokenRefEnv: newRefId } as OnboardOptions,
      env: { [newRefId]: "resolved-new-ref-value" },
    });

    expect(result?.nextConfig.gateway?.auth?.mode).toBe("token");
    expect(result?.nextConfig.gateway?.auth?.token).toEqual({
      source: "env",
      provider: "default",
      id: newRefId,
    });
  });

  it("fails when --gateway-token-ref-env points to a missing env var", () => {
    const runtime = createRuntime();

    const result = applyGatewayConfig({
      opts: { gatewayTokenRefEnv: "MISSING_GATEWAY_TOKEN_ENV" } as OnboardOptions,
      runtime,
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(
      'Environment variable "MISSING_GATEWAY_TOKEN_ENV" is missing or empty. Export it first, then rerun openclaw onboard --non-interactive.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("rejects an explicitly empty password instead of preserving the existing password", () => {
    const runtime = createRuntime();
    const result = applyGatewayConfig({
      nextConfig: { gateway: { auth: { mode: "password", password: "test-password" } } },
      opts: { gatewayPassword: " " } as OnboardOptions,
      runtime,
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--gateway-password"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("preserves environment-backed password auth without persisting the password", () => {
    const result = applyGatewayConfig({
      nextConfig: { gateway: { auth: { mode: "password" } } },
      env: { OPENCLAW_GATEWAY_PASSWORD: "environment-password" },
    });

    expect(result?.nextConfig.gateway?.auth).toEqual({ mode: "password" });
  });

  it("rejects --gateway-bind custom when no gateway.customBindHost is configured", () => {
    const runtime = createRuntime();

    const result = applyGatewayConfig({
      opts: { gatewayBind: "custom" } as OnboardOptions,
      runtime,
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("--gateway-bind custom requires gateway.customBindHost"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("rejects --gateway-bind custom when gateway.customBindHost is not a dotted-decimal IPv4", () => {
    const runtime = createRuntime();

    const result = applyGatewayConfig({
      nextConfig: { gateway: { customBindHost: "not-an-ip" } } as OpenClawConfig,
      opts: { gatewayBind: "custom" } as OnboardOptions,
      runtime,
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Invalid IPv4 address"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("accepts --gateway-bind custom when gateway.customBindHost is already configured", () => {
    const runtime = createRuntime();

    const result = applyGatewayConfig({
      nextConfig: { gateway: { customBindHost: "192.168.1.100" } } as OpenClawConfig,
      opts: { gatewayBind: "custom" } as OnboardOptions,
      runtime,
    });

    expect(result?.nextConfig.gateway?.bind).toBe("custom");
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("keeps loopback normalization ahead of the custom bind guard when Tailscale is enabled", () => {
    const runtime = createRuntime();

    const result = applyGatewayConfig({
      opts: { gatewayBind: "custom", tailscale: "serve" } as OnboardOptions,
      runtime,
    });

    expect(result?.nextConfig.gateway?.bind).toBe("loopback");
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
