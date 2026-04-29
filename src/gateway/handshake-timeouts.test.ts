import { describe, expect, test } from "vitest";
import {
  clampConnectChallengeTimeoutMs,
  DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
  getConnectChallengeTimeoutMsFromEnv,
  getPreauthHandshakeTimeoutMsFromEnv,
  MAX_CONNECT_CHALLENGE_TIMEOUT_MS,
  MIN_CONNECT_CHALLENGE_TIMEOUT_MS,
  resolveConnectChallengeTimeoutMs,
  resolvePreauthHandshakeTimeoutMs,
} from "./handshake-timeouts.js";

describe("gateway handshake timeouts", () => {
  test("defaults connect challenge timeout to the shared pre-auth handshake timeout", () => {
    expect(resolveConnectChallengeTimeoutMs()).toBe(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
  });

  test("clamps connect challenge timeouts into the supported range", () => {
    expect(clampConnectChallengeTimeoutMs(0)).toBe(MIN_CONNECT_CHALLENGE_TIMEOUT_MS);
    expect(clampConnectChallengeTimeoutMs(2_000)).toBe(2_000);
    expect(clampConnectChallengeTimeoutMs(20_000)).toBe(MAX_CONNECT_CHALLENGE_TIMEOUT_MS);
    expect(clampConnectChallengeTimeoutMs(30_000, 30_000)).toBe(30_000);
  });

  test("prefers OPENCLAW_HANDSHAKE_TIMEOUT_MS and falls back on the test-only env", () => {
    expect(
      getPreauthHandshakeTimeoutMsFromEnv({
        OPENCLAW_HANDSHAKE_TIMEOUT_MS: "75",
        OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS: "20",
      }),
    ).toBe(75);
    expect(
      getPreauthHandshakeTimeoutMsFromEnv({
        OPENCLAW_HANDSHAKE_TIMEOUT_MS: "",
        OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS: "20",
        VITEST: "1",
      }),
    ).toBe(20);
  });

  test("resolves preauth handshake timeout with env over config over default", () => {
    expect(
      resolvePreauthHandshakeTimeoutMs({
        env: { OPENCLAW_HANDSHAKE_TIMEOUT_MS: "75000" },
        configuredTimeoutMs: 30_000,
      }),
    ).toBe(75_000);
    expect(
      resolvePreauthHandshakeTimeoutMs({
        env: {},
        configuredTimeoutMs: 30_000,
      }),
    ).toBe(30_000);
    expect(
      resolvePreauthHandshakeTimeoutMs({
        env: { OPENCLAW_HANDSHAKE_TIMEOUT_MS: "garbage" },
        configuredTimeoutMs: 30_000,
      }),
    ).toBe(30_000);
    expect(resolvePreauthHandshakeTimeoutMs({ env: {} })).toBe(
      DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS,
    );
  });

  test("resolves preauth handshake timeout from the test-only env before config", () => {
    expect(
      resolvePreauthHandshakeTimeoutMs({
        env: { VITEST: "1", OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS: "50" },
        configuredTimeoutMs: 30_000,
      }),
    ).toBe(50);
  });

  test("ignores invalid handshake timeout overrides and falls back safely", () => {
    expect(
      getPreauthHandshakeTimeoutMsFromEnv({
        OPENCLAW_HANDSHAKE_TIMEOUT_MS: "abc",
      }),
    ).toBe(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
    expect(
      getPreauthHandshakeTimeoutMsFromEnv({
        OPENCLAW_HANDSHAKE_TIMEOUT_MS: "-1",
      }),
    ).toBe(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
    expect(
      getPreauthHandshakeTimeoutMsFromEnv({
        OPENCLAW_HANDSHAKE_TIMEOUT_MS: "0",
      }),
    ).toBe(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
    expect(
      getPreauthHandshakeTimeoutMsFromEnv({
        OPENCLAW_HANDSHAKE_TIMEOUT_MS: " ",
        OPENCLAW_TEST_HANDSHAKE_TIMEOUT_MS: "20",
        VITEST: "1",
      }),
    ).toBe(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
  });

  test("getConnectChallengeTimeoutMsFromEnv reads OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS", () => {
    expect(getConnectChallengeTimeoutMsFromEnv({})).toBeUndefined();
    expect(
      getConnectChallengeTimeoutMsFromEnv({ OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS: "15000" }),
    ).toBe(15_000);
    expect(
      getConnectChallengeTimeoutMsFromEnv({ OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS: "garbage" }),
    ).toBeUndefined();
  });

  test("resolveConnectChallengeTimeoutMs falls back to env override", () => {
    const original = process.env.OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS;
    const originalHandshake = process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS;
    try {
      process.env.OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS = "5000";
      expect(resolveConnectChallengeTimeoutMs()).toBe(5_000);
      // Explicit value still takes precedence over env
      expect(resolveConnectChallengeTimeoutMs(3_000)).toBe(3_000);
      process.env.OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS = "";
      process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS = "30000";
      expect(resolveConnectChallengeTimeoutMs()).toBe(30_000);
    } finally {
      if (original === undefined) {
        delete process.env.OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS = original;
      }
      if (originalHandshake === undefined) {
        delete process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_HANDSHAKE_TIMEOUT_MS = originalHandshake;
      }
    }
  });

  test("resolveConnectChallengeTimeoutMs follows configured preauth timeout", () => {
    expect(
      resolveConnectChallengeTimeoutMs(undefined, { env: {}, configuredTimeoutMs: 30_000 }),
    ).toBe(30_000);
    expect(resolveConnectChallengeTimeoutMs(45_000, { env: {}, configuredTimeoutMs: 30_000 })).toBe(
      30_000,
    );
    expect(resolveConnectChallengeTimeoutMs(0, { env: {}, configuredTimeoutMs: 30_000 })).toBe(
      MIN_CONNECT_CHALLENGE_TIMEOUT_MS,
    );
  });
});
