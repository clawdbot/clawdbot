/** Tests agent compaction settings and small-context auto-compaction guards. */
import { describe, expect, it, vi } from "vitest";
import {
  applyAgentAutoCompactionGuard,
  applyAgentCompactionSettingsFromConfig,
  DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR,
  isSilentOverflowProneModel,
  resolveEffectiveCompactionMode,
} from "./agent-settings.js";
import { shouldCompact } from "./sessions/compaction/compaction.js";
import { SettingsManager } from "./sessions/settings-manager.js";

describe("applyAgentCompactionSettingsFromConfig", () => {
  it("bumps reserveTokens when below floor", () => {
    const settingsManager = SettingsManager.inMemory();
    const applyOverrides = vi.spyOn(settingsManager, "applyOverrides");

    const result = applyAgentCompactionSettingsFromConfig({ settingsManager });

    expect(result.didOverride).toBe(true);
    expect(result.compaction.reserveTokens).toBe(DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR);
    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR },
    });
  });

  it("can restore reserveTokens after a simulated resource loader reload drops them below floor", () => {
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

    const first = applyAgentCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: 100_000,
    });
    expect(first.compaction.reserveTokens).toBe(DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR);

    reserve = 16_384;
    const second = applyAgentCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: 100_000,
    });
    expect(second.compaction.reserveTokens).toBe(DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR);
    expect(reserve).toBe(DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR);
  });

  it("does not override when already above floor and not in safeguard mode", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 32_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyAgentCompactionSettingsFromConfig({
      settingsManager,
      cfg: { agents: { defaults: { compaction: { mode: "default" } } } },
    });

    expect(result.didOverride).toBe(false);
    expect(result.compaction.reserveTokens).toBe(32_000);
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });

  it("applies keepRecentTokens when explicitly configured", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyAgentCompactionSettingsFromConfig({
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

    const result = applyAgentCompactionSettingsFromConfig({
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

    const result = applyAgentCompactionSettingsFromConfig({
      settingsManager,
      cfg: { agents: { defaults: { compaction: { mode: "safeguard", keepRecentTokens: 0 } } } },
    });

    expect(result.compaction.keepRecentTokens).toBe(20_000);
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });

  it("caps the effective reserve so small-context models do not compact at token one", () => {
    // Embedded runner default reserveTokens is 16 384. With a 16 384 context window
    // both the default reserve and floor exceed the safe maximum of 8 384.
    const settingsManager = SettingsManager.inMemory();
    const applyOverrides = vi.spyOn(settingsManager, "applyOverrides");

    const result = applyAgentCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: 16_384,
    });

    expect(result.compaction).toEqual({ reserveTokens: 8_384, keepRecentTokens: 20_000 });
    expect(result.didOverride).toBe(true);
    expect(applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: 8_384 },
    });
    expect(settingsManager.getCompactionSettings()).toEqual({
      enabled: true,
      reserveTokens: 8_384,
      keepRecentTokens: 20_000,
    });
    expect(shouldCompact(1, 16_384, { enabled: true, ...result.compaction })).toBe(false);
  });

  it("applies capped floor when current reserve is below it on small-context models", () => {
    // Simulate an embedded runner default of 4 096 with a 16 384 context window.
    // minPromptBudget = min(8_000, floor(16_384 * 0.5)) = 8_000.
    // maxReserve = 16_384 - 8_000 = 8_384.
    const settingsManager = {
      getCompactionReserveTokens: () => 4_096,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    const result = applyAgentCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: 16_384,
    });

    expect(result.didOverride).toBe(true);
    expect(result.compaction.reserveTokens).toBe(8_384);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: 8_384 },
    });
  });

  it("does not cap the reserve floor for a mid-size context", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    // 32 768 context window → minPromptBudget = min(8_000, floor(32_768 * 0.5)) = 8_000.
    // maxReserve = 32_768 - 8_000 = 24_768, so the 20 000 floor remains intact.
    const result = applyAgentCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: 32_768,
    });

    expect(result.compaction.reserveTokens).toBe(DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR);
    expect(result.compaction.keepRecentTokens).toBe(20_000);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR },
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
    const result = applyAgentCompactionSettingsFromConfig({
      settingsManager,
      contextTokenBudget: 200_000,
    });

    expect(result.compaction.reserveTokens).toBe(DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR);
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR },
    });
  });

  it("falls back to uncapped floor when contextTokenBudget is not provided", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      getCompactionKeepRecentTokens: () => 20_000,
      applyOverrides: vi.fn(),
    };

    // No contextTokenBudget → backward-compatible behavior, floor = 20 000.
    const result = applyAgentCompactionSettingsFromConfig({ settingsManager });

    expect(result.compaction.reserveTokens).toBe(DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR);
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
  // string. False positives only disable OpenClaw runtime's secondary compaction path;
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
  // shape, and disabling embedded auto-compaction for them would over-broaden the
  // kill surface beyond the reproducible repro.
  it("does not flag namespaced GLM ids routed through non-z.ai hosts", () => {
    expect(
      isSilentOverflowProneModel({ provider: "ollama", modelId: "ollama/glm-5.1:cloud" }),
    ).toBe(false);
    expect(
      isSilentOverflowProneModel({ provider: "opencode-go", modelId: "opencode-go/glm-5.1" }),
    ).toBe(false);
  });

  // shared model runtime's overflow.ts only documents z.ai as the silent-overflow style. We
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

