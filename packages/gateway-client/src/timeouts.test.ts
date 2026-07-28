// Gateway Client tests cover timeouts behavior.
import { describe, expect, it } from "vitest";
import {
  addSafeTimeoutDelayGraceMs,
  getConnectChallengeTimeoutMsFromEnv,
  MAX_SAFE_TIMEOUT_DELAY_MS,
  resolveConnectChallengeTimeoutMs,
  resolveFiniteTimeoutDelayMs,
  resolvePreauthHandshakeTimeoutMs,
  resolveSafeTimeoutDelayMs,
} from "./timeouts.js";

describe("resolveSafeTimeoutDelayMs", () => {
  it("clamps to Node's signed-32-bit timer ceiling", () => {
    expect(resolveSafeTimeoutDelayMs(3_000_000_000)).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
  });

  it("falls back to the minimum for non-finite delays", () => {
    expect(resolveSafeTimeoutDelayMs(Number.NaN)).toBe(1);
    expect(resolveSafeTimeoutDelayMs(Number.POSITIVE_INFINITY, { minMs: 250 })).toBe(250);
  });

  it("preserves callers that intentionally allow zero-delay timers", () => {
    expect(resolveSafeTimeoutDelayMs(Number.NaN, { minMs: 0 })).toBe(0);
    expect(resolveSafeTimeoutDelayMs(-5, { minMs: 0 })).toBe(0);
  });
});

describe("addSafeTimeoutDelayGraceMs", () => {
  it("adds grace before applying Node timer bounds", () => {
    expect(addSafeTimeoutDelayGraceMs(10_000, 5_000)).toBe(15_000);
    expect(addSafeTimeoutDelayGraceMs(MAX_SAFE_TIMEOUT_DELAY_MS - 100, 500)).toBe(
      MAX_SAFE_TIMEOUT_DELAY_MS,
    );
  });

  it("caps overflowed finite sums instead of falling back to the minimum", () => {
    expect(addSafeTimeoutDelayGraceMs(Number.MAX_VALUE, 5_000)).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
  });
});

describe("resolveFiniteTimeoutDelayMs", () => {
  it("uses the fallback for missing or non-finite overrides", () => {
    expect(resolveFiniteTimeoutDelayMs(undefined, 10_000, { minMs: 0 })).toBe(10_000);
    expect(resolveFiniteTimeoutDelayMs(Number.NaN, 10_000, { minMs: 0 })).toBe(10_000);
    expect(resolveFiniteTimeoutDelayMs(Number.POSITIVE_INFINITY, 10_000, { minMs: 0 })).toBe(
      10_000,
    );
  });

  it("still clamps finite overrides through safe timer bounds", () => {
    expect(resolveFiniteTimeoutDelayMs(3_000_000_000, 10_000)).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(resolveFiniteTimeoutDelayMs(-5, 10_000, { minMs: 0 })).toBe(0);
  });
});

describe("gateway client handshake timeouts", () => {
  it("caps preauth handshake timeout env and config values to the safe timer range", () => {
    expect(
      resolvePreauthHandshakeTimeoutMs({
        env: { OPENCLAW_HANDSHAKE_TIMEOUT_MS: "3000000000" },
      }),
    ).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(
      resolvePreauthHandshakeTimeoutMs({
        env: {},
        configuredTimeoutMs: 3_000_000_000,
      }),
    ).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
  });

  it("accepts existing strict timeout env integer forms", () => {
    expect(
      resolvePreauthHandshakeTimeoutMs({
        env: { OPENCLAW_HANDSHAKE_TIMEOUT_MS: " +75000 " },
      }),
    ).toBe(75_000);
    expect(
      getConnectChallengeTimeoutMsFromEnv({
        OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS: " 015000 ",
      }),
    ).toBe(15_000);
  });

  it("caps connect challenge timeout env and explicit values to the safe timer range", () => {
    expect(
      getConnectChallengeTimeoutMsFromEnv({
        OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS: "3000000000",
      }),
    ).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(
      resolveConnectChallengeTimeoutMs(3_000_000_000, {
        env: {},
        configuredTimeoutMs: 3_000_000_000,
      }),
    ).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(
      resolveConnectChallengeTimeoutMs(undefined, {
        env: { OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS: "3000000000" },
      }),
    ).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
  });
});
