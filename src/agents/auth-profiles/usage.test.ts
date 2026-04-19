import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore, ProfileUsageStats } from "./types.js";
import {
  __testing as authProfileUsageTesting,
  clearAuthProfileCooldown,
  clearExpiredCooldowns,
  isProfileInCooldown,
  markAuthProfileFailure,
  markAuthProfileUsed,
  resolveProfilesUnavailableReason,
  resolveProfileUnusableUntil,
  resolveProfileUnusableUntilForDisplay,
} from "./usage.js";

const storeMocks = vi.hoisted(() => ({
  saveAuthProfileStore: vi.fn(),
  updateAuthProfileStoreWithLock: vi.fn().mockResolvedValue(null),
}));
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock("./store.js", () => ({
  updateAuthProfileStoreWithLock: storeMocks.updateAuthProfileStoreWithLock,
  saveAuthProfileStore: storeMocks.saveAuthProfileStore,
}));

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  storeMocks.updateAuthProfileStoreWithLock.mockResolvedValue(null);
  authProfileUsageTesting.setDepsForTest({
    saveAuthProfileStore: storeMocks.saveAuthProfileStore,
    updateAuthProfileStoreWithLock: storeMocks.updateAuthProfileStoreWithLock,
  });
});

function makeStore(usageStats: AuthProfileStore["usageStats"]): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-test" },
      "openai:default": { type: "api_key", provider: "openai", key: "sk-test-2" },
      "openai-codex:default": {
        type: "oauth",
        provider: "openai-codex",
        access: "codex-access-token",
        refresh: "codex-refresh-token",
        expires: 4_102_444_800_000,
        accountId: "acct_test_123",
      },
      "openrouter:default": { type: "api_key", provider: "openrouter", key: "sk-or-test" },
      "kilocode:default": { type: "api_key", provider: "kilocode", key: "sk-kc-test" },
    },
    usageStats,
  };
}

function expectProfileErrorStateCleared(
  stats: NonNullable<AuthProfileStore["usageStats"]>[string] | undefined,
) {
  expect(stats?.cooldownUntil).toBeUndefined();
  expect(stats?.disabledUntil).toBeUndefined();
  expect(stats?.disabledReason).toBeUndefined();
  expect(stats?.errorCount).toBe(0);
  expect(stats?.failureCounts).toBeUndefined();
}

describe("resolveProfileUnusableUntil", () => {
  it("returns null when both values are missing or invalid", () => {
    expect(resolveProfileUnusableUntil({})).toBeNull();
    expect(resolveProfileUnusableUntil({ cooldownUntil: 0, disabledUntil: Number.NaN })).toBeNull();
  });

  it("returns the latest active timestamp", () => {
    expect(resolveProfileUnusableUntil({ cooldownUntil: 100, disabledUntil: 200 })).toBe(200);
    expect(resolveProfileUnusableUntil({ cooldownUntil: 300 })).toBe(300);
  });
});

describe("resolveProfileUnusableUntilForDisplay", () => {
  it("hides cooldown markers for OpenRouter profiles", () => {
    const store = makeStore({
      "openrouter:default": {
        cooldownUntil: Date.now() + 60_000,
      },
    });

    expect(resolveProfileUnusableUntilForDisplay(store, "openrouter:default")).toBeNull();
  });

  it("keeps cooldown markers visible for other providers", () => {
    const until = Date.now() + 60_000;
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: until,
      },
    });

    expect(resolveProfileUnusableUntilForDisplay(store, "anthropic:default")).toBe(until);
  });
});

// ---------------------------------------------------------------------------
// isProfileInCooldown
// ---------------------------------------------------------------------------

