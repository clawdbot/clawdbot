import { describe, expect, it, vi } from "vitest";
import { MIN_PROMPT_BUDGET_RATIO, MIN_PROMPT_BUDGET_TOKENS } from "./pi-compaction-constants.js";
import {
  applyPiAutoCompactionGuard,
  applyPiCompactionSettingsFromConfig,
  DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
  isSilentOverflowProneModel,
  resolveEffectiveCompactionMode,
  resolveCompactionReserveTokensFloor,
  shouldDisablePiAutoCompaction,
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

  it("can restore reserveTokens after a simulated resource loader reload drops them below floor", () => {
    const cfg = {
      agents: {
        defaults: {
          compaction: { reserveTokensFloor: DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR },
        },
      },
    } as const;
    let reserve = 16_384;
    const keep = 20_000;
    const settingsManager = {
      getCompactionReserveTokens: () => reserve,
      getCompactionKeepRecentTokens: () => keep,
      applyOverrides: vi.fn((overrides: { compaction: { reserveTokens?: number } }) => {
        if (overrides.compaction.reserveTokens !== undefined) {
          reserve = overrides.compaction.reserveTokens;
        }
      }),
    };

    const first = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg,
      contextTokenBudget: 100_000,
    });
    expect(first.compaction.reserveTokens).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);

    reserve = 16_384;
    const second = applyPiCompactionSettingsFromConfig({
      settingsManager,
      cfg,
      contextTokenBudget: 100_000,
    });
    expect(second.compaction.reserveTokens).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
    expect(reserve).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
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
describe("resolveEffectiveCompactionMode", () => {
  it("defaults to default compaction mode", () => {
    expect(resolveEffectiveCompactionMode()).toBe("default");
    expect(resolveEffectiveCompactionMode({ agents: { defaults: { compaction: {} } } })).toBe(
      "default",
    );
    expect(
      resolveEffectiveCompactionMode({
        agents: { defaults: { compaction: { mode: "default" } } },
      }),
    ).toBe("default");
  });

  it("returns safeguard for explicit safeguard mode", () => {
    expect(
      resolveEffectiveCompactionMode({
        agents: { defaults: { compaction: { mode: "safeguard" } } },
      }),
    ).toBe("safeguard");
  });

  it("returns safeguard when a compaction provider is configured", () => {
    expect(
      resolveEffectiveCompactionMode({
        agents: { defaults: { compaction: { provider: "deepseek" } } },
      }),
    ).toBe("safeguard");
    expect(
      resolveEffectiveCompactionMode({
        agents: { defaults: { compaction: { mode: "default", provider: "deepseek" } } },
      }),
    ).toBe("safeguard");
  });
});

describe("isSilentOverflowProneModel", () => {
  // Reporter's repro shape: openrouter routing to z-ai/glm. Both the bare
  // `z-ai/...` form and the `openrouter/z-ai/...` qualified form must hit.
  it("flags z-ai-prefixed model ids regardless of qualifier", () => {
    expect(isSilentOverflowProneModel({ provider: "openrouter", modelId: "z-ai/glm-5.1" })).toBe(
      true,
    );
    expect(
      isSilentOverflowProneModel({ provider: "openrouter", modelId: "openrouter/z-ai/glm-5" }),
    ).toBe(true);
  });

  it("flags a config-set z.ai provider regardless of model id", () => {
    expect(isSilentOverflowProneModel({ provider: "z.ai", modelId: "glm-5.1" })).toBe(true);
    expect(isSilentOverflowProneModel({ provider: "z-ai", modelId: "glm-5.1" })).toBe(true);
  });

  it("flags a direct api.z.ai baseUrl via endpointClass", () => {
    expect(
      isSilentOverflowProneModel({
        provider: "openai",
        modelId: "glm-5.1",
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
      }),
    ).toBe(true);
  });

  // openclaw#75799 reporter's setup: an OpenAI-compatible in-house gateway
  // exposing Zhipu's GLM family directly (model id `glm-5.1`, no `z-ai/`
  // qualifier, custom baseUrl that is not api.z.ai). Catch the bare GLM
  // family name so direct gateway deployments hit the guard regardless of
  // what `provider` field the user picked — gateways relabel the upstream
  // identity, so `provider` here can be anything from `openai` to a custom
  // string. False positives only disable Pi's secondary compaction path;
  // OpenClaw's preemptive compaction continues to handle real overflow.
  it("flags bare glm- model ids without a namespace prefix, regardless of provider", () => {
    expect(isSilentOverflowProneModel({ provider: "custom", modelId: "glm-5.1" })).toBe(true);
    expect(isSilentOverflowProneModel({ provider: "custom", modelId: "glm-4.7" })).toBe(true);
    expect(isSilentOverflowProneModel({ provider: "openai", modelId: "glm-5.1" })).toBe(true);
    expect(isSilentOverflowProneModel({ provider: "openrouter", modelId: "glm-5.1" })).toBe(true);
  });

  // Detection is intentionally narrow to z.ai-style accounting. Namespaced GLM
  // ids that route through providers with their own overflow accounting must
  // NOT be flagged — those hosts may not exhibit the z.ai silent-overflow
  // shape, and disabling Pi auto-compaction for them would over-broaden the
  // kill surface beyond the reproducible repro.
  it("does not flag namespaced GLM ids routed through non-z.ai hosts", () => {
    expect(
      isSilentOverflowProneModel({ provider: "ollama", modelId: "ollama/glm-5.1:cloud" }),
    ).toBe(false);
    expect(
      isSilentOverflowProneModel({ provider: "opencode-go", modelId: "opencode-go/glm-5.1" }),
    ).toBe(false);
  });

  // pi-ai's overflow.ts only documents z.ai as the silent-overflow style. We
  // intentionally do NOT extend the guard to anthropic/openai/google/openrouter-
  // anthropic routes — adding them without a reproducible repro would broaden
  // the kill surface and regress baseline behavior for those providers.
  it("does not flag anthropic, openai, google or other routes", () => {
    expect(
      isSilentOverflowProneModel({ provider: "anthropic", modelId: "claude-sonnet-4.6" }),
    ).toBe(false);
    expect(isSilentOverflowProneModel({ provider: "openai", modelId: "gpt-5.5" })).toBe(false);
    expect(
      isSilentOverflowProneModel({
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4.6",
      }),
    ).toBe(false);
    expect(isSilentOverflowProneModel({ provider: "google", modelId: "gemini-2.5-pro" })).toBe(
      false,
    );
  });

  it("treats missing fields as not silent-overflow-prone", () => {
    expect(isSilentOverflowProneModel({})).toBe(false);
    expect(
      isSilentOverflowProneModel({ provider: undefined, modelId: undefined, baseUrl: null }),
    ).toBe(false);
  });
});

