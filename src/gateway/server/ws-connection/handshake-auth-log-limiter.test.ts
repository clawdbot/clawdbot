/**
 * WebSocket handshake auth log limiter tests.
 */
import { describe, expect, it } from "vitest";
import {
  buildHandshakeAuthLogKey,
  HandshakeAuthLogLimiter,
  shouldLimitMissingCredentialAuthLog,
} from "./handshake-auth-log-limiter.js";

describe("HandshakeAuthLogLimiter", () => {
  it("suppresses repeated selected failures for the same client key within the interval", () => {
    const limiter = new HandshakeAuthLogLimiter({ intervalMs: 1_000 });
    const key = buildHandshakeAuthLogKey({
      reason: "token_missing",
      remoteAddr: "127.0.0.1",
      client: "gateway:sessions.list",
      mode: "backend",
      authProvided: "none",
    });

    expect(limiter.register(key, 10_000)).toEqual({
      shouldLog: true,
      suppressedSinceLastLog: 0,
    });
    expect(limiter.register(key, 10_100)).toEqual({
      shouldLog: false,
      suppressedSinceLastLog: 0,
    });
    expect(limiter.register(key, 10_200)).toEqual({
      shouldLog: false,
      suppressedSinceLastLog: 0,
    });
    expect(limiter.register(key, 11_001)).toEqual({
      shouldLog: true,
      suppressedSinceLastLog: 2,
    });
  });

  it("does not suppress distinct clients", () => {
    const limiter = new HandshakeAuthLogLimiter({ intervalMs: 1_000 });

    expect(limiter.register("token_missing|127.0.0.1|gateway:sessions.list", 10)).toEqual({
      shouldLog: true,
      suppressedSinceLastLog: 0,
    });
    expect(limiter.register("token_missing|127.0.0.1|gateway:health", 20)).toEqual({
      shouldLog: true,
      suppressedSinceLastLog: 0,
    });
  });

  it("uses default limits for non-finite options", () => {
    const limiter = new HandshakeAuthLogLimiter({
      intervalMs: Number.NaN,
      maxEntries: Number.POSITIVE_INFINITY,
    });

    expect(limiter.register("first", 0)).toEqual({
      shouldLog: true,
      suppressedSinceLastLog: 0,
    });
    expect(limiter.register("first", 1_000)).toEqual({
      shouldLog: false,
      suppressedSinceLastLog: 0,
    });

    for (let i = 0; i < 256; i += 1) {
      limiter.register(`key-${i}`, i);
    }

    expect(limiter.register("first", 2_000)).toEqual({
      shouldLog: true,
      suppressedSinceLastLog: 0,
    });
  });

  it("only rate-limits benign missing-credential startup retries", () => {
    expect(
      shouldLimitMissingCredentialAuthLog({
        reason: "token_missing",
        authProvided: "none",
      }),
    ).toBe(true);
    expect(
      shouldLimitMissingCredentialAuthLog({
        reason: "password_missing",
        authProvided: "none",
      }),
    ).toBe(true);

    for (const reason of [
      "token_mismatch",
      "password_mismatch",
      "device_token_mismatch",
      "rate_limited",
      "token_missing_config",
    ]) {
      expect(
        shouldLimitMissingCredentialAuthLog({
          reason,
          authProvided: "none",
        }),
      ).toBe(false);
    }
    expect(
      shouldLimitMissingCredentialAuthLog({
        reason: "token_missing",
        authProvided: "token",
      }),
    ).toBe(false);
  });
});