describe("applyAgentAutoCompactionGuard", () => {
  // Direct repro of openclaw#75799: shared model runtime's silent-overflow detection misfires
  // on a successful turn against z.ai-style providers, triggering OpenClaw runtime's
  // _runAutoCompaction from inside Session.prompt() and reassigning
  // agent.state.messages between the runner's prompt.submitted trajectory
  // event and the provider request. Disabling embedded auto-compaction here keeps
  // state.messages intact; OpenClaw's preemptive compaction continues to
  // handle real overflow on its own path.
  it("disables embedded auto-compaction for silent-overflow-prone providers", () => {
    const setCompactionEnabled = vi.fn();
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      getCompactionKeepRecentTokens: () => 4_000,
      applyOverrides: () => {},
      setCompactionEnabled,
    };

    const result = applyAgentAutoCompactionGuard({
      settingsManager,
      silentOverflowProneProvider: true,
    });

    expect(result).toEqual({ supported: true, disabled: true });
    expect(setCompactionEnabled).toHaveBeenCalledWith(false);
  });

  it("disables embedded auto-compaction when a context engine plugin owns compaction", () => {
    const setCompactionEnabled = vi.fn();
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      getCompactionKeepRecentTokens: () => 4_000,
      applyOverrides: () => {},
      setCompactionEnabled,
    };

    const result = applyAgentAutoCompactionGuard({
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

  it("disables embedded auto-compaction when provider config forces safeguard mode", () => {
    const setCompactionEnabled = vi.fn();
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      getCompactionKeepRecentTokens: () => 4_000,
      applyOverrides: () => {},
      setCompactionEnabled,
    };

    const result = applyAgentAutoCompactionGuard({
      settingsManager,
      compactionMode: resolveEffectiveCompactionMode({
        agents: { defaults: { compaction: { provider: "deepseek" } } },
      }),
    });

    expect(result).toEqual({ supported: true, disabled: true });
    expect(setCompactionEnabled).toHaveBeenCalledWith(false);
  });

  it("preserves configured reserve tokens when disabling embedded auto-compaction", () => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: true, reserveTokens: 50_000 },
    });

    const result = applyAgentAutoCompactionGuard({
      settingsManager,
      compactionMode: "safeguard",
    });

    expect(result).toEqual({ supported: true, disabled: true });
    expect(settingsManager.getCompactionSettings()).toEqual({
      enabled: false,
      reserveTokens: 50_000,
      keepRecentTokens: 20_000,
    });
  });

  // Default-mode runs against ordinary providers must keep OpenClaw runtime's auto-compaction
  // enabled. Disabling it across the board would silently remove OpenClaw runtime's
  // overflow-recovery path inside Session.prompt() for users who are not
  // affected by z.ai's silent-overflow accounting.
  it("leaves embedded auto-compaction alone for non-z.ai providers without engine ownership", () => {
    const setCompactionEnabled = vi.fn();
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      getCompactionKeepRecentTokens: () => 4_000,
      applyOverrides: () => {},
      setCompactionEnabled,
    };

    const result = applyAgentAutoCompactionGuard({
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

    const result = applyAgentAutoCompactionGuard({
      settingsManager,
      silentOverflowProneProvider: true,
    });

    expect(result).toEqual({ supported: false, disabled: false });
  });
});
