import { describe, expect, it, vi } from "vitest";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import { resolveConnectAuthDecision, type ConnectAuthState } from "./auth-context.js";

type VerifyDeviceTokenFn = Parameters<typeof resolveConnectAuthDecision>[0]["verifyDeviceToken"];
type VerifyBootstrapTokenFn = Parameters<
  typeof resolveConnectAuthDecision
>[0]["verifyBootstrapToken"];

function createRateLimiter(params?: { allowed?: boolean; retryAfterMs?: number }): {
  limiter: AuthRateLimiter;
  reset: ReturnType<typeof vi.fn>;
} {
  const allowed = params?.allowed ?? true;
  const retryAfterMs = params?.retryAfterMs ?? 5_000;
  const check = vi.fn(() => ({ allowed, retryAfterMs }));
  const reset = vi.fn();
  const recordFailure = vi.fn();
  return {
    limiter: {
      check,
      reset,
      recordFailure,
    } as unknown as AuthRateLimiter,
    reset,
  };
}

function createBaseState(overrides?: Partial<ConnectAuthState>): ConnectAuthState {
  return {
    authResult: { ok: false, reason: "token_mismatch" },
    authOk: false,
    authMethod: "token",
    sharedAuthOk: false,
    sharedAuthProvided: true,
    deviceTokenCandidate: "device-token",
    deviceTokenCandidateSource: "shared-token-fallback",
    ...overrides,
  };
}

async function resolveDeviceTokenDecision(params: {
  verifyDeviceToken: VerifyDeviceTokenFn;
  verifyBootstrapToken?: VerifyBootstrapTokenFn;
  stateOverrides?: Partial<ConnectAuthState>;
  rateLimiter?: AuthRateLimiter;
  clientIp?: string;
}) {
  return await resolveConnectAuthDecision({
    state: createBaseState(params.stateOverrides),
    hasDeviceIdentity: true,
    deviceId: "dev-1",
    publicKey: "pub-1",
    role: "operator",
    scopes: ["operator.read"],
    verifyBootstrapToken:
      params.verifyBootstrapToken ??
      (async () => ({ ok: false, reason: "bootstrap_token_invalid" })),
    verifyDeviceToken: params.verifyDeviceToken,
    ...(params.rateLimiter ? { rateLimiter: params.rateLimiter } : {}),
    ...(params.clientIp ? { clientIp: params.clientIp } : {}),
  });
}

async function resolveSuccessfulNodeBootstrapDecision(params: {
  verifyBootstrapToken: VerifyBootstrapTokenFn;
  verifyDeviceToken: VerifyDeviceTokenFn;
}) {
  return await resolveConnectAuthDecision({
    state: createBaseState({
      authResult: { ok: true, method: "tailscale" },
      authOk: true,
      authMethod: "tailscale",
      bootstrapTokenCandidate: "bootstrap-token",
      deviceTokenCandidate: undefined,
      deviceTokenCandidateSource: undefined,
    }),
    hasDeviceIdentity: true,
    deviceId: "dev-1",
    publicKey: "pub-1",
    role: "node",
    scopes: [],
    verifyBootstrapToken: params.verifyBootstrapToken,
    verifyDeviceToken: params.verifyDeviceToken,
  });
}

