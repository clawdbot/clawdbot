import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
/**
 * Usage-state and failure cooldown tests for auth profiles.
 * Covers unusable-window helpers, provider bypasses, WHAM probes, and store
 * persistence hooks without contacting real providers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthProfileStore, ProfileUsageStats } from "./types.js";
import { resolveProfileUnusableUntil } from "./usage-state.js";
import {
  clearAuthProfileCooldown,
  clearExpiredCooldowns,
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  markAuthProfileBlockedUntil,
  markAuthProfileFailure,
  markInlineProviderApiKeyFailure,
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
  const now = 1_700_000_000_000;
  type CooldownCase = [
    name: string,
    profileId: string,
    stats: ProfileUsageStats | undefined,
    checks: Array<[forModel: string | undefined, expected: boolean]>,
  ];
  const activeCooldown = (
    reason: ProfileUsageStats["cooldownReason"],
    model: string | undefined,
    extra: Partial<ProfileUsageStats> = {},
  ): ProfileUsageStats => ({
    cooldownUntil: now + 60_000,
    cooldownReason: reason,
    cooldownModel: model,
    ...extra,
  });
  const cases: CooldownCase[] = [
    [
      "returns false when profile has no usage stats",
      "anthropic:default",
      undefined,
      [[undefined, false]],
    ],
    [
      "returns true when cooldownUntil is in the future",
      "anthropic:default",
      { cooldownUntil: now + 60_000 },
      [[undefined, true]],
    ],
    [
      "returns true when blockedUntil is in the future",
      "openai:default",
      { blockedUntil: now + 60_000, blockedReason: "subscription_limit" },
      [[undefined, true]],
    ],
    [
      "returns false when cooldownUntil has passed",
      "anthropic:default",
      { cooldownUntil: now - 1_000 },
      [[undefined, false]],
    ],
    [
      "returns false when cooldownUntil is out of range",
      "anthropic:default",
      { cooldownUntil: MAX_DATE_TIMESTAMP_MS + 1 },
      [[undefined, false]],
    ],
    [
      "returns true when disabledUntil is in the future (even if cooldownUntil expired)",
      "anthropic:default",
      { cooldownUntil: now - 1_000, disabledUntil: now + 60_000 },
      [[undefined, true]],
    ],
    [
      "returns false for OpenRouter even when cooldown fields exist",
      "openrouter:default",
      activeCooldown(undefined, undefined, {
        disabledUntil: now + 60_000,
        disabledReason: "billing",
      }),
      [[undefined, false]],
    ],
    [
      "returns false for Kilocode even when cooldown fields exist",
      "kilocode:default",
      activeCooldown(undefined, undefined, {
        disabledUntil: now + 60_000,
        disabledReason: "billing",
      }),
      [[undefined, false]],
    ],
    [
      "returns false for a different model when cooldown is model-scoped (rate_limit)",
      "github-copilot:github",
      activeCooldown("rate_limit", "claude-sonnet-4.6"),
      [
        ["gpt-4.1", false],
        ["claude-sonnet-4.6", true],
        [undefined, true],
      ],
    ],
    [
      "returns true for all models when cooldownModel is undefined (profile-wide)",
      "github-copilot:github",
      activeCooldown("rate_limit", undefined),
      [
        ["claude-sonnet-4.6", true],
        ["gpt-4.1", true],
      ],
    ],
    [
      "returns false for a different model when cooldown is model-scoped (timeout) — #87462",
      "google:default",
      activeCooldown("timeout", "gemini-3-flash-preview"),
      [
        ["gemini-3.1-flash-lite", false],
        ["gemini-2.5-flash", false],
        ["gemini-3-flash-preview", true],
        [undefined, true],
      ],
    ],
    [
      "returns true for all models when timeout cooldownModel is undefined (legacy widened scope)",
      "google:default",
      activeCooldown("timeout", undefined),
      [
        ["gemini-3-flash-preview", true],
        ["gemini-3.1-flash-lite", true],
      ],
    ],
    [
      "returns false for a different model when cooldown is model-scoped (model_not_found) — #116464",
      "github-copilot:github",
      activeCooldown("model_not_found", "claude-sonnet-4.6"),
      [
        ["gpt-4.1", false],
        ["claude-sonnet-4.6", true],
        [undefined, true],
      ],
    ],
    [
      "blocks all models when a model_not_found cooldown has no cooldownModel (profile-wide) — #116464",
      "github-copilot:github",
      activeCooldown("model_not_found", undefined),
      [
        ["gpt-4.1", true],
        ["claude-sonnet-4.6", true],
      ],
    ],
    [
      "does not bypass model-scoped cooldown when disabledUntil is active",
      "github-copilot:github",
      activeCooldown("rate_limit", "claude-sonnet-4.6", {
        disabledUntil: now + 120_000,
        disabledReason: "billing",
      }),
      [["gpt-4.1", true]],
    ],
    [
      "bypasses model-scoped blocks and cooldowns for sibling models",
      "google:default",
      activeCooldown("timeout", "gemini-3-flash-preview", {
        blockedUntil: now + 120_000,
        blockedReason: "subscription_limit",
        blockedModel: "gemini-3-flash-preview",
        blockedScope: "model",
      }),
      [
        ["gemini-3-flash-preview", true],
        ["gemini-3.1-flash-lite", false],
      ],
    ],
    [
      "keeps legacy blockedModel rows active for sibling models",
      "google:default",
      { blockedUntil: now + 120_000, blockedModel: "gemini-3-flash-preview" },
      [["gemini-3.1-flash-lite", true]],
    ],
  ];

  it.each(cases)("%s", (name, profileId, stats, checks) => {
    const store = makeStore(stats === undefined ? undefined : { [profileId]: stats });
    for (const [forModel, expected] of checks) {
      expect(
        isProfileInCooldown(store, profileId, now, forModel),
        `${name}: ${forModel ?? "profile-wide"}`,
      ).toBe(expected);
    }
  });
});

describe("getSoonestCooldownExpiry", () => {
  const now = 1_700_000_000_000;
  it.each([
    {
      name: "treats a model_not_found cooldown for the requested model as model-scoped — #116464",
      cooldownModel: "claude-sonnet-4.6",
      checks: [
        { forModel: "claude-sonnet-4.6", expected: now + 60_000 },
        { forModel: "gpt-4.1", expected: null },
      ],
    },
    {
      name: "keeps profile-wide cooldowns visible to all models",
      cooldownModel: undefined,
      checks: [{ forModel: "gpt-4.1", expected: now + 60_000 }],
    },
  ])("$name", ({ name, cooldownModel, checks }) => {
    const store = makeStore({
      "github-copilot:github": {
        cooldownUntil: now + 60_000,
        cooldownReason: "model_not_found",
        cooldownModel,
      },
    });
    for (const check of checks) {
      expect(
        getSoonestCooldownExpiry(store, ["github-copilot:github"], {
          now,
          forModel: check.forModel,
        }),
        `${name}: ${check.forModel}`,
      ).toBe(check.expected);
    }
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

  it("returns session_expired when every cooled profile has an expired session", () => {
    const now = Date.now();
    const store = makeStore({
      "anthropic:default": {
        cooldownUntil: now + 60_000,
        failureCounts: { session_expired: 1 },
      },
      "anthropic:backup": {
        cooldownUntil: now + 60_000,
        failureCounts: { session_expired: 1 },
      },
    });

    expect(
      resolveProfilesUnavailableReason({
        store,
        profileIds: ["anthropic:default", "anthropic:backup"],
        now,
      }),
    ).toBe("session_expired");
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
  const now = 1_700_000_000_000;
  type ClearExpiredCase = {
    name: string;
    usageStats: AuthProfileStore["usageStats"];
    expectedMutated: boolean;
    expectedUsageStats: AuthProfileStore["usageStats"];
    expectCleared?: boolean;
    explicitNow?: boolean;
  };
  const cases: ClearExpiredCase[] = [
    {
      name: "returns false on empty usageStats",
      usageStats: undefined,
      expectedMutated: false,
      expectedUsageStats: undefined,
    },
    {
      name: "returns false when no profiles have cooldowns",
      usageStats: { "anthropic:default": { lastUsed: now } },
      expectedMutated: false,
      expectedUsageStats: { "anthropic:default": { lastUsed: now } },
    },
    {
      name: "returns false when cooldown is still active",
      usageStats: { "anthropic:default": { cooldownUntil: now + 300_000, errorCount: 3 } },
      expectedMutated: false,
      expectedUsageStats: {
        "anthropic:default": { cooldownUntil: now + 300_000, errorCount: 3 },
      },
    },
    {
      name: "clears expired cooldownUntil and resets errorCount",
      usageStats: {
        "anthropic:default": {
          cooldownUntil: now - 1_000,
          errorCount: 4,
          failureCounts: { rate_limit: 3, timeout: 1 },
          lastFailureAt: now - 120_000,
        },
      },
      expectedMutated: true,
      expectCleared: true,
      expectedUsageStats: {
        "anthropic:default": {
          cooldownUntil: undefined,
          cooldownReason: undefined,
          cooldownModel: undefined,
          errorCount: 0,
          failureCounts: undefined,
          lastFailureAt: now - 120_000,
        },
      },
    },
    {
      name: "clears expired disabledUntil and disabledReason",
      usageStats: {
        "anthropic:default": {
          disabledUntil: now - 1_000,
          disabledReason: "billing",
          errorCount: 2,
          failureCounts: { billing: 2 },
        },
      },
      expectedMutated: true,
      expectCleared: true,
      expectedUsageStats: {
        "anthropic:default": {
          disabledUntil: undefined,
          disabledReason: undefined,
          errorCount: 0,
          failureCounts: undefined,
        },
      },
    },
    {
      name: "handles independent expiry: cooldown expired but disabled still active",
      usageStats: {
        "anthropic:default": {
          cooldownUntil: now - 1_000,
          disabledUntil: now + 3_600_000,
          disabledReason: "billing",
          errorCount: 5,
          failureCounts: { rate_limit: 3, billing: 2 },
        },
      },
      expectedMutated: true,
      expectedUsageStats: {
        "anthropic:default": {
          cooldownUntil: undefined,
          cooldownReason: undefined,
          cooldownModel: undefined,
          disabledUntil: now + 3_600_000,
          disabledReason: "billing",
          errorCount: 5,
          failureCounts: { rate_limit: 3, billing: 2 },
        },
      },
    },
    {
      name: "handles independent expiry: disabled expired but cooldown still active",
      usageStats: {
        "anthropic:default": {
          cooldownUntil: now + 300_000,
          disabledUntil: now - 1_000,
          disabledReason: "billing",
          errorCount: 3,
        },
      },
      expectedMutated: true,
      expectedUsageStats: {
        "anthropic:default": {
          cooldownUntil: now + 300_000,
          disabledUntil: undefined,
          disabledReason: undefined,
          errorCount: 3,
        },
      },
    },
    {
      name: "resets errorCount only when both cooldown and disabled have expired",
      usageStats: {
        "anthropic:default": {
          cooldownUntil: now - 2_000,
          disabledUntil: now - 1_000,
          disabledReason: "billing",
          errorCount: 4,
          failureCounts: { rate_limit: 2, billing: 2 },
        },
      },
      expectedMutated: true,
      expectCleared: true,
      expectedUsageStats: {
        "anthropic:default": {
          cooldownUntil: undefined,
          cooldownReason: undefined,
          cooldownModel: undefined,
          disabledUntil: undefined,
          disabledReason: undefined,
          errorCount: 0,
          failureCounts: undefined,
        },
      },
    },
    {
      name: "accepts an explicit `now` timestamp for deterministic testing",
      usageStats: { "anthropic:default": { cooldownUntil: now - 1, errorCount: 2 } },
      expectedMutated: true,
      expectCleared: true,
      explicitNow: true,
      expectedUsageStats: {
        "anthropic:default": {
          cooldownUntil: undefined,
          cooldownReason: undefined,
          cooldownModel: undefined,
          errorCount: 0,
          failureCounts: undefined,
        },
      },
    },
    {
      name: "clears cooldownUntil that equals exactly `now`",
      usageStats: { "anthropic:default": { cooldownUntil: now, errorCount: 2 } },
      expectedMutated: true,
      expectCleared: true,
      explicitNow: true,
      expectedUsageStats: {
        "anthropic:default": {
          cooldownUntil: undefined,
          cooldownReason: undefined,
          cooldownModel: undefined,
          errorCount: 0,
          failureCounts: undefined,
        },
      },
    },
    {
      name: "ignores NaN and Infinity cooldown values",
      usageStats: {
        "anthropic:default": { cooldownUntil: Number.NaN, errorCount: 2 },
        "openai:default": { cooldownUntil: Infinity, errorCount: 3 },
      },
      expectedMutated: false,
      expectedUsageStats: {
        "anthropic:default": { cooldownUntil: Number.NaN, errorCount: 2 },
        "openai:default": { cooldownUntil: Infinity, errorCount: 3 },
      },
    },
    {
      name: "ignores zero and negative cooldown values",
      usageStats: {
        "anthropic:default": { cooldownUntil: 0, errorCount: 1 },
        "openai:default": { cooldownUntil: -1, errorCount: 1 },
      },
      expectedMutated: false,
      expectedUsageStats: {
        "anthropic:default": { cooldownUntil: 0, errorCount: 1 },
        "openai:default": { cooldownUntil: -1, errorCount: 1 },
      },
    },
  ];

  it.each(cases)("$name", (testCase) => {
    const store = makeStore(structuredClone(testCase.usageStats));
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(clearExpiredCooldowns(store, testCase.explicitNow ? now : undefined)).toBe(
        testCase.expectedMutated,
      );
    } finally {
      nowSpy.mockRestore();
    }
    expect(store.usageStats).toEqual(testCase.expectedUsageStats);
    if (testCase.expectCleared) {
      expectProfileErrorStateCleared(store.usageStats?.["anthropic:default"]);
    }
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
});

describe("markAuthProfileBlockedUntil", () => {
  async function applyBlockedUntil(params: {
    store: AuthProfileStore;
    blockedUntil: number;
    now?: number;
    modelId?: string;
  }): Promise<void> {
    const nowSpy =
      params.now === undefined ? undefined : vi.spyOn(Date, "now").mockReturnValue(params.now);
    mockLockedUpdateForStore(params.store);
    try {
      await markAuthProfileBlockedUntil({
        store: params.store,
        profileId: "openai:default",
        blockedUntil: params.blockedUntil,
        source: "codex_rate_limits",
        modelId: params.modelId,
      });
    } finally {
      nowSpy?.mockRestore();
    }
  }

  it("keeps repeated same-model blocks scoped to that model", async () => {
    const now = Date.parse("2026-05-30T18:00:00.000Z");
    const store = makeStore({
      "openai:default": {
        blockedUntil: now + 60_000,
        blockedModel: "gpt-5.4",
        blockedScope: "model",
      },
    });
    await applyBlockedUntil({ store, now, blockedUntil: now + 120_000, modelId: "gpt-5.4" });

    expect(store.usageStats?.["openai:default"]?.blockedModel).toBe("gpt-5.4");
    expect(store.usageStats?.["openai:default"]?.blockedScope).toBe("model");
    expect(isProfileInCooldown(store, "openai:default", now, "gpt-5.4")).toBe(true);
    expect(isProfileInCooldown(store, "openai:default", now, "gpt-5.4-mini")).toBe(false);
  });

  it("widens an active block after a different model fails", async () => {
    const now = Date.parse("2026-05-30T18:00:00.000Z");
    const store = makeStore({
      "openai:default": {
        blockedUntil: now + 60_000,
        blockedModel: "gpt-5.4",
        blockedScope: "model",
      },
    });
    await applyBlockedUntil({ store, now, blockedUntil: now + 120_000, modelId: "gpt-5.4-mini" });

    expect(store.usageStats?.["openai:default"]?.blockedModel).toBeUndefined();
    expect(store.usageStats?.["openai:default"]?.blockedScope).toBeUndefined();
    expect(isProfileInCooldown(store, "openai:default", now, "gpt-5.4-mini")).toBe(true);
  });

  it("never narrows an active profile-wide block", async () => {
    const now = Date.parse("2026-05-30T18:00:00.000Z");
    const store = makeStore({
      "openai:default": {
        blockedUntil: now + 60_000,
      },
    });
    await applyBlockedUntil({ store, now, blockedUntil: now + 120_000, modelId: "gpt-5.4" });

    expect(store.usageStats?.["openai:default"]?.blockedModel).toBeUndefined();
    expect(store.usageStats?.["openai:default"]?.blockedScope).toBeUndefined();
    expect(isProfileInCooldown(store, "openai:default", now, "gpt-5.4-mini")).toBe(true);
  });

  it("keeps a later active blocked-until timestamp", async () => {
    const laterBlockedUntil = Date.parse("2031-01-01T00:00:00.000Z");
    const store = makeStore({
      "openai:default": {
        blockedUntil: laterBlockedUntil,
      },
    });
    await applyBlockedUntil({
      store,
      now: Date.parse("2026-05-30T18:00:00.000Z"),
      blockedUntil: Date.parse("2030-01-01T00:00:00.000Z"),
    });

    expect(store.usageStats?.["openai:default"]?.blockedUntil).toBe(laterBlockedUntil);
  });

  it("ignores blocked-until updates when the process clock is invalid", async () => {
    const store = makeStore({});
    await applyBlockedUntil({
      store,
      now: Number.NaN,
      blockedUntil: Date.parse("2030-01-01T00:00:00.000Z"),
    });

    expect(store.usageStats).toEqual({});
    expect(storeMocks.saveAuthProfileStore).not.toHaveBeenCalled();
  });

  it("ignores blocked-until updates outside the valid Date range", async () => {
    const store = makeStore({});
    await applyBlockedUntil({ store, blockedUntil: Number.MAX_SAFE_INTEGER });

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

describe("markInlineProviderApiKeyFailure", () => {
  it("does not cool an inline key after a provider timeout", async () => {
    const store = makeStore(undefined);

    await markInlineProviderApiKeyFailure({
      store,
      provider: "anthropic",
      reason: "timeout",
    });

    expect(store.usageStats).toBeUndefined();
    expect(storeMocks.updateAuthProfileStoreWithLock).not.toHaveBeenCalled();
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
    modelId?: string;
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
        modelId: params.modelId,
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

  it.each([
    {
      status: 401,
      expectedMs: 12 * 60 * 60 * 1000,
      expectedCooldownReason: "wham_token_expired",
      expectedUnavailableReason: "auth",
    },
    {
      status: 403,
      expectedMs: 24 * 60 * 60 * 1000,
      expectedCooldownReason: "wham_account_dead",
      expectedUnavailableReason: "auth_permanent",
    },
  ])(
    "persists WHAM HTTP $status auth classification and canonical fallback reason",
    async ({ status, expectedMs, expectedCooldownReason, expectedUnavailableReason }) => {
      const now = 1_700_000_000_000;
      const store = makeStore({});
      mockWhamResponse(status);

      await markCodexFailureAt({ store, now, modelId: "gpt-5.6-luna" });

      const stats = store.usageStats?.["openai:default"];
      expect(stats?.cooldownUntil).toBe(now + expectedMs);
      expect(stats?.cooldownReason).toBe(expectedCooldownReason);
      expect(stats?.cooldownModel).toBeUndefined();
      expect(
        resolveProfilesUnavailableReason({
          store,
          profileIds: ["openai:default"],
          now,
        }),
      ).toBe(expectedUnavailableReason);
    },
  );

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
  type FailureReason = Parameters<typeof markAuthProfileFailure>[0]["reason"];

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
    reason: FailureReason;
    modelId?: string;
    useFakeTime?: boolean;
  }): Promise<void> {
    if (params.useFakeTime !== false) {
      vi.useFakeTimers();
      vi.setSystemTime(params.now);
    }
    mockLockedUpdateForStore(params.store);
    try {
      await markAuthProfileFailure({
        store: params.store,
        profileId: "github-copilot:github",
        reason: params.reason,
        modelId: params.modelId,
      });
    } finally {
      if (params.useFakeTime !== false) {
        vi.useRealTimers();
      }
    }
  }

  const now = 1_000_000;
  const activeStats = (
    reason: FailureReason,
    modelId: string,
  ): NonNullable<AuthProfileStore["usageStats"]>[string] => ({
    cooldownUntil: now + 30_000,
    cooldownReason: reason,
    cooldownModel: modelId,
    errorCount: 1,
    lastFailureAt: now - 1_000,
  });
  const cases = [
    {
      name: "records cooldownModel on first rate_limit failure",
      initialStats: {},
      reason: "rate_limit",
      modelId: "claude-sonnet-4.6",
      expectedReason: "rate_limit",
      expectedModel: "claude-sonnet-4.6",
    },
    {
      name: "records cooldownModel on first model_not_found failure — #116464",
      initialStats: {},
      reason: "model_not_found",
      modelId: "claude-sonnet-4.6",
      expectedReason: "model_not_found",
      expectedModel: "claude-sonnet-4.6",
    },
    {
      name: "widens cooldownModel to undefined when a different model fails during active model_not_found cooldown",
      initialStats: activeStats("model_not_found", "claude-sonnet-4.6"),
      reason: "model_not_found",
      modelId: "gpt-4.1",
      expectedReason: "model_not_found",
      expectedModel: undefined,
    },
    {
      name: "preserves cooldownModel when the same model fails again during active model_not_found cooldown",
      initialStats: activeStats("model_not_found", "claude-sonnet-4.6"),
      reason: "model_not_found",
      modelId: "claude-sonnet-4.6",
      expectedReason: "model_not_found",
      expectedModel: "claude-sonnet-4.6",
    },
    {
      name: "widens cooldownModel when model_not_found failure during active cooldown has no modelId",
      initialStats: activeStats("model_not_found", "claude-sonnet-4.6"),
      reason: "model_not_found",
      modelId: undefined,
      expectedReason: "model_not_found",
      expectedModel: undefined,
    },
    {
      name: "keeps a healthy sibling model available after a model_not_found failure on the same profile — #116464",
      initialStats: {},
      reason: "model_not_found",
      modelId: "claude-sonnet-4.6",
      expectedReason: "model_not_found",
      expectedModel: "claude-sonnet-4.6",
      availability: [
        { modelId: "claude-sonnet-4.6", expected: true },
        { modelId: "gpt-4.1", expected: false },
      ],
    },
    {
      name: "widens cooldownModel to undefined when a different model fails during active cooldown",
      initialStats: activeStats("rate_limit", "claude-sonnet-4.6"),
      reason: "rate_limit",
      modelId: "gpt-4.1",
      expectedReason: "rate_limit",
      expectedModel: undefined,
    },
    {
      name: "preserves cooldownModel when the same model fails again during active cooldown",
      initialStats: activeStats("rate_limit", "claude-sonnet-4.6"),
      reason: "rate_limit",
      modelId: "claude-sonnet-4.6",
      expectedReason: "rate_limit",
      expectedModel: "claude-sonnet-4.6",
    },
    {
      name: "widens cooldownModel when rate_limit failure during active cooldown has no modelId",
      initialStats: activeStats("rate_limit", "claude-sonnet-4.6"),
      reason: "rate_limit",
      modelId: undefined,
      expectedReason: "rate_limit",
      expectedModel: undefined,
    },
    {
      name: "updates cooldownReason when auth failure occurs during active rate_limit window",
      initialStats: activeStats("rate_limit", "claude-sonnet-4.6"),
      reason: "auth",
      modelId: "claude-opus-4.6",
      expectedReason: "auth",
      expectedModel: undefined,
      useFakeTime: false,
    },
    {
      name: "clears cooldownModel when non-rate_limit failure hits same model during active window",
      initialStats: activeStats("rate_limit", "claude-sonnet-4.6"),
      reason: "auth",
      modelId: "claude-sonnet-4.6",
      expectedReason: "auth",
      expectedModel: undefined,
      useFakeTime: false,
    },
  ] satisfies Array<{
    name: string;
    initialStats: ProfileUsageStats;
    reason: FailureReason;
    modelId: string | undefined;
    expectedReason: FailureReason;
    expectedModel: string | undefined;
    availability?: Array<{ modelId: string; expected: boolean }>;
    useFakeTime?: boolean;
  }>;

  it.each(cases)("$name", async (testCase) => {
    const store = makeStoreWithCopilot({
      "github-copilot:github": structuredClone(testCase.initialStats),
    });
    await markFailure({
      store,
      now,
      reason: testCase.reason,
      modelId: testCase.modelId,
      useFakeTime: testCase.useFakeTime,
    });

    const stats = store.usageStats?.["github-copilot:github"];
    expect(stats?.cooldownReason, `${testCase.name}: cooldownReason`).toBe(testCase.expectedReason);
    expect(stats?.cooldownModel, `${testCase.name}: cooldownModel`).toBe(testCase.expectedModel);
    for (const availability of testCase.availability ?? []) {
      expect(
        isProfileInCooldown(store, "github-copilot:github", now, availability.modelId),
        `${testCase.name}: ${availability.modelId}`,
      ).toBe(availability.expected);
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
