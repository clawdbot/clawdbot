import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTelegramErrorScopeKey,
  resolveTelegramErrorPolicy,
  resetTelegramErrorPolicyStoreForTest,
  shouldSuppressTelegramError,
} from "./error-policy.js";

describe("telegram error policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    resetTelegramErrorPolicyStoreForTest();
  });

  afterEach(() => {
    resetTelegramErrorPolicyStoreForTest();
    vi.useRealTimers();
  });

  it("resolves policy and cooldown from the most specific config", () => {
    expect(
      resolveTelegramErrorPolicy({
        accountConfig: { errorPolicy: "once", errorCooldownMs: 1000 },
        groupConfig: { errorCooldownMs: 2000 },
        topicConfig: { errorPolicy: "silent" },
      }),
    ).toEqual({
      policy: "silent",
      cooldownMs: 2000,
    });
  });

  it("suppresses only repeated matching errors within the same scope", () => {
    const scopeKey = buildTelegramErrorScopeKey({
      accountId: "work",
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
      accountId: "work",
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
      accountId: "work",
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

  it("does not leak suppression across accounts or threads", () => {
    const workMain = buildTelegramErrorScopeKey({
      accountId: "work",
      chatId: 42,
    });
    const personalMain = buildTelegramErrorScopeKey({
      accountId: "personal",
      chatId: 42,
    });
    const workTopic = buildTelegramErrorScopeKey({
      accountId: "work",
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