describe("isProfileInCooldown", () => {
  it("returns false when profile has no usage stats", () => {
    const store = makeStore(undefined);
    expect(isProfileInCooldown(store, "anthropic:default")).toBe(false);
  });

  it("returns true when cooldownUntil is in the future", () => {
    const store = makeStore({
      "anthropic:default": { cooldownUntil: Date.now() + 60_000 },
    });
    expect(isProfileInCooldown(store, "anthropic:default")).toBe(true);
  });

  it("returns false when cooldownUntil has passed", () => {
    const store = makeStore({
      "anthropic:default": { cooldownUntil: Date.now() - 1_000 },
    });
    expect(isProfileInCooldown(store, "anthropic:default")).toBe(false);
  });

  it("returns true when disabledUntil is in the future (even if cooldownUntil expired)", () => {
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: Date.now() - 1_000,
        disabledUntil: Date.now() + 60_000,
      },
    });
    expect(isProfileInCooldown(store, "anthropic:default")).toBe(true);
  });

  it("returns false for OpenRouter even when cooldown fields exist", () => {
    const store = makeStore({
      "openrouter:default": {
        cooldownUntil: Date.now() + 60_000,
        disabledUntil: Date.now() + 60_000,
        disabledReason: "billing",
      },
    });
    expect(isProfileInCooldown(store, "openrouter:default")).toBe(false);
  });

  it("returns false for Kilocode even when cooldown fields exist", () => {
    const store = makeStore({
      "kilocode:default": {
        cooldownUntil: Date.now() + 60_000,
        disabledUntil: Date.now() + 60_000,
        disabledReason: "billing",
      },
    });
    expect(isProfileInCooldown(store, "kilocode:default")).toBe(false);
  });

  it("returns false for a different model when cooldown is model-scoped (rate_limit)", () => {
    const store = makeStore({
      "github-copilot:github": {
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "rate_limit",
        cooldownModel: "claude-sonnet-4.6",
      },
    });
    // Different model bypasses the cooldown
    expect(isProfileInCooldown(store, "github-copilot:github", undefined, "gpt-4.1")).toBe(false);
    // Same model is still blocked
    expect(
      isProfileInCooldown(store, "github-copilot:github", undefined, "claude-sonnet-4.6"),
    ).toBe(true);
    // No model specified — blocked (conservative)
    expect(isProfileInCooldown(store, "github-copilot:github")).toBe(true);
  });

  it("returns true for all models when cooldownModel is undefined (profile-wide)", () => {
    const store = makeStore({
      "github-copilot:github": {
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "rate_limit",
        cooldownModel: undefined,
      },
    });
    expect(
      isProfileInCooldown(store, "github-copilot:github", undefined, "claude-sonnet-4.6"),
    ).toBe(true);
    expect(isProfileInCooldown(store, "github-copilot:github", undefined, "gpt-4.1")).toBe(true);
  });

  it("does not bypass model-scoped cooldown when disabledUntil is active", () => {
    const store = makeStore({
      "github-copilot:github": {
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "rate_limit",
        cooldownModel: "claude-sonnet-4.6",
        disabledUntil: Date.now() + 120_000,
        disabledReason: "billing",
      },
    });
    // Even though cooldownModel is for a different model, billing disable
    // should keep the profile blocked for all models.
    expect(isProfileInCooldown(store, "github-copilot:github", undefined, "gpt-4.1")).toBe(true);
  });
});

describe("resolveProfilesUnavailableReason", () => {
  it("prefers active disabledReason when profiles are disabled", () => {
    const now = Date.now();
    const store = makeStore({
      "anthropic:default": {
        disabledUntil: now + 60_000,
        disabledReason: "billing",
      },
    });

    expect(
      resolveProfilesUnavailableReason({
        store,
        profileIds: ["anthropic:default"],
        now,
      }),
    ).toBe("billing");
  });

  it("returns auth_permanent for active permanent auth disables", () => {
    const now = Date.now();
    const store = makeStore({
      "anthropic:default": {
        disabledUntil: now + 60_000,
        disabledReason: "auth_permanent",
      },
    });

    expect(
      resolveProfilesUnavailableReason({
        store,
        profileIds: ["anthropic:default"],
        now,
      }),
    ).toBe("auth_permanent");
  });

  it("uses recorded non-rate-limit failure counts for active cooldown windows", () => {
    const now = Date.now();
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: now + 60_000,
        failureCounts: { auth: 3, rate_limit: 1 },
      },
    });

    expect(
      resolveProfilesUnavailableReason({
        store,
        profileIds: ["anthropic:default"],
        now,
      }),
    ).toBe("auth");
  });

  it("returns overloaded for active overloaded cooldown windows", () => {
    const now = Date.now();
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: now + 60_000,
        failureCounts: { overloaded: 2, rate_limit: 1 },
      },
    });

    expect(
      resolveProfilesUnavailableReason({
        store,
        profileIds: ["anthropic:default"],
        now,
      }),
    ).toBe("overloaded");
  });

  it("falls back to unknown when active cooldown has no reason history", () => {
    const now = Date.now();
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: now + 60_000,
      },
    });

    expect(
      resolveProfilesUnavailableReason({
        store,
        profileIds: ["anthropic:default"],
        now,
      }),
    ).toBe("unknown");
  });

  it("ignores expired windows and returns null when no profile is actively unavailable", () => {
    const now = Date.now();
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: now - 1_000,
        failureCounts: { auth: 5 },
      },
      "anthropic:backup": {
        disabledUntil: now - 500,
        disabledReason: "billing",
      },
    });

    expect(
      resolveProfilesUnavailableReason({
        store,
        profileIds: ["anthropic:default", "anthropic:backup"],
        now,
      }),
    ).toBeNull();
  });

  it("breaks ties by reason priority for equal active failure counts", () => {
    const now = Date.now();
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: now + 60_000,
        failureCounts: { timeout: 2, auth: 2 },
      },
    });

    expect(
      resolveProfilesUnavailableReason({
        store,
        profileIds: ["anthropic:default"],
        now,
      }),
    ).toBe("auth");
  });
});

