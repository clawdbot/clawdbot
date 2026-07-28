// WebSocket auth-context tests cover token, password, bootstrap, and device-token decision state.
import { describe, expect, it, vi } from "vitest";
import { createAuthRateLimiter, type AuthRateLimiter } from "../../auth-rate-limit.js";
import { resolveConnectAuthDecision, resolveConnectAuthState } from "./auth-context.js";

type ConnectAuthState = Awaited<ReturnType<typeof resolveConnectAuthState>>;

type VerifyDeviceTokenFn = Parameters<typeof resolveConnectAuthDecision>[0]["verifyDeviceToken"];
type VerifyBootstrapTokenFn = Parameters<
  typeof resolveConnectAuthDecision
>[0]["verifyBootstrapToken"];
type DeviceTokenResult = Awaited<ReturnType<VerifyDeviceTokenFn>>;
type BootstrapTokenResult = Awaited<ReturnType<VerifyBootstrapTokenFn>>;
type ConnectAuthRole = Parameters<typeof resolveConnectAuthDecision>[0]["role"];
type TokenBucketScope = "bootstrap-token" | "device-token" | "shared-secret";

const CLIENT_IP = "203.0.113.20";
const BOOTSTRAP_TOKEN = "bootstrap-token";
const DEVICE_TOKEN = "device-token";

function createRateLimiter(params?: { allowed?: boolean; retryAfterMs?: number }): {
  limiter: AuthRateLimiter;
  check: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  recordFailure: ReturnType<typeof vi.fn>;
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
    check,
    reset,
    recordFailure,
  };
}

function createPerScopeRateLimiter(
  scopes: Record<string, { allowed: boolean; retryAfterMs?: number }>,
): {
  limiter: AuthRateLimiter;
  check: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  recordFailure: ReturnType<typeof vi.fn>;
} {
  const check = vi.fn((_ip: string | undefined, scope?: string) => {
    const cfg = scopes[scope ?? ""] ?? { allowed: true };
    return { allowed: cfg.allowed, retryAfterMs: cfg.retryAfterMs ?? 5_000 };
  });
  const reset = vi.fn();
  const recordFailure = vi.fn();
  return {
    limiter: { check, reset, recordFailure } as unknown as AuthRateLimiter,
    check,
    reset,
    recordFailure,
  };
}

