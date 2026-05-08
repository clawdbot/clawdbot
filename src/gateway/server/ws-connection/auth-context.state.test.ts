import { describe, expect, it, vi } from "vitest";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "../../auth.js";
import { resolveConnectAuthDecision, resolveConnectAuthState } from "./auth-context.js";

function createLimiter() {
  return {
    check: vi.fn(() => ({ allowed: true, retryAfterMs: 5_000 })),
    reset: vi.fn(),
    recordFailure: vi.fn(),
  } as unknown as AuthRateLimiter;
}

describe("resolveConnectAuthState", () => {
  it("records shared-secret failures even when an explicit device token is also present", async () => {
    const rateLimiter = createLimiter();
    const state = await resolveConnectAuthState({
      resolvedAuth: {
        mode: "token",
        token: "correct-secret",
        allowTailscale: false,
      } satisfies ResolvedGatewayAuth,
      connectAuth: {
        token: "wrong-secret",
        deviceToken: "fake-device-token",
      },
      hasDeviceIdentity: true,
      req: {
        headers: {},
        socket: { remoteAddress: "203.0.113.20" },
      } as never,
      trustedProxies: [],
      allowRealIpFallback: false,
      rateLimiter,
      clientIp: "203.0.113.20",
    });

    expect(state.authOk).toBe(false);
    expect(state.authResult.reason).toBe("token_mismatch");
    expect(
      (rateLimiter as never as { recordFailure: ReturnType<typeof vi.fn> }).recordFailure,
    ).toHaveBeenCalled();
  });

  it("does not apply shared-secret lockouts to explicit device-token-only handshakes", async () => {
    const rateLimiter = {
      check: vi.fn(() => ({ allowed: false, retryAfterMs: 5_000 })),
      reset: vi.fn(),
      recordFailure: vi.fn(),
    } as unknown as AuthRateLimiter;

    const state = await resolveConnectAuthState({
      resolvedAuth: {
        mode: "token",
        token: "correct-secret",
        allowTailscale: false,
      } satisfies ResolvedGatewayAuth,
      connectAuth: {
        deviceToken: "device-token-only",
      },
      hasDeviceIdentity: true,
      req: {
        headers: {},
        socket: { remoteAddress: "203.0.113.20" },
      } as never,
      trustedProxies: [],
      allowRealIpFallback: false,
      rateLimiter,
      clientIp: "203.0.113.20",
    });

    expect(state.authOk).toBe(false);
    expect(state.authResult.rateLimited).not.toBe(true);
    expect(
      (rateLimiter as never as { check: ReturnType<typeof vi.fn> }).check,
    ).not.toHaveBeenCalled();
  });
});

describe("resolveConnectAuthDecision", () => {
  it("sets sharedAuthOk false when auth mode is none (no shared secret provided)", async () => {
    const state = await resolveConnectAuthState({
      resolvedAuth: {
        mode: "none",
        allowTailscale: false,
      } satisfies ResolvedGatewayAuth,
      connectAuth: {},
      hasDeviceIdentity: false,
      req: {
        headers: {},
        socket: { remoteAddress: "127.0.0.1" },
      } as never,
      trustedProxies: [],
      allowRealIpFallback: false,
      rateLimiter: createLimiter(),
      clientIp: "127.0.0.1",
    });

    expect(state.authOk).toBe(true);
    expect(state.authMethod).toBe("none");
    // auth:none does NOT set sharedAuthOk globally — it's not a shared secret.
    // Only shouldSkipLocalBackendSelfPairing treats auth:none as shared-auth-scoped
    // for local backend connections specifically.
    expect(state.sharedAuthOk).toBe(false);
  });

  it("resets the shared-secret limiter after device-token auth succeeds", async () => {
    const rateLimiter = createLimiter();
    await resolveConnectAuthDecision({
      state: {
        authResult: { ok: false, reason: "token_mismatch" },
        authOk: false,
        authMethod: "token",
        sharedAuthOk: false,
        sharedAuthProvided: true,
        deviceTokenCandidate: "device-token",
        deviceTokenCandidateSource: "explicit-device-token",
      },
      hasDeviceIdentity: true,
      deviceId: "dev-1",
      publicKey: "pub-1",
      role: "operator",
      scopes: ["operator.read"],
      verifyBootstrapToken: async () => ({ ok: false, reason: "bootstrap_token_invalid" }),
      verifyDeviceToken: async () => ({ ok: true }),
      rateLimiter,
      clientIp: "203.0.113.20",
    });

    expect(
      (rateLimiter as never as { reset: ReturnType<typeof vi.fn> }).reset,
    ).toHaveBeenCalledWith("203.0.113.20", "shared-secret");
  });
});