// ---------------------------------------------------------------------------
// clearExpiredCooldowns
// ---------------------------------------------------------------------------

describe("clearExpiredCooldowns", () => {
  it("returns false on empty usageStats", () => {
    const store = makeStore(undefined);
    expect(clearExpiredCooldowns(store)).toBe(false);
  });

  it("returns false when no profiles have cooldowns", () => {
    const store = makeStore({
      "anthropic:default": { lastUsed: Date.now() },
    });
    expect(clearExpiredCooldowns(store)).toBe(false);
  });

  it("returns false when cooldown is still active", () => {
    const future = Date.now() + 300_000;
    const store = makeStore({
      "anthropic:default": { cooldownUntil: future, errorCount: 3 },
    });

    expect(clearExpiredCooldowns(store)).toBe(false);
    expect(store.usageStats?.["anthropic:default"]?.cooldownUntil).toBe(future);
    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(3);
  });

  it("clears expired cooldownUntil and resets errorCount", () => {
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: Date.now() - 1_000,
        errorCount: 4,
        failureCounts: { rate_limit: 3, timeout: 1 },
        lastFailureAt: Date.now() - 120_000,
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(true);

    const stats = store.usageStats?.["anthropic:default"];
    expect(stats?.cooldownUntil).toBeUndefined();
    expect(stats?.errorCount).toBe(0);
    expect(stats?.failureCounts).toBeUndefined();
    // lastFailureAt preserved for failureWindowMs decay
    expect(stats?.lastFailureAt).toBeDefined();
  });

  it("clears expired disabledUntil and disabledReason", () => {
    const store = makeStore({
      "anthropic:default": {
        disabledUntil: Date.now() - 1_000,
        disabledReason: "billing",
        errorCount: 2,
        failureCounts: { billing: 2 },
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(true);

    const stats = store.usageStats?.["anthropic:default"];
    expect(stats?.disabledUntil).toBeUndefined();
    expect(stats?.disabledReason).toBeUndefined();
    expect(stats?.errorCount).toBe(0);
    expect(stats?.failureCounts).toBeUndefined();
  });

  it("handles independent expiry: cooldown expired but disabled still active", () => {
    const future = Date.now() + 3_600_000;
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: Date.now() - 1_000,
        disabledUntil: future,
        disabledReason: "billing",
        errorCount: 5,
        failureCounts: { rate_limit: 3, billing: 2 },
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(true);

    const stats = store.usageStats?.["anthropic:default"];
    // cooldownUntil cleared
    expect(stats?.cooldownUntil).toBeUndefined();
    // disabledUntil still active — not touched
    expect(stats?.disabledUntil).toBe(future);
    expect(stats?.disabledReason).toBe("billing");
    // errorCount NOT reset because profile still has an active unusable window
    expect(stats?.errorCount).toBe(5);
    expect(stats?.failureCounts).toEqual({ rate_limit: 3, billing: 2 });
  });

  it("handles independent expiry: disabled expired but cooldown still active", () => {
    const future = Date.now() + 300_000;
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: future,
        disabledUntil: Date.now() - 1_000,
        disabledReason: "billing",
        errorCount: 3,
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(true);

    const stats = store.usageStats?.["anthropic:default"];
    expect(stats?.cooldownUntil).toBe(future);
    expect(stats?.disabledUntil).toBeUndefined();
    expect(stats?.disabledReason).toBeUndefined();
    // errorCount NOT reset because cooldown is still active
    expect(stats?.errorCount).toBe(3);
  });

  it("resets errorCount only when both cooldown and disabled have expired", () => {
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: Date.now() - 2_000,
        disabledUntil: Date.now() - 1_000,
        disabledReason: "billing",
        errorCount: 4,
        failureCounts: { rate_limit: 2, billing: 2 },
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(true);

    const stats = store.usageStats?.["anthropic:default"];
    expectProfileErrorStateCleared(stats);
  });

  it("processes multiple profiles independently", () => {
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: Date.now() - 1_000,
        errorCount: 3,
      },
      "openai:default": {
        cooldownUntil: Date.now() + 300_000,
        errorCount: 2,
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(true);

    // Anthropic: expired → cleared
    expect(store.usageStats?.["anthropic:default"]?.cooldownUntil).toBeUndefined();
    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(0);

    // OpenAI: still active → untouched
    expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBeGreaterThan(Date.now());
    expect(store.usageStats?.["openai:default"]?.errorCount).toBe(2);
  });

  it("accepts an explicit `now` timestamp for deterministic testing", () => {
    const fixedNow = 1_700_000_000_000;
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: fixedNow - 1,
        errorCount: 2,
      },
    });

    expect(clearExpiredCooldowns(store, fixedNow)).toBe(true);
    expect(store.usageStats?.["anthropic:default"]?.cooldownUntil).toBeUndefined();
    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(0);
  });

  it("clears cooldownUntil that equals exactly `now`", () => {
    const fixedNow = 1_700_000_000_000;
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: fixedNow,
        errorCount: 2,
      },
    });

    // ts >= cooldownUntil → should clear (cooldown "until" means the instant
    // at cooldownUntil the profile becomes available again).
    expect(clearExpiredCooldowns(store, fixedNow)).toBe(true);
    expect(store.usageStats?.["anthropic:default"]?.cooldownUntil).toBeUndefined();
    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(0);
  });

  it("ignores NaN and Infinity cooldown values", () => {
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: NaN,
        errorCount: 2,
      },
      "openai:default": {
        cooldownUntil: Infinity,
        errorCount: 3,
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(false);
    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(2);
    expect(store.usageStats?.["openai:default"]?.errorCount).toBe(3);
  });

  it("ignores zero and negative cooldown values", () => {
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: 0,
        errorCount: 1,
      },
      "openai:default": {
        cooldownUntil: -1,
        errorCount: 1,
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// clearAuthProfileCooldown
// ---------------------------------------------------------------------------

describe("clearAuthProfileCooldown", () => {
  it("clears all error state fields including disabledUntil and failureCounts", async () => {
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: Date.now() + 60_000,
        disabledUntil: Date.now() + 3_600_000,
        disabledReason: "billing",
        errorCount: 5,
        failureCounts: { billing: 3, rate_limit: 2 },
      },
    });

    await clearAuthProfileCooldown({ store, profileId: "anthropic:default" });

    const stats = store.usageStats?.["anthropic:default"];
    expectProfileErrorStateCleared(stats);
  });

  it("preserves lastUsed and lastFailureAt timestamps", async () => {
    const lastUsed = Date.now() - 10_000;
    const lastFailureAt = Date.now() - 5_000;
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: Date.now() + 60_000,
        errorCount: 3,
        lastUsed,
        lastFailureAt,
      },
    });

    await clearAuthProfileCooldown({ store, profileId: "anthropic:default" });

    const stats = store.usageStats?.["anthropic:default"];
    expect(stats?.lastUsed).toBe(lastUsed);
    expect(stats?.lastFailureAt).toBe(lastFailureAt);
  });

  it("no-ops for unknown profile id", async () => {
    const store = makeStore(undefined);
    await clearAuthProfileCooldown({ store, profileId: "nonexistent" });
    expect(store.usageStats).toBeUndefined();
  });
});