describe("shouldDisablePiAutoCompaction", () => {
  it("returns false with no owner, default mode, and ordinary provider behavior", () => {
    expect(shouldDisablePiAutoCompaction({})).toBe(false);
    expect(shouldDisablePiAutoCompaction({ compactionMode: "default" })).toBe(false);
    expect(
      shouldDisablePiAutoCompaction({
        contextEngineInfo: { id: "legacy", name: "Legacy", ownsCompaction: false },
        compactionMode: "default",
        silentOverflowProneProvider: false,
      }),
    ).toBe(false);
  });

  it("returns true when a context engine owns compaction", () => {
    expect(
      shouldDisablePiAutoCompaction({
        contextEngineInfo: { id: "third-party", name: "Third-party", ownsCompaction: true },
      }),
    ).toBe(true);
  });

  it("returns true when effective compaction mode is safeguard", () => {
    expect(shouldDisablePiAutoCompaction({ compactionMode: "safeguard" })).toBe(true);
  });

  it("returns true for silent-overflow-prone providers", () => {
    expect(shouldDisablePiAutoCompaction({ silentOverflowProneProvider: true })).toBe(true);
  });
});

describe("applyPiAutoCompactionGuard", () => {
  // Direct repro of openclaw#75799: pi-ai's silent-overflow detection misfires
  // on a successful turn against z.ai-style providers, triggering Pi's
  // _runAutoCompaction from inside Session.prompt() and reassigning
  // agent.state.messages between the runner's prompt.submitted trajectory
  // event and the provider request. Disabling Pi auto-compaction here keeps
  // state.messages intact; OpenClaw's preemptive compaction continues to
  // handle real overflow on its own path.
  it("disables Pi auto-compaction for silent-overflow-prone providers", () => {
    const setCompactionEnabled = vi.fn();
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      getCompactionKeepRecentTokens: () => 4_000,
      applyOverrides: () => {},
      setCompactionEnabled,
    };

    const result = applyPiAutoCompactionGuard({
      settingsManager,
      silentOverflowProneProvider: true,
    });

    expect(result).toEqual({ supported: true, disabled: true });
    expect(setCompactionEnabled).toHaveBeenCalledWith(false);
  });

  it("disables Pi auto-compaction when a context engine plugin owns compaction", () => {
    const setCompactionEnabled = vi.fn();
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      getCompactionKeepRecentTokens: () => 4_000,
      applyOverrides: () => {},
      setCompactionEnabled,
    };

    const result = applyPiAutoCompactionGuard({
      settingsManager,
      contextEngineInfo: {
        id: "third-party",
        name: "Third-party Context Engine",
        version: "0.1.0",
        ownsCompaction: true,
      },
    });

    expect(result).toEqual({ supported: true, disabled: true });
    expect(setCompactionEnabled).toHaveBeenCalledWith(false);
  });

  it("disables Pi auto-compaction when provider config forces safeguard mode", () => {
    const setCompactionEnabled = vi.fn();
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      getCompactionKeepRecentTokens: () => 4_000,
      applyOverrides: () => {},
      setCompactionEnabled,
    };

    const result = applyPiAutoCompactionGuard({
      settingsManager,
      compactionMode: resolveEffectiveCompactionMode({
        agents: { defaults: { compaction: { provider: "deepseek" } } },
      }),
    });

    expect(result).toEqual({ supported: true, disabled: true });
    expect(setCompactionEnabled).toHaveBeenCalledWith(false);
  });

  // Default-mode runs against ordinary providers must keep Pi's auto-compaction
  // enabled. Disabling it across the board would silently remove Pi's
  // overflow-recovery path inside Session.prompt() for users who are not
  // affected by z.ai's silent-overflow accounting.
  it("leaves Pi auto-compaction alone for non-z.ai providers without engine ownership", () => {
    const setCompactionEnabled = vi.fn();
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      getCompactionKeepRecentTokens: () => 4_000,
      applyOverrides: () => {},
      setCompactionEnabled,
    };

    const result = applyPiAutoCompactionGuard({
      settingsManager,
      contextEngineInfo: {
        id: "legacy",
        name: "Legacy Context Engine",
        version: "1.0.0",
      },
      silentOverflowProneProvider: false,
    });

    expect(result).toEqual({ supported: true, disabled: false });
    expect(setCompactionEnabled).not.toHaveBeenCalled();
  });

  it("reports unsupported when the settings manager has no setCompactionEnabled hook", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      getCompactionKeepRecentTokens: () => 4_000,
      applyOverrides: () => {},
    };

    const result = applyPiAutoCompactionGuard({
      settingsManager,
      silentOverflowProneProvider: true,
    });

    expect(result).toEqual({ supported: false, disabled: false });
  });
});
