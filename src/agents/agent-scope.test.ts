import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  clearAutoFallbackPrimaryProbeSelection,
  markAutoFallbackPrimaryProbe,
  hasConfiguredModelFallbacks,
  resolveAgentConfig,
  resolveDefaultAgentDir,
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  resolveAgentExplicitModelPrimary,
  resolveAgentSkillsFilter,
  resolveFallbackAgentId,
  resolveEffectiveModelFallbacks,
  resolveAgentModelFallbacksOverride,
  resolveAgentModelPrimary,
  resolveRunModelFallbacksOverride,
  resolveSubagentModelConfigSelection,
  resolveSubagentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
  resolveAutoFallbackPrimaryProbe,
  resolveAgentIdByWorkspacePath,
  resolveAgentIdsByWorkspacePath,
  setAgentEffectiveModelPrimary,
} from "./agent-scope.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveAgentConfig", () => {
  it("should return undefined when no agents config exists", () => {
    const cfg: OpenClawConfig = {};
    const result = resolveAgentConfig(cfg, "main");
    expect(result).toBeUndefined();
  });

  it("should return undefined when agent id does not exist", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", workspace: "~/openclaw" }],
      },
    };
    const result = resolveAgentConfig(cfg, "nonexistent");
    expect(result).toBeUndefined();
  });

  it("should return basic agent config", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "main",
            name: "Main Agent",
            workspace: "~/openclaw",
            agentDir: "~/.openclaw/agents/main",
            model: "anthropic/claude-sonnet-4-6",
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "main");
    expect(result).toEqual({
      name: "Main Agent",
      workspace: "~/openclaw",
      agentDir: "~/.openclaw/agents/main",
      model: "anthropic/claude-sonnet-4-6",
      identity: undefined,
      groupChat: undefined,
      subagents: undefined,
      sandbox: undefined,
      tts: undefined,
      tools: undefined,
    });
  });

  it("prefers per-agent verbose defaults over global defaults", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          verboseDefault: "full",
        },
        list: [
          {
            id: "main",
            verboseDefault: "on",
          },
        ],
      },
    };
    expect(resolveAgentConfig(cfg, "main")?.verboseDefault).toBe("on");
  });

  it("merges contextLimits from defaults with per-agent overrides", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          contextLimits: {
            memoryGetMaxChars: 20_000,
            memoryGetDefaultLines: 180,
            toolResultMaxChars: 18_000,
          },
        },
        list: [
          {
            id: "main",
            skillsLimits: {
              maxSkillsPromptChars: 30_000,
            },
            contextLimits: {
              memoryGetMaxChars: 24_000,
            },
          },
        ],
      },
    };

    expect(resolveAgentConfig(cfg, "main")?.contextLimits).toEqual({
      memoryGetMaxChars: 24_000,
      memoryGetDefaultLines: 180,
      toolResultMaxChars: 18_000,
    });
  });

  it("merges runRetries from defaults with per-agent overrides", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          runRetries: {
            base: 24,
            perProfile: 8,
            min: 32,
            max: 160,
          },
        },
        list: [
          {
            id: "main",
            runRetries: {
              max: 50,
            },
          },
        ],
      },
    };

    expect(resolveAgentConfig(cfg, "main")?.runRetries).toEqual({
      base: 24,
      perProfile: 8,
      min: 32,
      max: 50,
    });
  });

  it("resolves explicit and effective model primary separately", () => {
    const cfgWithStringDefault = {
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
        },
        list: [{ id: "main" }],
      },
    } as unknown as OpenClawConfig;
    expect(resolveAgentExplicitModelPrimary(cfgWithStringDefault, "main")).toBeUndefined();
    expect(resolveAgentEffectiveModelPrimary(cfgWithStringDefault, "main")).toBe(
      "anthropic/claude-sonnet-4-6",
    );

    const cfgWithObjectDefault: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [{ id: "main" }],
      },
    };
    expect(resolveAgentExplicitModelPrimary(cfgWithObjectDefault, "main")).toBeUndefined();
    expect(resolveAgentEffectiveModelPrimary(cfgWithObjectDefault, "main")).toBe("openai/gpt-5.4");

    const cfgNoDefaults: OpenClawConfig = {
      agents: {
        list: [{ id: "main" }],
      },
    };
    expect(resolveAgentExplicitModelPrimary(cfgNoDefaults, "main")).toBeUndefined();
    expect(resolveAgentEffectiveModelPrimary(cfgNoDefaults, "main")).toBeUndefined();
  });

  it("supports per-agent model primary+fallbacks", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [
          {
            id: "linus",
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["openai/gpt-5.4"],
            },
          },
        ],
      },
    };

    expect(resolveAgentModelPrimary(cfg, "linus")).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveAgentExplicitModelPrimary(cfg, "linus")).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveAgentEffectiveModelPrimary(cfg, "linus")).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveAgentModelFallbacksOverride(cfg, "linus")).toEqual(["openai/gpt-5.4"]);

    // If an agent owns a primary, missing fallbacks means no model fallback.
    const cfgNoOverride: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "linus",
            model: {
              primary: "anthropic/claude-sonnet-4-6",
            },
          },
        ],
      },
    };
    expect(resolveAgentModelFallbacksOverride(cfgNoOverride, "linus")).toStrictEqual([]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg: cfgNoOverride,
        agentId: "linus",
        hasSessionModelOverride: false,
      }),
    ).toStrictEqual([]);

    const cfgStringModel: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "linus",
            model: "anthropic/claude-sonnet-4-6",
          },
        ],
      },
    };
    expect(resolveAgentModelFallbacksOverride(cfgStringModel, "linus")).toStrictEqual([]);

    const cfgStrictAgentWithDefaultFallbacks: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["custom-opencode-go-extras/deepseek-v4-flash"],
          },
        },
        list: [
          {
            id: "linus",
            model: {
              primary: "opencode-go/minimax-m2.7",
            },
          },
        ],
      },
    };
    expect(resolveAgentModelFallbacksOverride(cfgStrictAgentWithDefaultFallbacks, "linus")).toEqual(
      [],
    );
    expect(
      resolveEffectiveModelFallbacks({
        cfg: cfgStrictAgentWithDefaultFallbacks,
        agentId: "linus",
        hasSessionModelOverride: true,
        modelOverrideSource: "auto",
      }),
    ).toStrictEqual([]);

    // Explicit empty list disables global fallbacks for that agent.
    const cfgDisable: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "linus",
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: [],
            },
          },
        ],
      },
    };
    expect(resolveAgentModelFallbacksOverride(cfgDisable, "linus")).toStrictEqual([]);

    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "linus",
        hasSessionModelOverride: false,
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "linus",
        hasSessionModelOverride: true,
        modelOverrideSource: "auto",
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "linus",
        hasSessionModelOverride: true,
        modelOverrideSource: "user",
      }),
    ).toStrictEqual([]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "linus",
        hasSessionModelOverride: true,
      }),
    ).toStrictEqual([]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "linus",
        hasSessionModelOverride: true,
        hasAutoFallbackProvenance: true,
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "linus",
        hasSessionModelOverride: true,
        modelOverrideSource: "user",
        hasAutoFallbackProvenance: true,
      }),
    ).toStrictEqual([]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg: cfgNoOverride,
        agentId: "linus",
        hasSessionModelOverride: true,
      }),
    ).toStrictEqual([]);

    const cfgInheritDefaultsWithoutAgentModel: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.4"],
          },
        },
        list: [{ id: "linus" }],
      },
    };
    expect(
      resolveEffectiveModelFallbacks({
        cfg: cfgInheritDefaultsWithoutAgentModel,
        agentId: "linus",
        hasSessionModelOverride: true,
        modelOverrideSource: "auto",
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg: cfgDisable,
        agentId: "linus",
        hasSessionModelOverride: true,
        modelOverrideSource: "auto",
      }),
    ).toStrictEqual([]);
  });

  it("updates the effective model primary at the winning config layer", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [
          {
            id: "linus",
            default: true,
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["openrouter/anthropic/claude-opus-4.6"],
            },
          },
        ],
      },
    };

    expect(setAgentEffectiveModelPrimary(cfg, "linus", "google/gemini-3-pro")).toBe("agent");
    expect(cfg.agents?.list?.[0]?.model).toEqual({
      primary: "google/gemini-3-pro",
      fallbacks: ["openrouter/anthropic/claude-opus-4.6"],
    });
    expect(cfg.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.4",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });

    const inheritedCfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [{ id: "main", default: true }],
      },
    };

    expect(setAgentEffectiveModelPrimary(inheritedCfg, "main", "google/gemini-3-pro")).toBe(
      "defaults",
    );
    expect(inheritedCfg.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3-pro",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
  });

  it("resolves fallback agent id from explicit agent id first", () => {
    expect(
      resolveFallbackAgentId({
        agentId: "Support",
        sessionKey: "agent:main:session",
      }),
    ).toBe("support");
  });

  it("resolves fallback agent id from session key when explicit id is missing", () => {
    expect(
      resolveFallbackAgentId({
        sessionKey: "agent:worker:session",
      }),
    ).toBe("worker");
  });

  it("resolves run fallback overrides via shared helper", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [
          {
            id: "support",
            model: {
              fallbacks: ["openai/gpt-5.4"],
            },
          },
        ],
      },
    };

    expect(
      resolveRunModelFallbacksOverride({
        cfg,
        agentId: "support",
        sessionKey: "agent:main:session",
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      resolveRunModelFallbacksOverride({
        cfg,
        agentId: undefined,
        sessionKey: "agent:support:session",
      }),
    ).toEqual(["openai/gpt-5.4"]);
  });

  it("resolves throttled primary probes for auto fallback selections", () => {
    const probeState = new Map<string, number>();
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
      authProfileOverride: "google:fallback",
      authProfileOverrideSource: "auto",
    };

    expect(
      resolveAutoFallbackPrimaryProbe({
        entry,
        sessionKey: "agent:main:session",
        primaryProvider: "anthropic",
        primaryModel: "claude-sonnet-4-6",
        now: 1_000,
        minIntervalMs: 60_000,
        probeState,
      }),
    ).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackAuthProfileId: "google:fallback",
      fallbackAuthProfileIdSource: "auto",
    });
    markAutoFallbackPrimaryProbe({
      probe: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        fallbackProvider: "google",
        fallbackModel: "gemini-3-pro",
      },
      sessionKey: "agent:main:session",
      now: 1_000,
      probeState,
    });
    expect(
      resolveAutoFallbackPrimaryProbe({
        entry,
        sessionKey: "agent:main:session",
        primaryProvider: "anthropic",
        primaryModel: "claude-sonnet-4-6",
        now: 30_000,
        minIntervalMs: 60_000,
        probeState,
      }),
    ).toBeUndefined();
    expect(
      resolveAutoFallbackPrimaryProbe({
        entry: {
          ...entry,
          providerOverride: "openai",
          modelOverride: "gpt-5.4",
        },
        sessionKey: "agent:main:session",
        primaryProvider: "anthropic",
        primaryModel: "claude-sonnet-4-6",
        now: 30_000,
        minIntervalMs: 60_000,
        probeState,
      }),
    ).toBeUndefined();
    expect(
      resolveAutoFallbackPrimaryProbe({
        entry,
        sessionKey: "agent:main:session",
        primaryProvider: "anthropic",
        primaryModel: "claude-sonnet-4-6",
        now: 70_000,
        minIntervalMs: 60_000,
        probeState,
      }),
    ).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  it("prunes stale and excess primary probe throttle entries", () => {
    const probeState = new Map<string, number>();
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "google",
      fallbackModel: "gemini-3-pro",
    };
    markAutoFallbackPrimaryProbe({
      probe,
      sessionKey: "old",
      now: 1_000,
      minIntervalMs: 100,
      maxTrackedProbeKeys: 3,
      probeState,
    });
    for (let index = 0; index < 4; index += 1) {
      markAutoFallbackPrimaryProbe({
        probe,
        sessionKey: `new-${index}`,
        now: 2_000 + index,
        minIntervalMs: 100,
        maxTrackedProbeKeys: 3,
        probeState,
      });
    }

    expect(probeState.size).toBe(3);
    expect(
      resolveAutoFallbackPrimaryProbe({
        entry: {
          providerOverride: "google",
          modelOverride: "gemini-3-pro",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "anthropic",
          modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
        },
        sessionKey: "old",
        primaryProvider: "anthropic",
        primaryModel: "claude-sonnet-4-6",
        now: 2_004,
        minIntervalMs: 100,
        maxTrackedProbeKeys: 3,
        probeState,
      }),
    ).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  it("skips primary probes for strict or stale fallback selections", () => {
    const baseEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
    };

    expect(
      resolveAutoFallbackPrimaryProbe({
        entry: { ...baseEntry, modelOverrideSource: "user" },
        primaryProvider: "anthropic",
        primaryModel: "claude-sonnet-4-6",
        probeState: new Map(),
      }),
    ).toBeUndefined();
    expect(
      resolveAutoFallbackPrimaryProbe({
        entry: baseEntry,
        primaryProvider: "openai",
        primaryModel: "gpt-5.4",
        probeState: new Map(),
      }),
    ).toBeUndefined();
    expect(
      resolveAutoFallbackPrimaryProbe({
        entry: {
          ...baseEntry,
          providerOverride: "anthropic",
          modelOverride: "claude-sonnet-4-6",
        },
        primaryProvider: "anthropic",
        primaryModel: "claude-sonnet-4-6",
        probeState: new Map(),
      }),
    ).toBeUndefined();
  });

  it("recognizes recovered auto fallback provenance without a source marker", () => {
    expect(
      resolveAutoFallbackPrimaryProbe({
        entry: {
          providerOverride: "google",
          modelOverride: "gemini-3-pro",
          modelOverrideFallbackOriginProvider: "anthropic",
          modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
        },
        primaryProvider: "anthropic",
        primaryModel: "claude-sonnet-4-6",
        probeState: new Map(),
      }),
    ).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  it("preserves legacy auto auth provenance on primary probes", () => {
    expect(
      resolveAutoFallbackPrimaryProbe({
        entry: {
          providerOverride: "google",
          modelOverride: "gemini-3-pro",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "anthropic",
          modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
          authProfileOverride: "fallback-key",
          authProfileOverrideCompactionCount: 1,
        },
        primaryProvider: "anthropic",
        primaryModel: "claude-sonnet-4-6",
        probeState: new Map(),
      }),
    ).toMatchObject({
      fallbackAuthProfileId: "fallback-key",
      fallbackAuthProfileIdSource: "auto",
    });
  });

  it("clears only auto-owned fallback selection state for a primary probe", () => {
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
      authProfileOverride: "fallback-key",
      authProfileOverrideSource: "auto",
      authProfileOverrideCompactionCount: 1,
      fallbackNoticeSelectedModel: "google/gemini-3-pro",
      fallbackNoticeActiveModel: "google/gemini-3-pro",
      fallbackNoticeReason: "rate_limit",
    };

    clearAutoFallbackPrimaryProbeSelection(entry, 2);

    expect(entry).toEqual({ sessionId: "session", updatedAt: 2 });
  });

  it("clears legacy auto auth selection when clearing primary probe state", () => {
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
      authProfileOverride: "fallback-key",
      authProfileOverrideCompactionCount: 1,
    };

    clearAutoFallbackPrimaryProbeSelection(entry, 2);

    expect(entry).toEqual({ sessionId: "session", updatedAt: 2 });
  });

  it("preserves user-owned auth selection when clearing primary probe state", () => {
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
      authProfileOverride: "selected-key",
      authProfileOverrideSource: "user",
    };

    clearAutoFallbackPrimaryProbeSelection(entry, 2);

    expect(entry).toEqual({
      sessionId: "session",
      updatedAt: 2,
      authProfileOverride: "selected-key",
      authProfileOverrideSource: "user",
    });
  });

  it("computes whether any model fallbacks are configured via shared helper", () => {
    const cfgDefaultsOnly: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.4"],
          },
        },
        list: [{ id: "main" }],
      },
    };
    expect(
      hasConfiguredModelFallbacks({
        cfg: cfgDefaultsOnly,
        sessionKey: "agent:main:session",
      }),
    ).toBe(true);

    const cfgAgentOverrideOnly: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: [],
          },
        },
        list: [
          {
            id: "support",
            model: {
              fallbacks: ["openai/gpt-5.4"],
            },
          },
        ],
      },
    };
    expect(
      hasConfiguredModelFallbacks({
        cfg: cfgAgentOverrideOnly,
        agentId: "support",
        sessionKey: "agent:support:session",
      }),
    ).toBe(true);
    expect(
      hasConfiguredModelFallbacks({
        cfg: cfgAgentOverrideOnly,
        agentId: "main",
        sessionKey: "agent:main:session",
      }),
    ).toBe(false);
  });

  it("resolves subagent model fallbacks from the selected subagent model source", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["openai/gpt-5.4"],
          },
          subagents: {
            model: {
              primary: "kimi/kimi-code",
              fallbacks: ["openai-codex/gpt-5.4", "zai/glm-5"],
            },
          },
        },
        list: [
          {
            id: "research",
            subagents: {
              model: {
                primary: "kimi/kimi-code",
                fallbacks: ["openai-codex/gpt-5.4", "zai/glm-5"],
              },
            },
          },
          {
            id: "agent-model",
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["google/gemini-3-pro"],
            },
          },
          {
            id: "metadata-only-subagent",
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["google/gemini-3-pro"],
            },
            subagents: {
              model: { timeoutMs: 1_000 },
            },
          },
          {
            id: "fallback-only-agent-model",
            model: {
              fallbacks: ["google/gemini-3-pro"],
            },
          },
          {
            id: "fallback-only-subagent-model",
            subagents: {
              model: {
                fallbacks: [],
              },
            },
          },
          {
            id: "default-subagent",
          },
          {
            id: "strict",
            subagents: {
              model: "kimi/kimi-code",
            },
          },
        ],
      },
    };

    expect(resolveSubagentModelFallbacksOverride(cfg, "research")).toEqual([
      "openai-codex/gpt-5.4",
      "zai/glm-5",
    ]);
    expect(resolveSubagentModelFallbacksOverride(cfg, "agent-model")).toEqual([
      "google/gemini-3-pro",
    ]);
    expect(resolveSubagentModelFallbacksOverride(cfg, "metadata-only-subagent")).toEqual([
      "google/gemini-3-pro",
    ]);
    expect(resolveSubagentModelFallbacksOverride(cfg, "fallback-only-agent-model")).toEqual([
      "openai-codex/gpt-5.4",
      "zai/glm-5",
    ]);
    expect(
      resolveSubagentModelFallbacksOverride(cfg, "fallback-only-subagent-model"),
    ).toStrictEqual([]);
    expect(resolveSubagentModelFallbacksOverride(cfg, "default-subagent")).toEqual([
      "openai-codex/gpt-5.4",
      "zai/glm-5",
    ]);
    expect(resolveSubagentModelFallbacksOverride(cfg, "strict")).toStrictEqual([]);
  });

  it("resolves the subagent model config selected for isolated runs", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          subagents: { model: "openai/gpt-5.4" },
        },
        list: [
          {
            id: "agent-model",
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["google/gemini-3-pro"],
            },
          },
          {
            id: "subagent-model",
            model: "anthropic/claude-sonnet-4-6",
            subagents: {
              model: {
                primary: "kimi/kimi-code",
                fallbacks: ["openai-codex/gpt-5.4"],
              },
            },
          },
          {
            id: "metadata-only-subagent",
            model: "anthropic/claude-sonnet-4-6",
            subagents: {
              model: { timeoutMs: 1_000 },
            },
          },
        ],
      },
    };

    expect(resolveSubagentModelConfigSelection({ cfg, agentId: "agent-model" })).toEqual({
      primary: "anthropic/claude-sonnet-4-6",
      fallbacks: ["google/gemini-3-pro"],
    });
    expect(resolveSubagentModelConfigSelection({ cfg, agentId: "subagent-model" })).toEqual({
      primary: "kimi/kimi-code",
      fallbacks: ["openai-codex/gpt-5.4"],
    });
    expect(resolveSubagentModelConfigSelection({ cfg, agentId: "metadata-only-subagent" })).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(resolveSubagentModelConfigSelection({ cfg, agentId: "default-subagent" })).toBe(
      "openai/gpt-5.4",
    );
  });

  it("should return agent-specific sandbox config", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "work",
            workspace: "~/openclaw-work",
            sandbox: {
              mode: "all",
              scope: "agent",
              perSession: false,
              workspaceAccess: "ro",
              workspaceRoot: "~/sandboxes",
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;
    const result = resolveAgentConfig(cfg, "work");
    expect(result?.sandbox).toEqual({
      mode: "all",
      scope: "agent",
      perSession: false,
      workspaceAccess: "ro",
      workspaceRoot: "~/sandboxes",
    });
  });

  it("should return agent-specific tools config", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "restricted",
            workspace: "~/openclaw-restricted",
            tools: {
              allow: ["read"],
              deny: ["exec", "write", "edit"],
              elevated: {
                enabled: false,
                allowFrom: { whatsapp: ["+15555550123"] },
              },
            },
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "restricted");
    expect(result?.tools).toEqual({
      allow: ["read"],
      deny: ["exec", "write", "edit"],
      elevated: {
        enabled: false,
        allowFrom: { whatsapp: ["+15555550123"] },
      },
    });
  });

  it("should return both sandbox and tools config", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "family",
            workspace: "~/openclaw-family",
            sandbox: {
              mode: "all",
              scope: "agent",
            },
            tools: {
              allow: ["read"],
              deny: ["exec"],
            },
          },
        ],
      },
    };
    const result = resolveAgentConfig(cfg, "family");
    expect(result?.sandbox?.mode).toBe("all");
    expect(result?.tools?.allow).toEqual(["read"]);
  });

  it("should normalize agent id", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", workspace: "~/openclaw" }],
      },
    };
    // Should normalize to "main" (default)
    const result = resolveAgentConfig(cfg, "");
    expect(result?.workspace).toBe("~/openclaw");
  });

  it("uses OPENCLAW_HOME for default agent workspace", () => {
    const home = path.join(path.sep, "srv", "openclaw-home");
    vi.stubEnv("OPENCLAW_HOME", home);

    const workspace = resolveAgentWorkspaceDir({} as OpenClawConfig, "main");
    expect(workspace).toBe(path.join(path.resolve(home), ".openclaw", "workspace"));
  });

  it("uses OPENCLAW_WORKSPACE_DIR for default agent workspace", () => {
    const workspaceDir = path.join(path.sep, "srv", "openclaw-workspace");
    vi.stubEnv("OPENCLAW_WORKSPACE_DIR", workspaceDir);
    vi.stubEnv("OPENCLAW_HOME", path.join(path.sep, "srv", "openclaw-home"));

    const workspace = resolveAgentWorkspaceDir({} as OpenClawConfig, "main");
    expect(workspace).toBe(path.resolve(workspaceDir));
  });

  it("uses OPENCLAW_HOME for default agentDir", () => {
    const home = path.join(path.sep, "srv", "openclaw-home");
    vi.stubEnv("OPENCLAW_HOME", home);
    // Clear state dir so it falls back to OPENCLAW_HOME
    vi.stubEnv("OPENCLAW_STATE_DIR", "");

    const agentDir = resolveAgentDir({} as OpenClawConfig, "main");
    expect(agentDir).toBe(path.join(path.resolve(home), ".openclaw", "agents", "main", "agent"));
  });

  it("resolves default agentDir from the configured default agent", () => {
    const stateDir = path.join(path.sep, "tmp", "test-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main" }, { id: "ops", default: true }],
      },
    };

    const agentDir = resolveDefaultAgentDir(cfg);

    expect(agentDir).toBe(path.resolve(stateDir, "agents", "ops", "agent"));
  });

  it("non-default agent uses agents.defaults.workspace as base (#59789)", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/shared-ws" },
        list: [{ id: "main" }, { id: "work", default: true, workspace: "/work-ws" }],
      },
    };
    const workspace = resolveAgentWorkspaceDir(cfg, "main");
    expect(workspace).toBe(path.resolve("/shared-ws/main"));
  });

  it("default agent without per-agent workspace uses agents.defaults.workspace directly", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/shared-ws" },
        list: [{ id: "main" }, { id: "work", default: true }],
      },
    };
    const workspace = resolveAgentWorkspaceDir(cfg, "work");
    expect(workspace).toBe(path.resolve("/shared-ws"));
  });

  it("non-default agent without defaults.workspace falls back to stateDir", () => {
    const stateDir = path.join(path.sep, "tmp", "test-state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main" }, { id: "work", default: true, workspace: "/work-ws" }],
      },
    };
    const workspace = resolveAgentWorkspaceDir(cfg, "main");
    expect(workspace).toBe(path.resolve(stateDir, "workspace-main"));
  });
});