describe("markAuthProfileUsed", () => {
  it("updates usage stats and persists through the fallback save path when lock update misses", async () => {
    const store = makeStore({
      "anthropic:default": {
        errorCount: 3,
        cooldownUntil: Date.now() + 60_000,
      },
    });

    storeMocks.updateAuthProfileStoreWithLock.mockResolvedValue(null);

    await markAuthProfileUsed({
      store,
      profileId: "anthropic:default",
      agentDir: "/tmp/openclaw-auth-profiles-used",
    });

    expect(storeMocks.saveAuthProfileStore).toHaveBeenCalledWith(
      store,
      "/tmp/openclaw-auth-profiles-used",
    );
    expect(store.usageStats?.["anthropic:default"]?.errorCount).toBe(0);
    expect(store.usageStats?.["anthropic:default"]?.cooldownUntil).toBeUndefined();
    expect(store.usageStats?.["anthropic:default"]?.lastUsed).toEqual(expect.any(Number));
  });

  it("adopts locked store usage stats without saving locally when lock update succeeds", async () => {
    const store = makeStore({
      "anthropic:default": {
        errorCount: 3,
        cooldownUntil: Date.now() + 60_000,
      },
    });
    const lockedStore = makeStore({
      "anthropic:default": {
        lastUsed: 123_456,
        errorCount: 0,
      },
    });

    storeMocks.updateAuthProfileStoreWithLock.mockResolvedValue(lockedStore);

    await markAuthProfileUsed({
      store,
      profileId: "anthropic:default",
      agentDir: "/tmp/openclaw-auth-profiles-used",
    });

    expect(storeMocks.saveAuthProfileStore).not.toHaveBeenCalled();
    expect(store.usageStats).toEqual(lockedStore.usageStats);
  });
});

