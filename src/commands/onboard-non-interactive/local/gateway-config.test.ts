import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
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
}: {
  nextConfig?: OpenClawConfig;
  opts?: OnboardOptions;
  runtime?: ReturnType<typeof createRuntime>;
} = {}) {
  return applyNonInteractiveGatewayConfig({
    nextConfig,
    opts,
    runtime: runtime as never,
    defaultPort: 18789,
  });
}

describe("applyNonInteractiveGatewayConfig token resolution chain", () => {
  const originalEnvToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const originalRefValue = process.env[SAMPLE_SECRET_REF.id];

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env[SAMPLE_SECRET_REF.id];
  });

  afterEach(() => {
    if (originalEnvToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalEnvToken;
    }
    if (originalRefValue === undefined) {
      delete process.env[SAMPLE_SECRET_REF.id];
    } else {
      process.env[SAMPLE_SECRET_REF.id] = originalRefValue;
    }
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
    process.env.OPENCLAW_GATEWAY_TOKEN = "stale-env-token";
    const nextConfig = createTokenConfig("existing-user-token");

    const result = applyGatewayConfig({ nextConfig });

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

  it("uses OPENCLAW_GATEWAY_TOKEN to fill an empty config on first-run", () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";

    const result = applyGatewayConfig();

    expect(result?.nextConfig.gateway?.auth?.token).toBe("env-token");
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("generates a random token only when flag, env, and existing config are all empty", () => {
    const result = applyGatewayConfig();

    expect(randomToken).toHaveBeenCalledOnce();
    expect(result?.nextConfig.gateway?.auth?.token).toBe("generated-random-token");
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
    process.env.OPENCLAW_GATEWAY_TOKEN = "stale-env-token";
    const nextConfig = createTokenConfig(SAMPLE_SECRET_REF);

    const result = applyGatewayConfig({ nextConfig });

    expect(result?.nextConfig.gateway?.auth?.token).toEqual(SAMPLE_SECRET_REF);
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("leaves env-source SecretRef resolution to the health probe path", () => {
    process.env[SAMPLE_SECRET_REF.id] = "resolved-secret-value";
    const nextConfig = createTokenConfig(SAMPLE_SECRET_REF);

    const result = applyGatewayConfig({ nextConfig });

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
    process.env[newRefId] = "resolved-new-ref-value";
    try {
      const nextConfig = createTokenConfig(SAMPLE_SECRET_REF);

      const result = applyGatewayConfig({
        nextConfig,
        opts: { gatewayTokenRefEnv: newRefId } as OnboardOptions,
      });

      const newToken = result?.nextConfig.gateway?.auth?.token;
      expect(typeof newToken).toBe("object");
      const newTokenRef = typeof newToken === "object" && newToken !== null ? newToken : undefined;
      expect(newTokenRef?.source).toBe("env");
      expect(newTokenRef?.id).toBe(newRefId);
      expect(newToken).not.toEqual(SAMPLE_SECRET_REF);
      expect(randomToken).not.toHaveBeenCalled();
    } finally {
      delete process.env[newRefId];
    }
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
});