describe("resolveAgentIdByWorkspacePath", () => {
  it("returns the most specific workspace match for a directory", () => {
    const workspaceRoot = `/tmp/openclaw-agent-scope-${Date.now()}-root`;
    const opsWorkspace = `${workspaceRoot}/projects/ops`;
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", workspace: workspaceRoot },
          { id: "ops", workspace: opsWorkspace },
        ],
      },
    };

    expect(resolveAgentIdByWorkspacePath(cfg, `${opsWorkspace}/src`)).toBe("ops");
  });

  it("returns undefined when directory has no matching workspace", () => {
    const workspaceRoot = `/tmp/openclaw-agent-scope-${Date.now()}-root`;
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", workspace: workspaceRoot },
          { id: "ops", workspace: `${workspaceRoot}-ops` },
        ],
      },
    };

    expect(
      resolveAgentIdByWorkspacePath(cfg, `/tmp/openclaw-agent-scope-${Date.now()}-unrelated`),
    ).toBeUndefined();
  });

  it("matches workspace paths through symlink aliases", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-scope-"));
    const realWorkspaceRoot = path.join(tempRoot, "real-root");
    const realOpsWorkspace = path.join(realWorkspaceRoot, "projects", "ops");
    const aliasWorkspaceRoot = path.join(tempRoot, "alias-root");
    try {
      fs.mkdirSync(path.join(realOpsWorkspace, "src"), { recursive: true });
      fs.symlinkSync(
        realWorkspaceRoot,
        aliasWorkspaceRoot,
        process.platform === "win32" ? "junction" : "dir",
      );

      const cfg: OpenClawConfig = {
        agents: {
          list: [
            { id: "main", workspace: realWorkspaceRoot },
            { id: "ops", workspace: realOpsWorkspace },
          ],
        },
      };

      expect(
        resolveAgentIdByWorkspacePath(cfg, path.join(aliasWorkspaceRoot, "projects", "ops")),
      ).toBe("ops");
      expect(
        resolveAgentIdByWorkspacePath(cfg, path.join(aliasWorkspaceRoot, "projects", "ops", "src")),
      ).toBe("ops");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("resolveAgentIdsByWorkspacePath", () => {
  it("returns matching workspaces ordered by specificity", () => {
    const workspaceRoot = `/tmp/openclaw-agent-scope-${Date.now()}-root`;
    const opsWorkspace = `${workspaceRoot}/projects/ops`;
    const opsDevWorkspace = `${opsWorkspace}/dev`;
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", workspace: workspaceRoot },
          { id: "ops", workspace: opsWorkspace },
          { id: "ops-dev", workspace: opsDevWorkspace },
        ],
      },
    };

    expect(resolveAgentIdsByWorkspacePath(cfg, `${opsDevWorkspace}/pkg`)).toEqual([
      "ops-dev",
      "ops",
      "main",
    ]);
  });
});

describe("resolveAgentSkillsFilter", () => {
  it("inherits agents.defaults.skills when the agent omits skills", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          skills: ["github", "weather"],
        },
        list: [{ id: "writer" }],
      },
    };

    expect(resolveAgentSkillsFilter(cfg, "writer")).toEqual(["github", "weather"]);
  });

  it("uses agents.list[].skills as a full replacement", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          skills: ["github", "weather"],
        },
        list: [{ id: "writer", skills: ["docs-search"] }],
      },
    };

    expect(resolveAgentSkillsFilter(cfg, "writer")).toEqual(["docs-search"]);
  });

  it("keeps explicit empty agent skills as no skills", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          skills: ["github", "weather"],
        },
        list: [{ id: "writer", skills: [] }],
      },
    };

    expect(resolveAgentSkillsFilter(cfg, "writer")).toStrictEqual([]);
  });
});