describe("markAuthProfileFailure — active windows do not extend on retry", () => {
  // Regression for https://github.com/openclaw/openclaw/issues/23516
  // When all providers are at saturation backoff (60 min) and retries fire every 30 min,
  // each retry was resetting cooldownUntil to now+60m, preventing recovery.
  type WindowStats = ProfileUsageStats;

  async function markFailureAt(params: {
    store: ReturnType<typeof makeStore>;
    now: number;
    reason: "rate_limit" | "billing" | "auth_permanent";
  }): Promise<void> {
    vi.useFakeTimers();
    vi.setSystemTime(params.now);
    try {
      await markAuthProfileFailure({
        store: params.store,
        profileId: "anthropic:default",
        reason: params.reason,
      });
    } finally {
      vi.useRealTimers();
    }
  }

  const activeWindowCases = [
    {
      label: "cooldownUntil",
      reason: "rate_limit" as const,
      buildUsageStats: (now: number): WindowStats => ({
        cooldownUntil: now + 50 * 60 * 1000,
        errorCount: 3,
        lastFailureAt: now - 10 * 60 * 1000,
      }),
      readUntil: (stats: WindowStats | undefined) => stats?.cooldownUntil,
    },
    {
      label: "disabledUntil",
      reason: "billing" as const,
      buildUsageStats: (now: number): WindowStats => ({
        disabledUntil: now + 20 * 60 * 60 * 1000,
        disabledReason: "billing",
        errorCount: 5,
        failureCounts: { billing: 5 },
        lastFailureAt: now - 60_000,
      }),
      readUntil: (stats: WindowStats | undefined) => stats?.disabledUntil,
    },
    {
      label: "disabledUntil(auth_permanent)",
      reason: "auth_permanent" as const,
      buildUsageStats: (now: number): WindowStats => ({
        disabledUntil: now + 50 * 60 * 1000,
        disabledReason: "auth_permanent",
        errorCount: 5,
        failureCounts: { auth_permanent: 5 },
        lastFailureAt: now - 60_000,
      }),
      readUntil: (stats: WindowStats | undefined) => stats?.disabledUntil,
    },
  ];

  for (const testCase of activeWindowCases) {
    it(`keeps active ${testCase.label} unchanged on retry`, async () => {
      const now = 1_000_000;
      const existingStats = testCase.buildUsageStats(now);
      const existingUntil = testCase.readUntil(existingStats);
      const store = makeStore({ "anthropic:default": existingStats });

      await markFailureAt({
        store,
        now,
        reason: testCase.reason,
      });

      const stats = store.usageStats?.["anthropic:default"];
      expect(testCase.readUntil(stats)).toBe(existingUntil);
    });
  }

  // When a cooldown/disabled window expires, the error count resets to prevent
  // stale counters from escalating the next cooldown (the root cause of
  // infinite cooldown loops — see #40989). The next failure should compute
  // backoff from errorCount=1, not from the accumulated stale count.
  const expiredWindowCases = [
    {
      label: "cooldownUntil",
      reason: "rate_limit" as const,
      buildUsageStats: (now: number): WindowStats => ({
        cooldownUntil: now - 60_000,
        errorCount: 3,
        lastFailureAt: now - 60_000,
      }),
      // errorCount resets → calculateAuthProfileCooldownMs(1) = 30_000 (stepped: 30s → 1m → 5m)
      expectedUntil: (now: number) => now + 30_000,
      readUntil: (stats: WindowStats | undefined) => stats?.cooldownUntil,
    },
    {
      label: "disabledUntil",
      reason: "billing" as const,
      buildUsageStats: (now: number): WindowStats => ({
        disabledUntil: now - 60_000,
        disabledReason: "billing",
        errorCount: 5,
        failureCounts: { billing: 2 },
        lastFailureAt: now - 60_000,
      }),
      // errorCount resets, billing count resets to 1 →
      // calculateDisabledLaneBackoffMs(1, 5h, 24h) = 5h
      expectedUntil: (now: number) => now + 5 * 60 * 60 * 1000,
      readUntil: (stats: WindowStats | undefined) => stats?.disabledUntil,
    },
    {
      label: "disabledUntil(auth_permanent)",
      reason: "auth_permanent" as const,
      buildUsageStats: (now: number): WindowStats => ({
        disabledUntil: now - 60_000,
        disabledReason: "auth_permanent",
        errorCount: 5,
        failureCounts: { auth_permanent: 2 },
        lastFailureAt: now - 60_000,
      }),
      // errorCount resets, auth_permanent count resets to 1 →
      // calculateDisabledLaneBackoffMs(1, 10m, 60m) = 10m
      expectedUntil: (now: number) => now + 10 * 60 * 1000,
      readUntil: (stats: WindowStats | undefined) => stats?.disabledUntil,
    },
  ];

  for (const testCase of expiredWindowCases) {
    it(`recomputes ${testCase.label} after the previous window expires`, async () => {
      const now = 1_000_000;
      const store = makeStore({
        "anthropic:default": testCase.buildUsageStats(now),
      });

      await markFailureAt({
        store,
        now,
        reason: testCase.reason,
      });

      const stats = store.usageStats?.["anthropic:default"];
      expect(testCase.readUntil(stats)).toBe(testCase.expectedUntil(now));
    });
  }
});

