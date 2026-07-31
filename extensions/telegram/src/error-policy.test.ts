// Telegram tests cover error policy plugin behavior.
import { MAX_DATE_TIMESTAMP_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTelegramErrorScopeKey,
  resolveTelegramErrorPolicy,
  shouldSuppressTelegramError,
} from "./error-policy.js";

let scopeSequence = 0;
let accountId: string;

describe("telegram error policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    accountId = `work-${scopeSequence++}`;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves policy from the most specific config", () => {
    expect(
      resolveTelegramErrorPolicy({
        accountConfig: { errorPolicy: "once" },
        groupConfig: {},
        topicConfig: { errorPolicy: "silent" },
      }),
    ).toEqual({
      policy: "silent",
      cooldownMs: 14_400_000,
    });
  });

  it("suppresses only repeated matching errors within the same scope", () => {
    const scopeKey = buildTelegramErrorScopeKey({
      accountId,
      chatId: 42,
      threadId: 7,
    });

    expect(
      shouldSuppressTelegramError({
        scopeKey,
        cooldownMs: 1000,
        errorMessage: "429",
      }),
    ).toBe(false);
    expect(
      shouldSuppressTelegramError({
        scopeKey,
        cooldownMs: 1000,
        errorMessage: "429",
      }),
    ).toBe(true);
    expect(
      shouldSuppressTelegramError({
        scopeKey,
        cooldownMs: 1000,
        errorMessage: "403",
      }),
    ).toBe(false);
  });

  it("keeps cooldowns per error message within the same scope", () => {
    const scopeKey = buildTelegramErrorScopeKey({
      accountId,
      chatId: 42,
    });

    expect(
      shouldSuppressTelegramError({
        scopeKey,
        cooldownMs: 1000,
        errorMessage: "A",
      }),
    ).toBe(false);
    expect(
      shouldSuppressTelegramError({
        scopeKey,
        cooldownMs: 1000,
        errorMessage: "B",
      }),
    ).toBe(false);
    expect(
      shouldSuppressTelegramError({
        scopeKey,
        cooldownMs: 1000,
        errorMessage: "A",
      }),
    ).toBe(true);
  });

  it("prunes expired cooldowns within a single scope", () => {
    const scopeKey = buildTelegramErrorScopeKey({
      accountId,
      chatId: 42,
    });

    expect(
      shouldSuppressTelegramError({
        scopeKey,
        cooldownMs: 1000,
        errorMessage: "A",
      }),
    ).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(
      shouldSuppressTelegramError({
        scopeKey,
        cooldownMs: 1000,
        errorMessage: "B",
      }),
    ).toBe(false);
    expect(
      shouldSuppressTelegramError({
        scopeKey,
        cooldownMs: 1000,
        errorMessage: "A",
      }),
    ).toBe(false);
  });

  it("does not suppress or keep cooldowns when the process clock is invalid", () => {
    const scopeKey = buildTelegramErrorScopeKey({
      accountId,
      chatId: 42,
    });

    expect(
      shouldSuppressTelegramError({
        scopeKey,
        cooldownMs: 1000,
        errorMessage: "429",
      }),
    ).toBe(false);
    expect(
      shouldSuppressTelegramError({
        scopeKey,
        cooldownMs: 1000,
        errorMessage: "429",
      }),
    ).toBe(true);

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      expect(
        shouldSuppressTelegramError({
          scopeKey,
          cooldownMs: 1000,
          errorMessage: "429",
        }),
      ).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
    expect(
      shouldSuppressTelegramError({
        scopeKey,
        cooldownMs: 1000,
        errorMessage: "429",
      }),
    ).toBe(false);
  });

  it("does not store cooldowns whose expiry would exceed the Date range", () => {
    const scopeKey = buildTelegramErrorScopeKey({
      accountId,
      chatId: 42,
    });
    vi.setSystemTime(MAX_DATE_TIMESTAMP_MS);

    expect(
      shouldSuppressTelegramError({
        scopeKey,
        cooldownMs: 1000,
        errorMessage: "429",
      }),
    ).toBe(false);
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    expect(
      shouldSuppressTelegramError({
        scopeKey,
        cooldownMs: 1000,
        errorMessage: "429",
      }),
    ).toBe(false);
  });

  it("does not leak suppression across accounts or threads", () => {
    const workMain = buildTelegramErrorScopeKey({
      accountId,
      chatId: 42,
    });
    const personalMain = buildTelegramErrorScopeKey({
      accountId: "personal",
      chatId: 42,
    });
    const workTopic = buildTelegramErrorScopeKey({
      accountId,
      chatId: 42,
      threadId: 9,
    });

    expect(
      shouldSuppressTelegramError({
        scopeKey: workMain,
        cooldownMs: 1000,
        errorMessage: "429",
      }),
    ).toBe(false);
    expect(
      shouldSuppressTelegramError({
        scopeKey: personalMain,
        cooldownMs: 1000,
        errorMessage: "429",
      }),
    ).toBe(false);
    expect(
      shouldSuppressTelegramError({
        scopeKey: workTopic,
        cooldownMs: 1000,
        errorMessage: "429",
      }),
    ).toBe(false);
  });
});
