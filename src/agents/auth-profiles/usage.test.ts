/**
 * Usage-state and failure cooldown tests for auth profiles.
 * Covers unusable-window helpers, provider bypasses, WHAM probes, and store
 * persistence hooks without contacting real providers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { MAX_DATE_TIMESTAMP_MS } from "../../shared/number-coercion.js";
import type { AuthProfileStore, ProfileUsageStats } from "./types.js";
import { resolveProfileUnusableUntil } from "./usage-state.js";
import {
  clearAuthProfileCooldown,
  clearExpiredCooldowns,
  isProfileInCooldown,
  markAuthProfileBlockedUntil,
  markAuthProfileFailure,
  maybeReprobeWhamBlockedProfiles,
  resolveProfilesUnavailableReason,
  resolveProfileUnusableUntilForDisplay,
} from "./usage.js";
import { testing as authProfileUsageTesting } from "./usage.test-support.js";

// Mirrors the module-local WHAM half-open reprobe interval contract (45 minutes).
const WHAM_HALF_OPEN_REPROBE_INTERVAL_MS = 45 * 60 * 1000;

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
  storeMocks.saveAuthProfileStore.mockReset();
  storeMocks.updateAuthProfileStoreWithLock.mockReset();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  storeMocks.updateAuthProfileStoreWithLock.mockResolvedValue({ version: 1, profiles: {} });
  authProfileUsageTesting.setDepsForTest({
    updateAuthProfileStoreWithLock: storeMocks.updateAuthProfileStoreWithLock,
  });
});

afterEach(() => {
  authProfileUsageTesting.setDepsForTest(null);
  authProfileUsageTesting.resetWhamReprobeStateForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function makeStore(usageStats: AuthProfileStore["usageStats"]): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-test" },
      "openai:api-key": { type: "api_key", provider: "openai", key: "sk-test-2" },
      "openai:default": {
        type: "oauth",
        provider: "openai",
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

function mockLockedUpdateForStore(store: AuthProfileStore): void {
  storeMocks.updateAuthProfileStoreWithLock.mockImplementationOnce(
    async (lockParams: { updater: (store: AuthProfileStore) => boolean }) => {
      const freshStore = structuredClone(store);
      lockParams.updater(freshStore);
      return freshStore;
    },
  );
}

function mockLockedUpdatesForStore(store: AuthProfileStore): void {
  storeMocks.updateAuthProfileStoreWithLock.mockImplementation(
    async (lockParams: { updater: (store: AuthProfileStore) => boolean }) => {
      const freshStore = structuredClone(store);
      lockParams.updater(freshStore);
      return freshStore;
    },
  );
}

function expectProfileErrorStateCleared(
  stats: NonNullable<AuthProfileStore["usageStats"]>[string] | undefined,
) {
  expect(stats?.blockedUntil).toBeUndefined();
  expect(stats?.blockedReason).toBeUndefined();
  expect(stats?.blockedScope).toBeUndefined();
  expect(stats?.cooldownUntil).toBeUndefined();
  expect(stats?.disabledUntil).toBeUndefined();
  expect(stats?.disabledReason).toBeUndefined();
  expect(stats?.errorCount).toBe(0);
  expect(stats?.failureCounts).toBeUndefined();
}

describe("resolveProfileUnusableUntil", () => {
  it("returns null when all values are missing or invalid", () => {
    expect(resolveProfileUnusableUntil({})).toBeNull();
    expect(resolveProfileUnusableUntil({ cooldownUntil: 0, disabledUntil: Number.NaN })).toBeNull();
    expect(resolveProfileUnusableUntil({ blockedUntil: MAX_DATE_TIMESTAMP_MS + 1 })).toBeNull();
  });

  it("returns the latest active timestamp", () => {
    expect(
      resolveProfileUnusableUntil({ blockedUntil: 300, cooldownUntil: 100, disabledUntil: 200 }),
    ).toBe(300);
    expect(resolveProfileUnusableUntil({ cooldownUntil: 300 })).toBe(300);
  });

  it("keeps legacy blockedModel rows profile-wide", () => {
    expect(
      resolveProfileUnusableUntil({ blockedUntil: 300, blockedModel: "model-a" }, "model-b"),
    ).toBe(300);
  });

  it("applies explicitly model-scoped blocks only to that model", () => {
    const stats = { blockedUntil: 300, blockedModel: "model-a", blockedScope: "model" as const };
    expect(resolveProfileUnusableUntil(stats, "model-a")).toBe(300);
    expect(resolveProfileUnusableUntil(stats, "model-b")).toBeNull();
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

  it("returns true when blockedUntil is in the future", () => {
    const store = makeStore({
      "openai:default": {
        blockedUntil: Date.now() + 60_000,
        blockedReason: "subscription_limit",
      },
    });
    expect(isProfileInCooldown(store, "openai:default")).toBe(true);
  });

  it("returns false when cooldownUntil has passed", () => {
    const store = makeStore({
      "anthropic:default": { cooldownUntil: Date.now() - 1_000 },
    });
    expect(isProfileInCooldown(store, "anthropic:default")).toBe(false);
  });

  it("returns false when cooldownUntil is out of range", () => {
    const store = makeStore({
      "anthropic:default": { cooldownUntil: MAX_DATE_TIMESTAMP_MS + 1 },
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

  it("returns false for a different model when cooldown is model-scoped (timeout) — #87462", () => {
    const store = makeStore({
      "google:default": {
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "timeout",
        cooldownModel: "gemini-3-flash-preview",
      },
    });
    // Other Google fallback models bypass the cooldown
    expect(isProfileInCooldown(store, "google:default", undefined, "gemini-3.1-flash-lite")).toBe(
      false,
    );
    expect(isProfileInCooldown(store, "google:default", undefined, "gemini-2.5-flash")).toBe(false);
    // Same model stays blocked
    expect(isProfileInCooldown(store, "google:default", undefined, "gemini-3-flash-preview")).toBe(
      true,
    );
    // No model specified — blocked (conservative)
    expect(isProfileInCooldown(store, "google:default")).toBe(true);
  });

  it("returns true for all models when timeout cooldownModel is undefined (legacy widened scope)", () => {
    const store = makeStore({
      "google:default": {
        cooldownUntil: Date.now() + 60_000,
        cooldownReason: "timeout",
        cooldownModel: undefined,
      },
    });
    expect(isProfileInCooldown(store, "google:default", undefined, "gemini-3-flash-preview")).toBe(
      true,
    );
    expect(isProfileInCooldown(store, "google:default", undefined, "gemini-3.1-flash-lite")).toBe(
      true,
    );
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

  it("bypasses model-scoped blocks and cooldowns for sibling models", () => {
    const now = Date.now();
    const store = makeStore({
      "google:default": {
        blockedUntil: now + 120_000,
        blockedReason: "subscription_limit",
        blockedModel: "gemini-3-flash-preview",
        blockedScope: "model",
        cooldownUntil: now + 60_000,
        cooldownReason: "timeout",
        cooldownModel: "gemini-3-flash-preview",
      },
    });
    expect(isProfileInCooldown(store, "google:default", now, "gemini-3-flash-preview")).toBe(true);
    expect(isProfileInCooldown(store, "google:default", now, "gemini-3.1-flash-lite")).toBe(false);
  });

  it("keeps legacy blockedModel rows active for sibling models", () => {
    const now = Date.now();
    const store = makeStore({
      "google:default": {
        blockedUntil: now + 120_000,
        blockedModel: "gemini-3-flash-preview",
      },
    });

    expect(isProfileInCooldown(store, "google:default", now, "gemini-3.1-flash-lite")).toBe(true);
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
    const lastFailureAt = Date.now() - 120_000;
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: Date.now() - 1_000,
        errorCount: 4,
        failureCounts: { rate_limit: 3, timeout: 1 },
        lastFailureAt,
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(true);

    const stats = store.usageStats?.["anthropic:default"];
    expect(stats?.cooldownUntil).toBeUndefined();
    expect(stats?.errorCount).toBe(0);
    expect(stats?.failureCounts).toBeUndefined();
    // lastFailureAt preserved for failureWindowMs decay
    expect(stats?.lastFailureAt).toBe(lastFailureAt);
  });

  it("clears expired blockedUntil and resets errorCount", () => {
    const lastFailureAt = Date.now() - 120_000;
    const store = makeStore({
      "openai:default": {
        blockedUntil: Date.now() - 1_000,
        blockedReason: "subscription_limit",
        blockedSource: "codex_rate_limits",
        errorCount: 4,
        failureCounts: { rate_limit: 4 },
        lastFailureAt,
      },
    });

    expect(clearExpiredCooldowns(store)).toBe(true);

    const stats = store.usageStats?.["openai:default"];
    expect(stats?.blockedUntil).toBeUndefined();
    expect(stats?.blockedReason).toBeUndefined();
    expect(stats?.blockedSource).toBeUndefined();
    expect(stats?.errorCount).toBe(0);
    expect(stats?.failureCounts).toBeUndefined();
    expect(stats?.lastFailureAt).toBe(lastFailureAt);
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
        cooldownUntil: Number.NaN,
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
    mockLockedUpdateForStore(store);

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
    mockLockedUpdateForStore(store);

    await clearAuthProfileCooldown({ store, profileId: "anthropic:default" });

    const stats = store.usageStats?.["anthropic:default"];
    expect(stats?.lastUsed).toBe(lastUsed);
    expect(stats?.lastFailureAt).toBe(lastFailureAt);
  });

  it("no-ops for unknown profile id", async () => {
    const store = makeStore(undefined);
    mockLockedUpdateForStore(store);
    await clearAuthProfileCooldown({ store, profileId: "nonexistent" });
    expect(store.usageStats).toBeUndefined();
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
    cfg?: OpenClawConfig;
  }): Promise<void> {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(params.now);
    mockLockedUpdateForStore(params.store);
    try {
      await markAuthProfileFailure({
        store: params.store,
        profileId: "anthropic:default",
        reason: params.reason,
        cfg: params.cfg,
      });
    } finally {
      dateNowSpy.mockRestore();
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

  it.each([
    {
      label: "cooldownUntil",
      reason: "rate_limit" as const,
      readUntil: (stats: WindowStats | undefined) => stats?.cooldownUntil,
    },
    {
      label: "disabledUntil",
      reason: "billing" as const,
      readUntil: (stats: WindowStats | undefined) => stats?.disabledUntil,
    },
  ])("keeps recomputed $label inside the valid Date range", async (testCase) => {
    const store = makeStore({});

    await markFailureAt({
      store,
      now: MAX_DATE_TIMESTAMP_MS,
      reason: testCase.reason,
    });

    const stats = store.usageStats?.["anthropic:default"];
    expect(testCase.readUntil(stats)).toBe(MAX_DATE_TIMESTAMP_MS);
  });

  it("preserves fractional disabled cooldown config durations", async () => {
    const now = 1_000_000;
    const store = makeStore({});

    await markFailureAt({
      store,
      now,
      reason: "billing",
      cfg: {
        auth: {
          cooldowns: {
            billingBackoffHours: 0.0166667,
          },
        },
      } as OpenClawConfig,
    });

    expect(store.usageStats?.["anthropic:default"]?.disabledUntil).toBe(now + 60_000);
  });
});

describe("markAuthProfileBlockedUntil", () => {
  it("keeps repeated same-model blocks scoped to that model", async () => {
    const now = Date.parse("2026-05-30T18:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const store = makeStore({
      "openai:default": {
        blockedUntil: now + 60_000,
        blockedModel: "gpt-5.4",
        blockedScope: "model",
      },
    });
    mockLockedUpdateForStore(store);
    try {
      await markAuthProfileBlockedUntil({
        store,
        profileId: "openai:default",
        blockedUntil: now + 120_000,
        source: "codex_rate_limits",
        modelId: "gpt-5.4",
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(store.usageStats?.["openai:default"]?.blockedModel).toBe("gpt-5.4");
    expect(store.usageStats?.["openai:default"]?.blockedScope).toBe("model");
    expect(isProfileInCooldown(store, "openai:default", now, "gpt-5.4")).toBe(true);
    expect(isProfileInCooldown(store, "openai:default", now, "gpt-5.4-mini")).toBe(false);
  });

  it("widens an active block after a different model fails", async () => {
    const now = Date.parse("2026-05-30T18:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const store = makeStore({
      "openai:default": {
        blockedUntil: now + 60_000,
        blockedModel: "gpt-5.4",
        blockedScope: "model",
      },
    });
    mockLockedUpdateForStore(store);
    try {
      await markAuthProfileBlockedUntil({
        store,
        profileId: "openai:default",
        blockedUntil: now + 120_000,
        source: "codex_rate_limits",
        modelId: "gpt-5.4-mini",
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(store.usageStats?.["openai:default"]?.blockedModel).toBeUndefined();
    expect(store.usageStats?.["openai:default"]?.blockedScope).toBeUndefined();
    expect(isProfileInCooldown(store, "openai:default", now, "gpt-5.4-mini")).toBe(true);
  });

  it("never narrows an active profile-wide block", async () => {
    const now = Date.parse("2026-05-30T18:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const store = makeStore({
      "openai:default": {
        blockedUntil: now + 60_000,
      },
    });
    mockLockedUpdateForStore(store);
    try {
      await markAuthProfileBlockedUntil({
        store,
        profileId: "openai:default",
        blockedUntil: now + 120_000,
        source: "codex_rate_limits",
        modelId: "gpt-5.4",
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(store.usageStats?.["openai:default"]?.blockedModel).toBeUndefined();
    expect(store.usageStats?.["openai:default"]?.blockedScope).toBeUndefined();
    expect(isProfileInCooldown(store, "openai:default", now, "gpt-5.4-mini")).toBe(true);
  });

  it("keeps a later active blocked-until timestamp", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-30T18:00:00.000Z"));
    const laterBlockedUntil = Date.parse("2031-01-01T00:00:00.000Z");
    const store = makeStore({
      "openai:default": {
        blockedUntil: laterBlockedUntil,
      },
    });
    mockLockedUpdateForStore(store);
    try {
      await markAuthProfileBlockedUntil({
        store,
        profileId: "openai:default",
        blockedUntil: Date.parse("2030-01-01T00:00:00.000Z"),
        source: "codex_rate_limits",
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(store.usageStats?.["openai:default"]?.blockedUntil).toBe(laterBlockedUntil);
  });

  it("ignores blocked-until updates when the process clock is invalid", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    const store = makeStore({});
    mockLockedUpdateForStore(store);
    try {
      await markAuthProfileBlockedUntil({
        store,
        profileId: "openai:default",
        blockedUntil: Date.parse("2030-01-01T00:00:00.000Z"),
        source: "codex_rate_limits",
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(store.usageStats).toEqual({});
    expect(storeMocks.saveAuthProfileStore).not.toHaveBeenCalled();
  });

  it("ignores blocked-until updates outside the valid Date range", async () => {
    const store = makeStore({});
    mockLockedUpdateForStore(store);

    await markAuthProfileBlockedUntil({
      store,
      profileId: "openai:default",
      blockedUntil: Number.MAX_SAFE_INTEGER,
      source: "codex_rate_limits",
    });

    expect(store.usageStats).toEqual({});
    expect(storeMocks.saveAuthProfileStore).not.toHaveBeenCalled();
  });
});

describe("markAuthProfileFailure — detail-less provider failures", () => {
  it("does not persist unverifiable failures for API-key profiles", async () => {
    const store = makeStore(undefined);
    store.profiles["azure-foundry:default"] = {
      type: "api_key",
      provider: "azure-foundry",
      key: "azure-foundry-test-key",
    };

    for (const profileId of ["azure-foundry:default", "openai:api-key"]) {
      await markAuthProfileFailure({
        store,
        profileId,
        reason: "no_error_details",
      });
    }

    expect(store.usageStats).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storeMocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();
    expect(storeMocks.saveAuthProfileStore).not.toHaveBeenCalled();
  });
});

describe("markAuthProfileFailure — locked update failure", () => {
  it("drops bookkeeping without an unlocked full-store save", async () => {
    const store = makeStore(undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const previousTestConsole = process.env.OPENCLAW_TEST_CONSOLE;
    const previousLogLevel = process.env.OPENCLAW_LOG_LEVEL;
    storeMocks.updateAuthProfileStoreWithLock.mockResolvedValueOnce(null);
    process.env.OPENCLAW_TEST_CONSOLE = "1";
    process.env.OPENCLAW_LOG_LEVEL = "warn";
    try {
      await markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "rate_limit",
      });
      expect(store.usageStats).toBeUndefined();
      expect(storeMocks.saveAuthProfileStore).not.toHaveBeenCalled();
      expect(
        consoleWarn.mock.calls.some(([line]) =>
          String(line).includes(
            "dropped auth profile bookkeeping after locked store update failed",
          ),
        ),
      ).toBe(true);
    } finally {
      if (previousTestConsole === undefined) {
        delete process.env.OPENCLAW_TEST_CONSOLE;
      } else {
        process.env.OPENCLAW_TEST_CONSOLE = previousTestConsole;
      }
      if (previousLogLevel === undefined) {
        delete process.env.OPENCLAW_LOG_LEVEL;
      } else {
        process.env.OPENCLAW_LOG_LEVEL = previousLogLevel;
      }
      consoleWarn.mockRestore();
    }
  });
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
    reason?: "rate_limit" | "no_error_details" | "unknown";
    mockLock?: boolean;
  }): Promise<void> {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(params.now);
    if (params.mockLock !== false) {
      mockLockedUpdateForStore(params.store);
    }
    try {
      await markAuthProfileFailure({
        store: params.store,
        profileId: "openai:default",
        reason: params.reason ?? "rate_limit",
      });
    } finally {
      dateNowSpy.mockRestore();
    }
  }

  it("half-opens a stale long WHAM block and clears it when capacity returns", async () => {
    const now = 1_700_000_000_000;
    const store = makeStore({
      "openai:default": {
        blockedUntil: now + 6 * 24 * 60 * 60 * 1000,
        blockedReason: "subscription_limit",
        blockedSource: "wham",
      },
    });
    mockWhamResponse(200, { rate_limit: { limit_reached: false } });
    mockLockedUpdatesForStore(store);

    maybeReprobeWhamBlockedProfiles({
      store,
      profileIds: ["openai:default"],
      now,
    });
    maybeReprobeWhamBlockedProfiles({
      store,
      profileIds: ["openai:default"],
      now,
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(store.usageStats?.["openai:default"]?.blockedUntil).toBeUndefined();
    });
    expect(store.usageStats?.["openai:default"]?.lastProbeAt).toBe(now);
    expect(storeMocks.updateAuthProfileStoreWithLock).toHaveBeenCalledTimes(2);
  });

  it("leaves non-WHAM blocks outside the half-open probe path", () => {
    const now = 1_700_000_000_000;
    const store = makeStore({
      "openai:default": {
        blockedUntil: now + 6 * 24 * 60 * 60 * 1000,
        blockedReason: "subscription_limit",
        blockedSource: "codex_rate_limits",
      },
    });

    maybeReprobeWhamBlockedProfiles({
      store,
      profileIds: ["openai:default"],
      now,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(storeMocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();
  });

  it("does not re-probe a WHAM block inside the half-open interval", () => {
    const now = 1_700_000_000_000;
    const store = makeStore({
      "openai:default": {
        blockedUntil: now + 6 * 24 * 60 * 60 * 1000,
        blockedReason: "subscription_limit",
        blockedSource: "wham",
        lastProbeAt: now - WHAM_HALF_OPEN_REPROBE_INTERVAL_MS + 1,
      },
    });

    maybeReprobeWhamBlockedProfiles({
      store,
      profileIds: ["openai:default"],
      now,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(storeMocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();
  });

  it("re-arms a stale WHAM block from the latest blocked snapshot", async () => {
    const now = 1_700_000_000_000;
    const store = makeStore({
      "openai:default": {
        blockedUntil: now + 6 * 24 * 60 * 60 * 1000,
        blockedReason: "subscription_limit",
        blockedSource: "wham",
        blockedModel: "gpt-5.5",
        blockedScope: "model",
      },
    });
    mockWhamResponse(200, {
      rate_limit: {
        limit_reached: true,
        primary_window: { used_percent: 100, reset_after_seconds: 3_600 },
      },
    });
    mockLockedUpdatesForStore(store);
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      maybeReprobeWhamBlockedProfiles({
        store,
        profileIds: ["openai:default"],
        forModel: "gpt-5.5",
        now,
      });
      await vi.waitFor(() => {
        expect(store.usageStats?.["openai:default"]?.blockedUntil).toBe(now + 3_600_000);
      });
    } finally {
      dateNowSpy.mockRestore();
    }
    expect(store.usageStats?.["openai:default"]?.lastProbeAt).toBe(now);
    expect(store.usageStats?.["openai:default"]?.blockedModel).toBe("gpt-5.5");
    expect(store.usageStats?.["openai:default"]?.blockedScope).toBe("model");
  });

  it("does not apply an available result over a newer WHAM block", async () => {
    const now = 1_700_000_000_000;
    const originalUntil = now + 6 * 24 * 60 * 60 * 1000;
    const newerUntil = originalUntil + 60_000;
    const store = makeStore({
      "openai:default": {
        blockedUntil: originalUntil,
        blockedReason: "subscription_limit",
        blockedSource: "wham",
        lastFailureAt: now - 1,
      },
    });
    let releaseResponse: ((response: Response) => void) | undefined;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        releaseResponse = resolve;
      }),
    );
    mockLockedUpdatesForStore(store);

    maybeReprobeWhamBlockedProfiles({
      store,
      profileIds: ["openai:default"],
      now,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const stats = store.usageStats?.["openai:default"];
    if (!stats || !releaseResponse) {
      throw new Error("expected claimed WHAM probe");
    }
    stats.blockedUntil = newerUntil;
    stats.lastFailureAt = now + 1;
    releaseResponse(Response.json({ rate_limit: { limit_reached: false } }));

    await vi.waitFor(() => {
      expect(storeMocks.updateAuthProfileStoreWithLock).toHaveBeenCalledTimes(2);
    });
    expect(store.usageStats?.["openai:default"]?.blockedUntil).toBe(newerUntil);
  });

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
      expectedMs: 7_200_000,
      exactBlocked: true,
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
      expectedMs: 7_200_000,
      exactBlocked: true,
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
      expectedMs: 28_800_000,
      exactBlocked: true,
    },
  ])("maps $label to the expected cooldown", async ({ response, expectedMs, exactBlocked }) => {
    const now = 1_700_000_000_000;
    const store = makeStore({});
    mockWhamResponse(200, response);

    await markCodexFailureAt({ store, now });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls.at(0) as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(init.method).toBe("GET");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer codex-access-token");
    expect(headers["ChatGPT-Account-Id"]).toBe("acct_test_123");
    expect(headers.originator).toBe("openclaw");
    expect(headers["User-Agent"]).toMatch(/^openclaw\//);
    const stats = store.usageStats?.["openai:default"];
    expect(stats?.lastProbeAt).toBe(now);
    if (exactBlocked) {
      expect(stats?.blockedUntil).toBe(now + expectedMs);
      expect(stats?.blockedReason).toBe("subscription_limit");
      expect(stats?.cooldownUntil).toBeUndefined();
    } else {
      expect(stats?.cooldownUntil).toBe(now + expectedMs);
    }
  });

  it("probes WHAM before recording an OpenAI OAuth detail-less failure", async () => {
    const now = 1_700_000_000_000;
    const store = makeStore(undefined);
    mockWhamResponse(200, {
      rate_limit: {
        limit_reached: false,
        primary_window: { used_percent: 45, reset_after_seconds: 9_000 },
      },
    });

    await markCodexFailureAt({ store, now, reason: "no_error_details" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBe(now + 15_000);
    expect(store.usageStats?.["openai:default"]?.failureCounts?.no_error_details).toBe(1);
  });

  it("does not apply a stale WHAM result after the profile changes", async () => {
    const now = 1_700_000_000_000;
    const store = makeStore(undefined);
    mockWhamResponse(200, {
      rate_limit: {
        limit_reached: false,
        primary_window: { used_percent: 45, reset_after_seconds: 9_000 },
      },
    });
    storeMocks.updateAuthProfileStoreWithLock.mockImplementationOnce(
      async (lockParams: { updater: (store: AuthProfileStore) => boolean }) => {
        const freshStore = structuredClone(store);
        freshStore.profiles["openai:default"] = {
          type: "api_key",
          provider: "openai",
          key: "rotated-api-key",
        };
        lockParams.updater(freshStore);
        return freshStore;
      },
    );

    await markCodexFailureAt({ store, now, reason: "no_error_details", mockLock: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.usageStats).toBeUndefined();
    expect(storeMocks.saveAuthProfileStore).not.toHaveBeenCalled();
  });

  it("maps HTTP 401 to a 12h cooldown", async () => {
    const now = 1_700_000_000_000;
    const store = makeStore({});
    mockWhamResponse(401);

    await markCodexFailureAt({ store, now });

    expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBe(now + 43_200_000);
  });

  it("skips WHAM probe for locally expired OAuth access tokens", async () => {
    const now = 1_700_000_000_000;
    const store = makeStore({});
    const profile = store.profiles["openai:default"];
    if (profile?.type !== "oauth") {
      throw new Error("expected OpenAI OAuth fixture");
    }
    profile.expires = now - 1;
    mockWhamResponse(401);

    await markCodexFailureAt({ store, now });

    expect(fetchMock).not.toHaveBeenCalled();
    const stats = store.usageStats?.["openai:default"];
    expect(stats?.cooldownUntil).toBe(now + 30_000);
    expect(stats?.cooldownReason).toBe("rate_limit");
  });

  it("maps HTTP 403 to a 24h cooldown", async () => {
    const now = 1_700_000_000_000;
    const store = makeStore({});
    mockWhamResponse(403);

    await markCodexFailureAt({ store, now });

    expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBe(now + 86_400_000);
  });

  it("maps other HTTP errors to a 5m cooldown", async () => {
    const now = 1_700_000_000_000;
    const store = makeStore({});
    mockWhamResponse(500);

    await markCodexFailureAt({ store, now });

    expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBe(now + 300_000);
  });

  it("cancels WHAM HTTP error response bodies", async () => {
    const now = 1_700_000_000_000;
    const store = makeStore({});
    const response = new Response("server busy", { status: 500 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    fetchMock.mockResolvedValueOnce(response);

    await markCodexFailureAt({ store, now });

    expect(cancel).toHaveBeenCalledOnce();
    expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBe(now + 300_000);
  });

  it("preserves a longer existing cooldown via max semantics", async () => {
    const now = 1_700_000_000_000;
    const existingCooldownUntil = now + 6 * 60 * 60 * 1000;
    const store = makeStore({
      "openai:default": {
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

    await markCodexFailureAt({ store, now });

    expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBe(existingCooldownUntil);
  });

  it("falls back to a 30s cooldown when the WHAM probe fails", async () => {
    const now = 1_700_000_000_000;
    const store = makeStore({});
    fetchMock.mockRejectedValueOnce(new Error("network unavailable"));

    await markCodexFailureAt({ store, now, reason: "unknown" });

    expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBe(now + 30_000);
  });

  it("keeps fallback WHAM cooldowns inside the valid Date range", async () => {
    const store = makeStore({});
    fetchMock.mockRejectedValueOnce(new Error("network unavailable"));

    await markCodexFailureAt({ store, now: MAX_DATE_TIMESTAMP_MS, reason: "unknown" });

    expect(store.usageStats?.["openai:default"]?.cooldownUntil).toBe(MAX_DATE_TIMESTAMP_MS);
  });

  it.each([
    ["reset_after_seconds", { reset_after_seconds: Number.MAX_SAFE_INTEGER }],
    ["reset_at", { reset_at: Number.MAX_SAFE_INTEGER }],
  ])("does not pin profiles from unsafe WHAM %s values", async (_label, resetFields) => {
    const now = 1_700_000_000_000;
    const store = makeStore({});
    mockWhamResponse(200, {
      rate_limit: {
        limit_reached: true,
        primary_window: { used_percent: 100, ...resetFields },
      },
    });

    await markCodexFailureAt({ store, now });

    const stats = store.usageStats?.["openai:default"];
    expect(stats?.blockedUntil).toBeUndefined();
    expect(stats?.cooldownUntil).toBe(now + 30_000);
    expect(stats?.cooldownReason).toBe("rate_limit");
  });

  it("leaves non-codex providers on the normal stepped backoff path", async () => {
    const now = 1_700_000_000_000;
    const store = makeStore({});

    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      mockLockedUpdateForStore(store);
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
    mockLockedUpdateForStore(params.store);
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
    mockLockedUpdateForStore(store);
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
    mockLockedUpdateForStore(store);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
