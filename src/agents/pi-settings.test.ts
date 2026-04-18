import { describe, expect, it, vi } from "vitest";
import { MIN_PROMPT_BUDGET_RATIO, MIN_PROMPT_BUDGET_TOKENS } from "./pi-compaction-constants.js";
import {
  applyPiCompactionSettingsFromConfig,
  DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
  resolveCompactionReserveTokensFloor,
} from "./pi-settings.js";

describe("applyPiCompactionSettingsFromConfig", () => {
  it("bumps reserveTokens when below floor", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({ settingsManager });

    expect(result.didOverride).toBe(true);
    expect(result.compaction.reserveTokens).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR },
    });
  });

  it("does not override when already above floor and not in safeguard mode", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 32_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: { agents: { defaults: { compaction: { mode: "default" } } } },
    });

    expect(result.didOverride).toBe(false);
    expect(result.compaction.reserveTokens).toBe(32_000);
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });

  it("applies explicit reserveTokens but still enforces floor", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 10_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: { reserveTokens: 12_000, reserveTokensFloor: 20_000 },
          },
        },
      },
    });

    expect(result.compaction.reserveTokens).toBe(20_000);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: 20_000 },
    });
  });

  it("applies keepRecentTokens when explicitly configured", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: {
              keepRecentTokens: 15_000,
            },
          },
        },
      },
    });

    expect(result.compaction.keepRecentTokens).toBe(15_000);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { keepRecentTokens: 15_000 },
    });
  });

  it("preserves current keepRecentTokens when safeguard mode leaves it unset", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 25_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: { agents: { defaults: { compaction: { mode: "safeguard" } } } },
    });

    expect(result.compaction.keepRecentTokens).toBe(20_000);
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });

  it("treats keepRecentTokens=0 as invalid and keeps the current setting", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 25_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: { agents: { defaults: { compaction: { mode: "safeguard", keepRecentTokens: 0 } } } },
    });

    expect(result.compaction.keepRecentTokens).toBe(20_000);
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });

  it("caps floor to context window ratio for small-context models", () => {
    // Pi SDK default reserveTokens is 16 384.  With a 16 384 context window
    // the default floor (20 000) exceeds the window.  The aligned cap
    // computes: minPromptBudget = min(8_000, floor(16_384 * 0.5)) = 8_000,
    // maxReserve = 16_384 - 8_000 = 8_384.  Since current (16_384) > capped
    // floor (8_384), no override is needed.
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: 16_384,
    });

    // Without the cap, reserveTokens would be bumped to 20_000.
    // With the cap, it stays at 16_384 (the current value).
    expect(result.compaction.reserveTokens).toBe(16_384);
    expect(result.compaction.reserveTokens).toBeLessThan(
      DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
    );
    expect(result.didOverride).toBe(false);
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });

  it("applies capped floor over user-configured reserveTokens when default floor exceeds context window", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    // User sets reserveTokens=2048 but NOT reserveTokensFloor (default 20_000 applies).
    // Pre-fix: target = max(2048, 20_000) = 20_000 → exceeds 16_384 context → infinite loop.
    // Post-fix: floor capped to 8_384 → target = max(2048, 8_384) = 8_384 → works.
    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: { reserveTokens: 2_048 },
          },
        },
      },
      contextTokenBudget: 16_384,
    });

    expect(result.didOverride).toBe(true);
    expect(result.compaction.reserveTokens).toBe(8_384); // capped floor wins over user's 2_048
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: 8_384 },
    });
  });

  it("applies capped floor when current reserve is below it on small-context models", () => {
    // Simulate a Pi SDK default of 4 096 with a 16 384 context window.
    // minPromptBudget = min(8_000, floor(16_384 * 0.5)) = 8_000.
    // maxReserve = 16_384 - 8_000 = 8_384.
    // Capped floor = min(20_000, 8_384) = 8_384.
    // targetReserveTokens = max(4_096, 8_384) = 8_384 → override applied.
    const settingsManager = {
      getCompactionReserveTokens: () => 4_096,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: 16_384,
    });

    const minPromptBudget = Math.min(
      MIN_PROMPT_BUDGET_TOKENS,
      Math.max(1, Math.floor(16_384 * MIN_PROMPT_BUDGET_RATIO)),
    );
    const expectedReserve = Math.max(0, 16_384 - minPromptBudget);
    expect(result.didOverride).toBe(true);
    expect(result.compaction.reserveTokens).toBe(expectedReserve);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: expectedReserve },
    });
  });

  it("respects user-configured reserveTokens below capped floor for small models", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    // User explicitly sets reserveTokens=2048 and reserveTokensFloor=0.
    // With contextTokenBudget=16384, the capped floor = min(0, 8192) = 0.
    // targetReserveTokens = max(2048, 0) = 2048.
    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg: {
        agents: {
          defaults: {
            compaction: { reserveTokens: 2_048, reserveTokensFloor: 0 },
          },
        },
      },
      contextTokenBudget: 16_384,
    });

    expect(result.compaction.reserveTokens).toBe(2_048);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: 2_048 },
    });
  });

  it("does not cap floor for mid-size models when maxReserve exceeds default floor", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    // 32 768 context window → minPromptBudget = min(8_000, floor(32_768 * 0.5)) = 8_000.
    // maxReserve = 32_768 - 8_000 = 24_768.
    // Since 24_768 > 20_000 (DEFAULT_FLOOR), the floor is NOT capped and stays at 20_000.
    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: 32_768,
    });

    expect(result.compaction.reserveTokens).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR },
    });
  });

  it("does not cap floor when context window is large enough", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    // 200 000 context window → maxReserve = 200_000 - 8_000 = 192_000.
    // floor (20 000) is well within that cap.
    const result = applyPiCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: 200_000,
    });

    expect(result.compaction.reserveTokens).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR },
    });
  });

  it("falls back to uncapped floor when contextTokenBudget is not provided", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    // No contextTokenBudget → backward-compatible behavior, floor = 20 000.
    const result = applyPiCompactionSettingsFromConfig({ settingsManager });

    expect(result.compaction.reserveTokens).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
  });
});

describe("resolveCompactionReserveTokensFloor", () => {
  it("returns the default when config is missing", () => {
    expect(resolveCompactionReserveTokensFloor()).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
  });

  it("accepts configured floors, including zero", () => {
    expect(
      resolveCompactionReserveTokensFloor({
        agents: { defaults: { compaction: { reserveTokensFloor: 24_000 } } },
      }),
    ).toBe(24_000);
    expect(
      resolveCompactionReserveTokensFloor({
        agents: { defaults: { compaction: { reserveTokensFloor: 0 } } },
      }),
    ).toBe(0);
  });
});