describe("resolveConnectAuthDecision", () => {
  it("keeps shared-secret mismatch when fallback device-token check fails", async () => {
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: false }));
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({
      ok: false,
      reason: "bootstrap_token_invalid",
    }));
    const decision = await resolveConnectAuthDecision({
      state: createBaseState(),
      hasDeviceIdentity: true,
      deviceId: "dev-1",
      publicKey: "pub-1",
      role: "operator",
      scopes: ["operator.read"],
      verifyBootstrapToken,
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("token_mismatch");
    expect(verifyBootstrapToken).not.toHaveBeenCalled();
    expect(verifyDeviceToken).toHaveBeenCalledOnce();
  });

  it("reports explicit device-token mismatches as device_token_mismatch", async () => {
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: false }));
    const decision = await resolveConnectAuthDecision({
      state: createBaseState({
        deviceTokenCandidateSource: "explicit-device-token",
      }),
      hasDeviceIdentity: true,
      deviceId: "dev-1",
      publicKey: "pub-1",
      role: "operator",
      scopes: ["operator.read"],
      verifyBootstrapToken: async () => ({ ok: false, reason: "bootstrap_token_invalid" }),
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("device_token_mismatch");
  });

  it("preserves explicit device-token scope mismatches", async () => {
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({
      ok: false,
      reason: "scope-mismatch",
    }));
    const decision = await resolveConnectAuthDecision({
      state: createBaseState({
        deviceTokenCandidateSource: "explicit-device-token",
      }),
      hasDeviceIdentity: true,
      deviceId: "dev-1",
      publicKey: "pub-1",
      role: "operator",
      scopes: ["operator.admin"],
      verifyBootstrapToken: async () => ({ ok: false, reason: "bootstrap_token_invalid" }),
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("scope_mismatch");
  });

  it("preserves fallback device-token scope mismatches over shared-token mismatch", async () => {
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({
      ok: false,
      reason: "scope-mismatch",
    }));
    const decision = await resolveConnectAuthDecision({
      state: createBaseState({
        authResult: { ok: false, reason: "token_mismatch" },
        deviceTokenCandidateSource: "shared-token-fallback",
      }),
      hasDeviceIdentity: true,
      deviceId: "dev-1",
      publicKey: "pub-1",
      role: "operator",
      scopes: ["operator.admin"],
      verifyBootstrapToken: async () => ({ ok: false, reason: "bootstrap_token_invalid" }),
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("scope_mismatch");
  });

  it("accepts valid device tokens and marks auth method as device-token", async () => {
    const rateLimiter = createRateLimiter();
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveDeviceTokenDecision({
      verifyDeviceToken,
      rateLimiter: rateLimiter.limiter,
      clientIp: "203.0.113.20",
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("device-token");
    expect(verifyDeviceToken).toHaveBeenCalledOnce();
    expect(rateLimiter.reset).toHaveBeenCalledWith("203.0.113.20", "device-token");
  });

  it("accepts valid bootstrap tokens before device-token fallback", async () => {
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({ ok: true }));
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveDeviceTokenDecision({
      verifyBootstrapToken,
      verifyDeviceToken,
      stateOverrides: {
        bootstrapTokenCandidate: "bootstrap-token",
        deviceTokenCandidate: "device-token",
      },
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("bootstrap-token");
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it("reports invalid bootstrap tokens when no device token fallback is available", async () => {
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({
      ok: false,
      reason: "bootstrap_token_invalid",
    }));
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveDeviceTokenDecision({
      verifyBootstrapToken,
      verifyDeviceToken,
      stateOverrides: {
        bootstrapTokenCandidate: "bootstrap-token",
        deviceTokenCandidate: undefined,
        deviceTokenCandidateSource: undefined,
      },
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("bootstrap_token_invalid");
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it("returns rate-limited auth result without verifying device token", async () => {
    const rateLimiter = createRateLimiter({ allowed: false, retryAfterMs: 60_000 });
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveDeviceTokenDecision({
      verifyDeviceToken,
      rateLimiter: rateLimiter.limiter,
      clientIp: "203.0.113.20",
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("rate_limited");
    expect(decision.authResult.retryAfterMs).toBe(60_000);
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it("still verifies the device token when only the shared-secret path is rate-limited", async () => {
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveDeviceTokenDecision({
      verifyDeviceToken,
      stateOverrides: {
        authResult: {
          ok: false,
          reason: "rate_limited",
          rateLimited: true,
          retryAfterMs: 60_000,
        },
      },
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("device-token");
    expect(verifyDeviceToken).toHaveBeenCalledOnce();
  });

  it("prefers a valid bootstrap token over an already successful shared auth path", async () => {
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({ ok: true }));
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveSuccessfulNodeBootstrapDecision({
      verifyBootstrapToken,
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("bootstrap-token");
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it("keeps the original successful auth path when bootstrap validation fails", async () => {
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => ({
      ok: false,
      reason: "bootstrap_token_invalid",
    }));
    const verifyDeviceToken = vi.fn<VerifyDeviceTokenFn>(async () => ({ ok: true }));
    const decision = await resolveSuccessfulNodeBootstrapDecision({
      verifyBootstrapToken,
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("tailscale");
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });
});