describe("markAuthProfileFailure — WHAM-aware Codex cooldowns", () => {
  function mockWhamResponse(status: number, body?: unknown): void {
    fetchMock.mockResolvedValueOnce(
      new Response(body === undefined ? "{}" : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  async function markCodexFailureAt(params: {
    store: ReturnType<typeof makeStore>;
    now: number;
    reason?: "rate_limit" | "unknown";
    useLock?: boolean;
  }): Promise<void> {
    vi.useFakeTimers();
    vi.setSystemTime(params.now);
    if (params.useLock) {
      storeMocks.updateAuthProfileStoreWithLock.mockImplementationOnce(
        async (lockParams: { updater: (store: AuthProfileStore) => boolean }) => {
          const freshStore = structuredClone(params.store);
          const changed = lockParams.updater(freshStore);
          return changed ? freshStore : null;
        },
      );
    }
    try {
      await markAuthProfileFailure({
        store: params.store,
        profileId: "openai-codex:default",
        reason: params.reason ?? "rate_limit",
      });
    } finally {
      vi.useRealTimers();
    }
  }

  it.each([
    {
      label: "burst contention",
      response: {
        rate_limit: {
          limit_reached: false,
          primary_window: { used_percent: 45, reset_after_seconds: 9_000 },
        },
      },
      expectedMs: 15_000,
    },
    {
      label: "personal rolling window",
      response: {
        rate_limit: {
          limit_reached: true,
          primary_window: { used_percent: 100, reset_after_seconds: 7_200 },
        },
      },
      expectedMs: 3_600_000,
    },
    {
      label: "team rolling window",
      response: {
        rate_limit: {
          limit_reached: true,
          primary_window: { used_percent: 100, reset_after_seconds: 7_200 },
          secondary_window: { used_percent: 85, reset_after_seconds: 201_600 },
        },
      },
      expectedMs: 3_600_000,
    },
    {
      label: "team weekly window",
      response: {
        rate_limit: {
          limit_reached: true,
          primary_window: { used_percent: 90, reset_after_seconds: 7_200 },
          secondary_window: { used_percent: 100, reset_after_seconds: 28_800 },
        },
      },
      expectedMs: 14_400_000,
    },
  ])("maps $label to the expected cooldown", async ({ response, expectedMs }) => {
    const now = 1_700_000_000_000;
    const store = makeStore({});
    mockWhamResponse(200, response);

    await markCodexFailureAt({ store, now });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer codex-access-token",
          "ChatGPT-Account-Id": "acct_test_123",
        }),
      }),
    );
    expect(store.usageStats?.["openai-codex:default"]?.cooldownUntil).toBe(now + expectedMs);
  });

  it("maps HTTP 401 to a 12h cooldown", async () => {
    const now = 1_700_000_000_000;
    const store = makeStore({});
    mockWhamResponse(401);

    await markCodexFailureAt({ store, now });

    expect(store.usageStats?.["openai-codex:default"]?.cooldownUntil).toBe(now + 43_200_000);
  });

  it("maps HTTP 403 to a 24h cooldown", async () => {
    const now = 1_700_000_000_000;
    const store = makeStore({});
    mockWhamResponse(403);

    await markCodexFailureAt({ store, now });

    expect(store.usageStats?.["openai-codex:default"]?.cooldownUntil).toBe(now + 86_400_000);
  });

  it("maps other HTTP errors to a 5m cooldown", async () => {
    const now = 1_700_000_000_000;
    const store = makeStore({});
    mockWhamResponse(500);

    await markCodexFailureAt({ store, now });

    expect(store.usageStats?.["openai-codex:default"]?.cooldownUntil).toBe(now + 300_000);
  });

  it("preserves a longer existing cooldown via max semantics", async () => {
    const now = 1_700_000_000_000;
    const existingCooldownUntil = now + 6 * 60 * 60 * 1000;
    const store = makeStore({
      "openai-codex:default": {
        cooldownUntil: existingCooldownUntil,
        cooldownReason: "rate_limit",
        errorCount: 2,
        lastFailureAt: now - 1_000,
      },
    });
    mockWhamResponse(200, {
      rate_limit: {
        limit_reached: false,
        primary_window: { used_percent: 25, reset_after_seconds: 300 },
      },
    });

    await markCodexFailureAt({ store, now, useLock: true });

    expect(store.usageStats?.["openai-codex:default"]?.cooldownUntil).toBe(existingCooldownUntil);
  });

  it("falls back to a 30s cooldown when the WHAM probe fails", async () => {
    const now = 1_700_000_000_000;
    const store = makeStore({});
    fetchMock.mockRejectedValueOnce(new Error("network unavailable"));

    await markCodexFailureAt({ store, now, reason: "unknown" });

    expect(store.usageStats?.["openai-codex:default"]?.cooldownUntil).toBe(now + 30_000);
  });

  it("leaves non-codex providers on the normal stepped backoff path", async () => {
    const now = 1_700_000_000_000;
    const store = makeStore({});

    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "rate_limit",
      });
    } finally {
      vi.useRealTimers();
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.usageStats?.["anthropic:default"]?.cooldownUntil).toBe(now + 30_000);
  });
});

