import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  evaluateStoredCredentialEligibility: vi.fn(),
  getInstalledPluginRecord: vi.fn(),
  isInstalledPluginEnabled: vi.fn(),
  loadInstalledPluginIndex: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
  resolveProfileUnusableUntilForDisplay: vi.fn(),
}));

vi.mock("../../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  resolveAuthProfileOrder: mocks.resolveAuthProfileOrder,
  resolveProfileUnusableUntilForDisplay: mocks.resolveProfileUnusableUntilForDisplay,
}));

vi.mock("../../../agents/auth-profiles/credential-state.js", () => ({
  evaluateStoredCredentialEligibility: mocks.evaluateStoredCredentialEligibility,
}));

vi.mock("../../../plugins/installed-plugin-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/installed-plugin-index.js")>()),
  getInstalledPluginRecord: mocks.getInstalledPluginRecord,
  isInstalledPluginEnabled: mocks.isInstalledPluginEnabled,
  loadInstalledPluginIndex: mocks.loadInstalledPluginIndex,
}));

import {
  collectCodexRouteWarnings,
  maybeRepairCodexRoutes,
  repairCodexSessionStoreRoutes,
} from "./codex-route-warnings.js";

describe("collectCodexRouteWarnings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureAuthProfileStore.mockReturnValue({
      profiles: {},
      usageStats: {},
    });
    mocks.evaluateStoredCredentialEligibility.mockReturnValue({
      eligible: true,
      reasonCode: "ok",
    });
    mocks.getInstalledPluginRecord.mockReturnValue(undefined);
    mocks.isInstalledPluginEnabled.mockReturnValue(false);
    mocks.loadInstalledPluginIndex.mockReturnValue({ plugins: [] });
    mocks.resolveAuthProfileOrder.mockReturnValue([]);
    mocks.resolveProfileUnusableUntilForDisplay.mockReturnValue(null);
  });

  it("warns when openai-codex primary models still use the legacy route", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
          },
        },
      } as OpenClawConfig,
    });

    expect(warnings).toEqual([expect.stringContaining("OpenAI Codex routes")]);
    expect(warnings[0]).toContain("agents.defaults.model");
    expect(warnings[0]).toContain("openai/gpt-5.5");
    expect(warnings[0]).toContain('runtime is "codex"');
    expect(warnings[0]).toContain('agentRuntime.id: "codex"');
  });

  it("still warns when the native Codex runtime is selected with a legacy model ref", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
            agentRuntime: {
              id: "codex",
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(warnings).toEqual([expect.stringContaining("openai/gpt-5.5")]);
    expect(warnings[0]).toContain('runtime is "codex"');
  });

  it("still warns when OPENCLAW_AGENT_RUNTIME selects native Codex with a legacy model ref", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
          },
        },
      } as OpenClawConfig,
      env: {
        OPENCLAW_AGENT_RUNTIME: "codex",
      },
    });

    expect(warnings).toEqual([expect.stringContaining('runtime is "codex"')]);
  });

  it("does not warn for canonical OpenAI refs", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
          },
        },
      } as OpenClawConfig,
    });

    expect(warnings).toEqual([]);
  });

  it("does not warn when OpenAI refs are pinned to PI", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            agentRuntime: { id: "pi" },
          },
        },
      } as OpenClawConfig,
    });

    expect(warnings).toEqual([]);
  });

  it("does not warn when custom OpenAI-compatible refs are pinned to PI", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        agents: {
          defaults: {
            model: "openai/custom-gpt",
            agentRuntime: { id: "pi" },
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://compatible.example.test/v1",
              api: "openai-responses",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(warnings).toEqual([]);
  });

  it("repairs configured Codex model refs to canonical OpenAI refs with the Codex runtime when ready", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5.5",
              fallbacks: ["openai-codex/gpt-5.4", "anthropic/claude-sonnet-4-6"],
            },
            heartbeat: {
              model: "openai-codex/gpt-5.4-mini",
            },
            subagents: {
              model: {
                primary: "openai-codex/gpt-5.5",
                fallbacks: ["openai-codex/gpt-5.4"],
              },
            },
            compaction: {
              model: "openai-codex/gpt-5.4",
              memoryFlush: {
                model: "openai-codex/gpt-5.4-mini",
              },
            },
            models: {
              "openai-codex/gpt-5.5": { alias: "codex" },
            },
          },
          list: [
            {
              id: "worker",
              model: "openai-codex/gpt-5.4",
              agentRuntime: { id: "codex" },
            },
          ],
        },
        channels: {
          modelByChannel: {
            telegram: {
              default: "openai-codex/gpt-5.4",
            },
          },
        },
        hooks: {
          mappings: [
            {
              model: "openai-codex/gpt-5.4-mini",
            },
          ],
          gmail: {
            model: "openai-codex/gpt-5.4",
          },
        },
        tools: {
          subagents: {
            model: {
              primary: "openai-codex/gpt-5.4",
              fallbacks: ["openai-codex/gpt-5.4-mini"],
            },
          },
        },
        messages: {
          tts: {
            summaryModel: "openai-codex/gpt-5.4-mini",
          },
        },
      } as OpenClawConfig,
      shouldRepair: true,
      codexRuntimeReady: true,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual([expect.stringContaining("Repaired Codex model routes")]);
    expect(result.cfg.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
    });
    expect(result.cfg.agents?.defaults?.heartbeat?.model).toBe("openai/gpt-5.4-mini");
    expect(result.cfg.agents?.defaults?.subagents?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["openai/gpt-5.4"],
    });
    expect(result.cfg.agents?.defaults?.compaction?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.defaults?.compaction?.memoryFlush?.model).toBe("openai/gpt-5.4-mini");
    expect(result.cfg.agents?.defaults?.agentRuntime).toEqual({ id: "codex" });
    expect(result.cfg.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "codex" },
    });
    expect(result.cfg.agents?.list?.[0]).toMatchObject({
      id: "worker",
      model: "openai/gpt-5.4",
      agentRuntime: { id: "codex" },
    });
    expect(result.cfg.channels?.modelByChannel?.telegram?.default).toBe("openai/gpt-5.4");
    expect(result.cfg.hooks?.mappings?.[0]?.model).toBe("openai/gpt-5.4-mini");
    expect(result.cfg.hooks?.gmail?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.tools?.subagents?.model).toEqual({
      primary: "openai/gpt-5.4",
      fallbacks: ["openai/gpt-5.4-mini"],
    });
    expect(result.cfg.messages?.tts?.summaryModel).toBe("openai/gpt-5.4-mini");
  });

  it("repairs legacy routes to Codex even when OAuth readiness cannot be proven", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
          },
        },
      } as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.cfg.agents?.defaults?.agentRuntime).toEqual({ id: "codex" });
    expect(result.changes.join("\n")).toContain('set agentRuntime.id to "codex"');
  });

  it("does not repair OpenAI PI runtime pins without Codex auth", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            agentRuntime: { id: "pi" },
          },
        },
      } as OpenClawConfig,
      shouldRepair: true,
      codexRuntimeReady: false,
    });

    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.cfg.agents?.defaults?.agentRuntime).toEqual({ id: "pi" });
    expect(result.changes).toEqual([]);
  });

  it("repairs persisted session route pins to Codex and preserves Codex auth pins", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai-codex",
        model: "gpt-5.5",
        providerOverride: "openai-codex",
        modelOverride: "openai-codex/gpt-5.4",
        modelOverrideSource: "auto",
        agentHarnessId: "codex",
        agentRuntimeOverride: "codex",
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 2,
        fallbackNoticeSelectedModel: "openai-codex/gpt-5.5",
        fallbackNoticeActiveModel: "openai-codex/gpt-5.4",
        fallbackNoticeReason: "rate-limit",
      },
      other: {
        sessionId: "s2",
        updatedAt: 2,
        agentHarnessId: "codex",
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      runtime: "codex",
      now: 123,
    });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(store.main).toMatchObject({
      updatedAt: 123,
      modelProvider: "openai",
      model: "gpt-5.5",
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "auto",
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
      authProfileOverride: "openai-codex:default",
      authProfileOverrideSource: "auto",
      authProfileOverrideCompactionCount: 2,
    });
    expect(store.main.fallbackNoticeSelectedModel).toBeUndefined();
    expect(store.main.fallbackNoticeActiveModel).toBeUndefined();
    expect(store.main.fallbackNoticeReason).toBeUndefined();
    expect(store.other).toMatchObject({
      updatedAt: 2,
      agentHarnessId: "codex",
    });
  });

  it("keeps Codex session auth pins when the Codex runtime is ready", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.5",
        agentHarnessId: "codex",
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "auto",
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      runtime: "codex",
      now: 123,
    });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(store.main).toMatchObject({
      updatedAt: 123,
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
      authProfileOverride: "openai-codex:default",
      authProfileOverrideSource: "auto",
    });
  });

  it("repairs canonical OpenAI sessions that are still pinned to PI", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5.5",
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        agentHarnessId: "pi",
        agentRuntimeOverride: "pi",
        authProfileOverride: "openai-codex:default",
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      runtime: "codex",
      now: 123,
    });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(store.main).toMatchObject({
      updatedAt: 123,
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
      authProfileOverride: "openai-codex:default",
    });
  });

  it("does not repair custom OpenAI-compatible sessions pinned to PI", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai",
        model: "custom-gpt",
        providerOverride: "openai",
        modelOverride: "custom-gpt",
        agentHarnessId: "pi",
        agentRuntimeOverride: "pi",
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      runtime: "codex",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://compatible.example.test/v1",
              api: "openai-responses",
              models: [],
            },
          },
        },
      },
      now: 123,
    });

    expect(result).toEqual({ changed: false, sessionKeys: [] });
    expect(store.main).toMatchObject({
      updatedAt: 1,
      agentHarnessId: "pi",
      agentRuntimeOverride: "pi",
    });
  });

  it("repairs custom OpenAI-compatible PI pins when Codex auth is present", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai",
        model: "custom-gpt",
        agentHarnessId: "pi",
        agentRuntimeOverride: "pi",
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "auto",
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      runtime: "codex",
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://compatible.example.test/v1",
              api: "openai-responses",
              models: [],
            },
          },
        },
      },
      now: 123,
    });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(store.main).toMatchObject({
      updatedAt: 123,
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
      authProfileOverride: "openai-codex:default",
    });
  });

  it("repairs legacy routes to Codex without probing OAuth readiness", () => {
    const store = {
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
        },
      },
      usageStats: {},
    };
    const index = {
      plugins: [
        {
          pluginId: "codex",
          enabled: true,
          startup: {
            agentHarnesses: ["codex"],
          },
        },
      ],
    };
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    mocks.loadInstalledPluginIndex.mockReturnValue(index);
    mocks.getInstalledPluginRecord.mockReturnValue(index.plugins[0]);
    mocks.isInstalledPluginEnabled.mockReturnValue(true);
    mocks.resolveAuthProfileOrder.mockReturnValue(["openai-codex:default"]);

    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: {
              enabled: true,
            },
          },
        },
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
          },
        },
      } as OpenClawConfig,
      shouldRepair: true,
    });

    expect(mocks.loadInstalledPluginIndex).not.toHaveBeenCalled();
    expect(mocks.isInstalledPluginEnabled).not.toHaveBeenCalled();
    expect(mocks.resolveAuthProfileOrder).not.toHaveBeenCalled();
    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.cfg.agents?.defaults?.agentRuntime).toEqual({ id: "codex" });
  });

  it("still repairs to Codex when installed plugin metadata is unavailable", () => {
    const store = {
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
        },
      },
      usageStats: {},
    };
    const index = {
      plugins: [
        {
          pluginId: "codex",
          enabled: true,
          startup: {
            agentHarnesses: [],
          },
        },
      ],
    };
    mocks.ensureAuthProfileStore.mockReturnValue(store);
    mocks.loadInstalledPluginIndex.mockReturnValue(index);
    mocks.getInstalledPluginRecord.mockReturnValue(index.plugins[0]);
    mocks.isInstalledPluginEnabled.mockReturnValue(true);
    mocks.resolveAuthProfileOrder.mockReturnValue(["openai-codex:default"]);

    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
          },
        },
      } as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.cfg.agents?.defaults?.agentRuntime).toEqual({ id: "codex" });
  });
});