function createTokenBucketRateLimiter(
  overrides?: Partial<Record<TokenBucketScope, { allowed: boolean; retryAfterMs?: number }>>,
) {
  const allowed = { allowed: true };
  return createPerScopeRateLimiter({
    "bootstrap-token": overrides?.["bootstrap-token"] ?? allowed,
    "device-token": overrides?.["device-token"] ?? allowed,
    "shared-secret": overrides?.["shared-secret"] ?? allowed,
  });
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

function createBootstrapOnlyState(): Partial<ConnectAuthState> {
  return {
    bootstrapTokenCandidate: BOOTSTRAP_TOKEN,
    deviceTokenCandidate: undefined,
    deviceTokenCandidateSource: undefined,
  };
}

function createBootstrapFallbackState(): Partial<ConnectAuthState> {
  return {
    bootstrapTokenCandidate: BOOTSTRAP_TOKEN,
    deviceTokenCandidate: DEVICE_TOKEN,
  };
}

function createVerifyDeviceToken(
  result: DeviceTokenResult,
): ReturnType<typeof vi.fn<VerifyDeviceTokenFn>> {
  return vi.fn<VerifyDeviceTokenFn>(async () => result);
}

function createVerifyBootstrapToken(
  result: BootstrapTokenResult,
): ReturnType<typeof vi.fn<VerifyBootstrapTokenFn>> {
  return vi.fn<VerifyBootstrapTokenFn>(async () => result);
}

async function resolveDeviceTokenDecision(params: {
  verifyDeviceToken: VerifyDeviceTokenFn;
  verifyBootstrapToken?: VerifyBootstrapTokenFn;
  stateOverrides?: Partial<ConnectAuthState>;
  rateLimiter?: AuthRateLimiter;
  clientIp?: string;
  role?: ConnectAuthRole;
  scopes?: string[];
}) {
  return await resolveConnectAuthDecision({
    state: createBaseState(params.stateOverrides),
    hasDeviceIdentity: true,
    deviceId: "dev-1",
    publicKey: "pub-1",
    role: params.role ?? "operator",
    scopes: params.scopes ?? ["operator.read"],
    verifyBootstrapToken:
      params.verifyBootstrapToken ??
      (async () => ({ ok: false, reason: "bootstrap_token_invalid" })),
    verifyDeviceToken: params.verifyDeviceToken,
    ...(params.rateLimiter ? { rateLimiter: params.rateLimiter } : {}),
    ...(params.clientIp ? { clientIp: params.clientIp } : {}),
  });
}

async function resolveBootstrapCandidateDecision(params: {
  verifyBootstrapToken: VerifyBootstrapTokenFn;
  verifyDeviceToken: VerifyDeviceTokenFn;
  rateLimiter?: AuthRateLimiter;
  withDeviceFallback?: boolean;
}) {
  return await resolveDeviceTokenDecision({
    verifyBootstrapToken: params.verifyBootstrapToken,
    verifyDeviceToken: params.verifyDeviceToken,
    ...(params.rateLimiter
      ? {
          rateLimiter: params.rateLimiter,
          clientIp: CLIENT_IP,
        }
      : {}),
    stateOverrides: params.withDeviceFallback
      ? createBootstrapFallbackState()
      : createBootstrapOnlyState(),
  });
}

async function resolveRejectedDeviceTokenDecision(params: {
  result: DeviceTokenResult;
  scopes?: string[];
  stateOverrides?: Partial<ConnectAuthState>;
}) {
  const verifyDeviceToken = createVerifyDeviceToken(params.result);
  const decision = await resolveDeviceTokenDecision({
    verifyDeviceToken,
    ...(params.scopes ? { scopes: params.scopes } : {}),
    ...(params.stateOverrides ? { stateOverrides: params.stateOverrides } : {}),
  });
  return { decision, verifyDeviceToken };
}

async function resolveBootstrapCandidateWithRateLimiter(params: {
  rateLimiter: AuthRateLimiter;
  verifyBootstrapToken: VerifyBootstrapTokenFn;
  withDeviceFallback?: boolean;
}) {
  const verifyDeviceToken = createVerifyDeviceToken({ ok: true });
  const decision = await resolveBootstrapCandidateDecision({
    verifyBootstrapToken: params.verifyBootstrapToken,
    verifyDeviceToken,
    rateLimiter: params.rateLimiter,
    ...(params.withDeviceFallback ? { withDeviceFallback: true } : {}),
  });
  return { decision, verifyDeviceToken };
}

async function resolveBlockedBootstrapCandidate(params?: { withDeviceFallback?: boolean }) {
  const rateLimiter = createTokenBucketRateLimiter({
    "bootstrap-token": { allowed: false, retryAfterMs: 30_000 },
  });
  const verifyBootstrapToken = createVerifyBootstrapToken({ ok: true });
  const resolved = await resolveBootstrapCandidateWithRateLimiter({
    verifyBootstrapToken,
    rateLimiter: rateLimiter.limiter,
    ...(params?.withDeviceFallback ? { withDeviceFallback: true } : {}),
  });
  return { ...resolved, rateLimiter, verifyBootstrapToken };
}

async function resolveInvalidBootstrapCandidate(params?: { withDeviceFallback?: boolean }) {
  const rateLimiter = createTokenBucketRateLimiter();
  const verifyBootstrapToken = createVerifyBootstrapToken({
    ok: false,
    reason: "bootstrap_token_invalid",
  });
  const resolved = await resolveBootstrapCandidateWithRateLimiter({
    verifyBootstrapToken,
    rateLimiter: rateLimiter.limiter,
    ...(params?.withDeviceFallback ? { withDeviceFallback: true } : {}),
  });
  return { ...resolved, rateLimiter };
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

function expectBootstrapTokenAccepted(params: {
  decision: Awaited<ReturnType<typeof resolveConnectAuthDecision>>;
  verifyBootstrapToken: ReturnType<typeof vi.fn<VerifyBootstrapTokenFn>>;
  verifyDeviceToken: ReturnType<typeof vi.fn<VerifyDeviceTokenFn>>;
}) {
  expect(params.decision.authOk).toBe(true);
  expect(params.decision.authMethod).toBe("bootstrap-token");
  expect(params.verifyBootstrapToken).toHaveBeenCalledOnce();
  expect(params.verifyDeviceToken).not.toHaveBeenCalled();
}

describe("resolveConnectAuthDecision", () => {
  it("keeps shared-secret mismatch when fallback device-token check fails", async () => {
    const verifyDeviceToken = createVerifyDeviceToken({ ok: false });
    const verifyBootstrapToken = createVerifyBootstrapToken({
      ok: false,
      reason: "bootstrap_token_invalid",
    });
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
    const { decision } = await resolveRejectedDeviceTokenDecision({
      result: { ok: false },
      stateOverrides: {
        deviceTokenCandidateSource: "explicit-device-token",
      },
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("device_token_mismatch");
  });

  it("preserves explicit device-token scope mismatches", async () => {
    const { decision } = await resolveRejectedDeviceTokenDecision({
      result: { ok: false, reason: "scope-mismatch" },
      scopes: ["operator.admin"],
      stateOverrides: {
        deviceTokenCandidateSource: "explicit-device-token",
      },
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("scope_mismatch");
  });

  it("preserves fallback device-token scope mismatches over shared-token mismatch", async () => {
    const { decision } = await resolveRejectedDeviceTokenDecision({
      result: { ok: false, reason: "scope-mismatch" },
      scopes: ["operator.admin"],
      stateOverrides: {
        authResult: { ok: false, reason: "token_mismatch" },
        deviceTokenCandidateSource: "shared-token-fallback",
      },
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("scope_mismatch");
  });

  it("accepts valid device tokens and marks auth method as device-token", async () => {
    const rateLimiter = createRateLimiter();
    const verifyDeviceToken = createVerifyDeviceToken({ ok: true });
    const decision = await resolveDeviceTokenDecision({
      verifyDeviceToken,
      rateLimiter: rateLimiter.limiter,
      clientIp: CLIENT_IP,
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("device-token");
    expect(verifyDeviceToken).toHaveBeenCalledOnce();
    expect(rateLimiter.reset).toHaveBeenCalledWith(CLIENT_IP, "device-token");
  });

  it("accepts valid bootstrap tokens before device-token fallback", async () => {
    const verifyBootstrapToken = createVerifyBootstrapToken({ ok: true });
    const verifyDeviceToken = createVerifyDeviceToken({ ok: true });
    const decision = await resolveBootstrapCandidateDecision({
      verifyBootstrapToken,
      verifyDeviceToken,
      withDeviceFallback: true,
    });
    expectBootstrapTokenAccepted({
      decision,
      verifyBootstrapToken,
      verifyDeviceToken,
    });
  });

  it("reports invalid bootstrap tokens when no device token fallback is available", async () => {
    const verifyBootstrapToken = createVerifyBootstrapToken({
      ok: false,
      reason: "bootstrap_token_invalid",
    });
    const verifyDeviceToken = createVerifyDeviceToken({ ok: true });
    const decision = await resolveBootstrapCandidateDecision({
      verifyBootstrapToken,
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("bootstrap_token_invalid");
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it("returns rate-limited auth result without verifying device token", async () => {
    const rateLimiter = createRateLimiter({ allowed: false, retryAfterMs: 60_000 });
    const verifyDeviceToken = createVerifyDeviceToken({ ok: true });
    const decision = await resolveDeviceTokenDecision({
      verifyDeviceToken,
      rateLimiter: rateLimiter.limiter,
      clientIp: CLIENT_IP,
    });
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("rate_limited");
    expect(decision.authResult.retryAfterMs).toBe(60_000);
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it("still verifies the device token when only the shared-secret path is rate-limited", async () => {
    const verifyDeviceToken = createVerifyDeviceToken({ ok: true });
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
    const verifyBootstrapToken = createVerifyBootstrapToken({ ok: true });
    const verifyDeviceToken = createVerifyDeviceToken({ ok: true });
    const decision = await resolveSuccessfulNodeBootstrapDecision({
      verifyBootstrapToken,
      verifyDeviceToken,
    });
    expectBootstrapTokenAccepted({
      decision,
      verifyBootstrapToken,
      verifyDeviceToken,
    });
  });

  it("keeps the original successful auth path when bootstrap validation fails", async () => {
    const verifyBootstrapToken = createVerifyBootstrapToken({
      ok: false,
      reason: "bootstrap_token_invalid",
    });
    const verifyDeviceToken = createVerifyDeviceToken({ ok: true });
    const decision = await resolveSuccessfulNodeBootstrapDecision({
      verifyBootstrapToken,
      verifyDeviceToken,
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("tailscale");
    expect(verifyBootstrapToken).toHaveBeenCalledOnce();
    expect(verifyDeviceToken).not.toHaveBeenCalled();
  });

  it("gates bootstrap-token verify when the bootstrap-token bucket is exceeded", async () => {
    const { decision, verifyBootstrapToken } = await resolveBlockedBootstrapCandidate();
    expect(decision.authOk).toBe(false);
    expect(decision.authResult.reason).toBe("rate_limited");
    expect(decision.authResult.retryAfterMs).toBe(30_000);
    // The verify path is mutex-locked + does fs I/O — confirm we never invoke
    // it once the bucket is exhausted.
    expect(verifyBootstrapToken).not.toHaveBeenCalled();
  });

  it("still verifies the device token when only the bootstrap-token path is rate-limited", async () => {
    const { decision, verifyBootstrapToken, verifyDeviceToken } =
      await resolveBlockedBootstrapCandidate({
        withDeviceFallback: true,
      });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("device-token");
    expect(verifyBootstrapToken).not.toHaveBeenCalled();
    expect(verifyDeviceToken).toHaveBeenCalledOnce();
  });

  it("records a bootstrap-token failure when final auth rejects", async () => {
    const { rateLimiter } = await resolveInvalidBootstrapCandidate();
    expect(rateLimiter.recordFailure).toHaveBeenCalledWith(CLIENT_IP, "bootstrap-token");
    expect(rateLimiter.reset).not.toHaveBeenCalledWith(CLIENT_IP, "bootstrap-token");
  });

  it("does not record a bootstrap-token failure when device-token fallback succeeds", async () => {
    const { decision, rateLimiter } = await resolveInvalidBootstrapCandidate({
      withDeviceFallback: true,
    });
    expect(decision.authOk).toBe(true);
    expect(decision.authMethod).toBe("device-token");
    expect(rateLimiter.recordFailure).not.toHaveBeenCalledWith(CLIENT_IP, "bootstrap-token");
  });

  it("serializes concurrent bootstrap-token failures before checking the next attempt", async () => {
    const rateLimiter = createAuthRateLimiter({
      maxAttempts: 3,
      windowMs: 60_000,
      lockoutMs: 60_000,
      exemptLoopback: false,
      pruneIntervalMs: 0,
    });
    let activeBootstrapChecks = 0;
    let maxActiveBootstrapChecks = 0;
    const verifyBootstrapToken = vi.fn<VerifyBootstrapTokenFn>(async () => {
      activeBootstrapChecks += 1;
      maxActiveBootstrapChecks = Math.max(maxActiveBootstrapChecks, activeBootstrapChecks);
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      activeBootstrapChecks -= 1;
      return { ok: false, reason: "bootstrap_token_invalid" };
    });
    const verifyDeviceToken = createVerifyDeviceToken({ ok: true });
    try {
      const decisions = await Promise.all(
        Array.from(
          { length: 8 },
          async () =>
            await resolveDeviceTokenDecision({
              verifyBootstrapToken,
              verifyDeviceToken,
              rateLimiter,
              clientIp: CLIENT_IP,
              stateOverrides: createBootstrapOnlyState(),
            }),
        ),
      );
      const reasons = decisions.map((decision) => decision.authResult.reason);
      expect(reasons.filter((reason) => reason === "bootstrap_token_invalid")).toHaveLength(3);
      expect(reasons.filter((reason) => reason === "rate_limited")).toHaveLength(5);
      expect(verifyBootstrapToken).toHaveBeenCalledTimes(3);
      expect(maxActiveBootstrapChecks).toBe(1);
      expect(verifyDeviceToken).not.toHaveBeenCalled();
    } finally {
      rateLimiter.dispose();
    }
  });

  it("resets the bootstrap-token bucket when the verify succeeds", async () => {
    const rateLimiter = createTokenBucketRateLimiter();
    const verifyBootstrapToken = createVerifyBootstrapToken({ ok: true });
    const verifyDeviceToken = createVerifyDeviceToken({ ok: true });
    const decision = await resolveBootstrapCandidateDecision({
      verifyBootstrapToken,
      verifyDeviceToken,
      rateLimiter: rateLimiter.limiter,
    });
    expectBootstrapTokenAccepted({
      decision,
      verifyBootstrapToken,
      verifyDeviceToken,
    });
    expect(rateLimiter.reset).toHaveBeenCalledWith(CLIENT_IP, "bootstrap-token");
    expect(rateLimiter.recordFailure).not.toHaveBeenCalledWith(CLIENT_IP, "bootstrap-token");
  });
});