describe("markAuthProfileFailure — per-model cooldown metadata", () => {
  function makeStoreWithCopilot(usageStats: AuthProfileStore["usageStats"]): AuthProfileStore {
    const store = makeStore(usageStats);
    store.profiles["github-copilot:github"] = {
      type: "api_key",
      provider: "github-copilot",
      key: "ghu_test",
    };
    return store;
  }

  async function markFailure(params: {
    store: ReturnType<typeof makeStoreWithCopilot>;
    now: number;
    modelId?: string;
  }): Promise<void> {
    vi.useFakeTimers();
    vi.setSystemTime(params.now);
    try {
      await markAuthProfileFailure({
        store: params.store,
        profileId: "github-copilot:github",
        reason: "rate_limit",
        modelId: params.modelId,
      });
    } finally {
      vi.useRealTimers();
    }
  }

  it("records cooldownModel on first rate_limit failure", async () => {
    const now = 1_000_000;
    const store = makeStoreWithCopilot({});
    await markFailure({ store, now, modelId: "claude-sonnet-4.6" });
    const stats = store.usageStats?.["github-copilot:github"];
    expect(stats?.cooldownReason).toBe("rate_limit");
    expect(stats?.cooldownModel).toBe("claude-sonnet-4.6");
  });

  it("widens cooldownModel to undefined when a different model fails during active cooldown", async () => {
    const now = 1_000_000;
    const store = makeStoreWithCopilot({
      "github-copilot:github": {
        cooldownUntil: now + 30_000,
        cooldownReason: "rate_limit",
        cooldownModel: "claude-sonnet-4.6",
        errorCount: 1,
        lastFailureAt: now - 1000,
      },
    });
    // Different model fails during active cooldown
    await markFailure({ store, now, modelId: "gpt-4.1" });
    const stats = store.usageStats?.["github-copilot:github"];
    // Scope widened to all models
    expect(stats?.cooldownModel).toBeUndefined();
    expect(stats?.cooldownReason).toBe("rate_limit");
  });

  it("preserves cooldownModel when the same model fails again during active cooldown", async () => {
    const now = 1_000_000;
    const store = makeStoreWithCopilot({
      "github-copilot:github": {
        cooldownUntil: now + 30_000,
        cooldownReason: "rate_limit",
        cooldownModel: "claude-sonnet-4.6",
        errorCount: 1,
        lastFailureAt: now - 1000,
      },
    });
    await markFailure({ store, now, modelId: "claude-sonnet-4.6" });
    const stats = store.usageStats?.["github-copilot:github"];
    expect(stats?.cooldownModel).toBe("claude-sonnet-4.6");
  });

  it("widens cooldownModel when rate_limit failure during active cooldown has no modelId", async () => {
    const now = 1_000_000;
    const store = makeStoreWithCopilot({
      "github-copilot:github": {
        cooldownUntil: now + 30_000,
        cooldownReason: "rate_limit",
        cooldownModel: "claude-sonnet-4.6",
        errorCount: 1,
        lastFailureAt: now - 1000,
      },
    });
    await markFailure({ store, now, modelId: undefined });
    const stats = store.usageStats?.["github-copilot:github"];
    expect(stats?.cooldownReason).toBe("rate_limit");
    expect(stats?.cooldownModel).toBeUndefined();
  });

  it("updates cooldownReason when auth failure occurs during active rate_limit window", async () => {
    const now = 1_000_000;
    const store = makeStoreWithCopilot({
      "github-copilot:github": {
        cooldownUntil: now + 30_000,
        cooldownReason: "rate_limit",
        cooldownModel: "claude-sonnet-4.6",
        errorCount: 1,
        lastFailureAt: now - 1000,
      },
    });
    await markAuthProfileFailure({
      store,
      profileId: "github-copilot:github",
      reason: "auth",
      modelId: "claude-opus-4.6",
    });
    const stats = store.usageStats?.["github-copilot:github"];
    // Reason should update to the new failure type, not stay as rate_limit
    expect(stats?.cooldownReason).toBe("auth");
    // Model scope should be cleared — auth failures are profile-wide
    expect(stats?.cooldownModel).toBeUndefined();
  });

  it("clears cooldownModel when non-rate_limit failure hits same model during active window", async () => {
    const now = 1_000_000;
    const store = makeStoreWithCopilot({
      "github-copilot:github": {
        cooldownUntil: now + 30_000,
        cooldownReason: "rate_limit",
        cooldownModel: "claude-sonnet-4.6",
        errorCount: 1,
        lastFailureAt: now - 1000,
      },
    });
    await markAuthProfileFailure({
      store,
      profileId: "github-copilot:github",
      reason: "auth",
      modelId: "claude-sonnet-4.6",
    });
    const stats = store.usageStats?.["github-copilot:github"];
    // Even same-model auth failure should clear model scope (auth is profile-wide)
    expect(stats?.cooldownReason).toBe("auth");
    expect(stats?.cooldownModel).toBeUndefined();
  });
});
