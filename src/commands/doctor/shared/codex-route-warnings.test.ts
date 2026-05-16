import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentHarnessPolicy } from "../../../agents/harness/policy.js";
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
      } as unknown as OpenClawConfig,
    });

    expect(warnings).toStrictEqual([
      [
        "- Legacy `openai-codex/*` model refs should be rewritten to `openai/*`.",
        "- agents.defaults.model: openai-codex/gpt-5.5 should become openai/gpt-5.5.",
        "- Run `openclaw doctor --fix`: it rewrites configured model refs and stale sessions to `openai/*`, moves Codex intent to provider/model runtime policy, and clears old whole-agent runtime pins.",
      ].join("\n"),
    ]);
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
      } as unknown as OpenClawConfig,
    });

    expect(warnings).toStrictEqual([
      [
        "- Legacy `openai-codex/*` model refs should be rewritten to `openai/*`.",
        '- agents.defaults.model: openai-codex/gpt-5.5 should become openai/gpt-5.5; current runtime is "codex".',
        "- Run `openclaw doctor --fix`: it rewrites configured model refs and stale sessions to `openai/*`, moves Codex intent to provider/model runtime policy, and clears old whole-agent runtime pins.",
      ].join("\n"),
    ]);
  });

  it("still warns when OPENCLAW_AGENT_RUNTIME selects native Codex with a legacy model ref", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
          },
        },
      } as unknown as OpenClawConfig,
      env: {
        OPENCLAW_AGENT_RUNTIME: "codex",
      },
    });

    expect(warnings).toStrictEqual([
      [
        "- Legacy `openai-codex/*` model refs should be rewritten to `openai/*`.",
        '- agents.defaults.model: openai-codex/gpt-5.5 should become openai/gpt-5.5; current runtime is "codex".',
        "- Run `openclaw doctor --fix`: it rewrites configured model refs and stale sessions to `openai/*`, moves Codex intent to provider/model runtime policy, and clears old whole-agent runtime pins.",
      ].join("\n"),
    ]);
  });

  it("does not warn for canonical OpenAI refs", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(warnings).toStrictEqual([]);
  });

  it("warns when Codex runtime routes are configured while the Codex plugin is disabled", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "gpt-5.5",
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(warnings).toStrictEqual([
      [
        "- Codex runtime is selected, but the Codex plugin is disabled.",
        "- agents.defaults.model.primary: gpt-5.5 resolves to openai/gpt-5.5 with Codex runtime while the Codex plugin is disabled by config.",
        "- Run `openclaw doctor --fix`: it enables plugins.entries.codex, or set the affected OpenAI models to a PI runtime policy.",
      ].join("\n"),
    ]);
  });

  it("warns when Codex runtime has OpenClaw compaction summarizer overrides", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(warnings).toStrictEqual([
      [
        "- Codex runtime uses native server-side compaction and ignores OpenClaw compaction summarizer overrides.",
        "- agents.defaults.compaction.model: openai/gpt-5.4 is ignored while this agent uses Codex runtime.",
        "- agents.defaults.compaction.provider: custom-summary is ignored while this agent uses Codex runtime.",
        "- Run `openclaw doctor --fix`: it removes unsupported Codex compaction overrides.",
      ].join("\n"),
    ]);
  });

  it("warns when implicit default OpenAI Codex runtime has compaction overrides", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(warnings).toStrictEqual([
      [
        "- Codex runtime uses native server-side compaction and ignores OpenClaw compaction summarizer overrides.",
        "- agents.defaults.compaction.model: openai/gpt-5.4 is ignored while this agent uses Codex runtime.",
        "- agents.defaults.compaction.provider: custom-summary is ignored while this agent uses Codex runtime.",
        "- Run `openclaw doctor --fix`: it removes unsupported Codex compaction overrides.",
      ].join("\n"),
    ]);
  });

  it("warns when the Codex app-server runtime alias has compaction overrides", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        agents: {
          defaults: {
            agentRuntime: { id: "codex-app-server" },
            model: "anthropic/claude-sonnet-4.6",
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(warnings).toStrictEqual([
      [
        "- Codex runtime uses native server-side compaction and ignores OpenClaw compaction summarizer overrides.",
        "- agents.defaults.compaction.model: openai/gpt-5.4 is ignored while this agent uses Codex runtime.",
        "- agents.defaults.compaction.provider: custom-summary is ignored while this agent uses Codex runtime.",
        "- Run `openclaw doctor --fix`: it removes unsupported Codex compaction overrides.",
      ].join("\n"),
    ]);
  });

  it("repairs Codex-runtime compaction summarizer overrides by removing them", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
              keepRecentTokens: 10_000,
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Removed agents.defaults.compaction.model; Codex runtime uses native server-side compaction.",
      "Removed agents.defaults.compaction.provider; Codex runtime uses native server-side compaction.",
    ]);
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      keepRecentTokens: 10_000,
    });
  });

  it("repairs compaction overrides for the implicit default OpenAI Codex runtime", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
              keepRecentTokens: 10_000,
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Removed agents.defaults.compaction.model; Codex runtime uses native server-side compaction.",
      "Removed agents.defaults.compaction.provider; Codex runtime uses native server-side compaction.",
    ]);
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      keepRecentTokens: 10_000,
    });
  });

  it("repairs compaction overrides for the Codex app-server runtime alias", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            agentRuntime: { id: "codex-app-server" },
            model: "anthropic/claude-sonnet-4.6",
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
              keepRecentTokens: 10_000,
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Removed agents.defaults.compaction.model; Codex runtime uses native server-side compaction.",
      "Removed agents.defaults.compaction.provider; Codex runtime uses native server-side compaction.",
    ]);
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      keepRecentTokens: 10_000,
    });
  });

  it("repairs compaction overrides for model-scoped Codex app-server runtime aliases", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            models: {
              "openai/gpt-5.5": {
                agentRuntime: { id: "codex-app-server" },
              },
            },
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
              keepRecentTokens: 10_000,
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Removed agents.defaults.compaction.model; Codex runtime uses native server-side compaction.",
      "Removed agents.defaults.compaction.provider; Codex runtime uses native server-side compaction.",
    ]);
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      keepRecentTokens: 10_000,
    });
  });

  it("migrates legacy Lossless compaction config to the context-engine slot", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              model: "openai-codex/gpt-5.4-mini",
              provider: "lossless-claw",
              keepRecentTokens: 10_000,
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.plugins?.slots?.contextEngine).toBe("lossless-claw");
    expect(result.cfg.plugins?.entries?.["lossless-claw"]).toEqual({
      enabled: true,
      config: {
        summaryModel: "openai/gpt-5.4-mini",
      },
      llm: {
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.4-mini"],
      },
    });
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      keepRecentTokens: 10_000,
    });
    expect(result.changes).toContain(
      'Set plugins.slots.contextEngine to "lossless-claw" for legacy Lossless compaction config.',
    );
    expect(result.changes).toContain(
      "Removed agents.defaults.compaction.provider; Lossless now runs through plugins.slots.contextEngine.",
    );
  });

  it("does not migrate mixed Lossless provider-only and summary-model consumers", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              provider: "lossless-claw",
            },
          },
          list: [
            {
              id: "fast",
              model: "openai/gpt-5.5",
              compaction: {
                model: "openai/gpt-5.4-mini",
              },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins).toBeUndefined();
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      provider: "lossless-claw",
    });
    expect(result.cfg.agents?.list?.[0]?.compaction).toEqual({
      model: "openai/gpt-5.4-mini",
    });
    expect(result.warnings).toStrictEqual([
      [
        "- Legacy Lossless compaction config should use the Lossless context-engine slot for Codex.",
        "- agents.defaults.compaction.provider: lossless-claw should become plugins.slots.contextEngine: lossless-claw.",
        "- agents.list.fast.compaction.model: openai/gpt-5.4-mini should become plugins.entries.lossless-claw.config.summaryModel.",
        "- Move the Lossless config manually; doctor will not overwrite an existing non-Lossless context-engine slot or collapse conflicting per-agent summary models.",
      ].join("\n"),
    ]);
  });

  it("preserves Codex runtime policy for migrated Lossless summary models", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://proxy.example.test/v1",
            },
          },
        },
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
            compaction: {
              model: "openai-codex/gpt-5.4-mini",
              provider: "lossless-claw",
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.["lossless-claw"]?.config).toEqual({
      summaryModel: "openai/gpt-5.4-mini",
    });
    expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.4-mini"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(result.changes).toContain(
      'Set agents.defaults.models.openai/gpt-5.4-mini.agentRuntime.id to "codex" so repaired OpenAI refs keep Codex auth routing.',
    );
  });

  it("canonicalizes bare legacy Lossless summary models during migration", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              model: "gpt-5.4-mini",
              provider: "lossless-claw",
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.["lossless-claw"]).toEqual({
      enabled: true,
      config: {
        summaryModel: "openai/gpt-5.4-mini",
      },
      llm: {
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.4-mini"],
      },
    });
    expect(result.cfg.agents?.defaults?.compaction).toBeUndefined();
  });

  it("canonicalizes a case-variant Lossless context-engine slot during migration", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          slots: {
            contextEngine: "Lossless-Claw",
          },
        },
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              model: "openai/gpt-5.4-mini",
              provider: "lossless-claw",
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.plugins?.slots?.contextEngine).toBe("lossless-claw");
    expect(result.cfg.plugins?.entries?.["lossless-claw"]?.config).toEqual({
      summaryModel: "openai/gpt-5.4-mini",
    });
    expect(result.cfg.agents?.defaults?.compaction).toBeUndefined();
  });

  it("does not grant Lossless model override policy without a migrated summary model", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              provider: "lossless-claw",
              keepRecentTokens: 10_000,
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.plugins?.slots?.contextEngine).toBe("lossless-claw");
    expect(result.cfg.plugins?.entries?.["lossless-claw"]).toEqual({
      enabled: true,
      config: {},
    });
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      keepRecentTokens: 10_000,
    });
  });

  it("migrates numeric string agent ids before treating the path label as an index", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          list: [
            {
              id: "other",
              model: "anthropic/claude-sonnet-4-6",
            },
            {
              id: "0",
              model: "openai/gpt-5.5",
              compaction: {
                model: "openai/gpt-5.4-mini",
                provider: "lossless-claw",
              },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(
      (result.cfg.agents?.list?.[0] as Record<string, unknown> | undefined)?.compaction,
    ).toBeUndefined();
    expect(
      (result.cfg.agents?.list?.[1] as Record<string, unknown> | undefined)?.compaction,
    ).toBeUndefined();
    expect(result.cfg.plugins?.entries?.["lossless-claw"]?.config).toEqual({
      summaryModel: "openai/gpt-5.4-mini",
    });
  });

  it("does not collapse conflicting per-agent Lossless summary models", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          list: [
            {
              id: "fast",
              model: "openai/gpt-5.5",
              compaction: {
                model: "openai/gpt-5.4-mini",
                provider: "lossless-claw",
              },
            },
            {
              id: "deep",
              model: "openai/gpt-5.5",
              compaction: {
                model: "openai/gpt-5.5",
                provider: "lossless-claw",
              },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins).toBeUndefined();
    expect(
      (result.cfg.agents?.list?.[0] as Record<string, unknown> | undefined)?.compaction,
    ).toEqual({
      model: "openai/gpt-5.4-mini",
      provider: "lossless-claw",
    });
    expect(
      (result.cfg.agents?.list?.[1] as Record<string, unknown> | undefined)?.compaction,
    ).toEqual({
      model: "openai/gpt-5.5",
      provider: "lossless-claw",
    });
    expect(result.warnings).toStrictEqual([
      [
        "- Legacy Lossless compaction config should use the Lossless context-engine slot for Codex.",
        "- agents.list.fast.compaction.provider: lossless-claw should become plugins.slots.contextEngine: lossless-claw.",
        "- agents.list.fast.compaction.model: openai/gpt-5.4-mini should become plugins.entries.lossless-claw.config.summaryModel.",
        "- agents.list.deep.compaction.provider: lossless-claw should become plugins.slots.contextEngine: lossless-claw.",
        "- agents.list.deep.compaction.model: openai/gpt-5.5 should become plugins.entries.lossless-claw.config.summaryModel.",
        "- Move the Lossless config manually; doctor will not overwrite an existing non-Lossless context-engine slot or collapse conflicting per-agent summary models.",
      ].join("\n"),
    ]);
  });

  it("does not overwrite a non-Lossless context-engine slot", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          slots: {
            contextEngine: "qmd",
          },
        },
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              model: "openai-codex/gpt-5.4",
              provider: "lossless-claw",
              memoryFlush: {
                model: "openai-codex/gpt-5.4-mini",
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([
      [
        "Repaired Codex model routes:",
        "- agents.defaults.compaction.model: openai-codex/gpt-5.4 -> openai/gpt-5.4.",
        "- agents.defaults.compaction.memoryFlush.model: openai-codex/gpt-5.4-mini -> openai/gpt-5.4-mini.",
      ].join("\n"),
      'Set agents.defaults.models.openai/gpt-5.4.agentRuntime.id to "codex" so repaired OpenAI refs keep Codex auth routing.',
    ]);
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4",
      provider: "lossless-claw",
      memoryFlush: {
        model: "openai/gpt-5.4-mini",
      },
    });
    expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.4"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(result.warnings).toStrictEqual([
      [
        "- Legacy Lossless compaction config should use the Lossless context-engine slot for Codex.",
        "- agents.defaults.compaction.provider: lossless-claw should become plugins.slots.contextEngine: lossless-claw.",
        "- agents.defaults.compaction.model: openai/gpt-5.4 should become plugins.entries.lossless-claw.config.summaryModel.",
        "- Move the Lossless config manually; doctor will not overwrite an existing non-Lossless context-engine slot or collapse conflicting per-agent summary models.",
      ].join("\n"),
    ]);
  });

  it("preserves local Lossless models when inherited provider migration is blocked", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          slots: {
            contextEngine: "qmd",
          },
        },
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              provider: "lossless-claw",
            },
          },
          list: [
            {
              id: "fast",
              model: "openai/gpt-5.5",
              agentRuntime: { id: "codex" },
              compaction: {
                model: "openai-codex/gpt-5.4-mini",
              },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([
      [
        "Repaired Codex model routes:",
        "- agents.list.fast.compaction.model: openai-codex/gpt-5.4-mini -> openai/gpt-5.4-mini.",
      ].join("\n"),
      'Set agents.list.fast.models.openai/gpt-5.4-mini.agentRuntime.id to "codex" so repaired OpenAI refs keep Codex auth routing.',
    ]);
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      provider: "lossless-claw",
    });
    expect(
      (result.cfg.agents?.list?.[0] as Record<string, unknown> | undefined)?.compaction,
    ).toEqual({
      model: "openai/gpt-5.4-mini",
    });
    expect(result.cfg.agents?.list?.[0]?.agentRuntime).toEqual({ id: "codex" });
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4-mini"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(result.warnings).toStrictEqual([
      [
        "- Legacy Lossless compaction config should use the Lossless context-engine slot for Codex.",
        "- agents.defaults.compaction.provider: lossless-claw should become plugins.slots.contextEngine: lossless-claw.",
        "- agents.list.fast.compaction.model: openai/gpt-5.4-mini should become plugins.entries.lossless-claw.config.summaryModel.",
        "- Move the Lossless config manually; doctor will not overwrite an existing non-Lossless context-engine slot or collapse conflicting per-agent summary models.",
      ].join("\n"),
    ]);
  });

  it("preserves Codex runtime policy for each migrated per-agent Lossless model", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://proxy.example.test/v1",
              agentRuntime: { id: "pi" },
            },
          },
        },
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
            compaction: {
              model: "openai-codex/gpt-5.4-mini",
              provider: "lossless-claw",
            },
          },
          list: [
            {
              id: "fast",
              model: "openai/gpt-5.5",
              models: {
                "openai/gpt-5.5": {
                  agentRuntime: {
                    id: "codex",
                  },
                },
              },
              compaction: {
                model: "openai-codex/gpt-5.4-mini",
              },
            },
            {
              id: "deep",
              model: "openai/gpt-5.5",
              models: {
                "openai/gpt-5.5": {
                  agentRuntime: {
                    id: "codex",
                  },
                },
              },
              compaction: {
                model: "openai-codex/gpt-5.4-mini",
              },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.cfg.plugins?.slots?.contextEngine).toBe("lossless-claw");
    expect(result.cfg.plugins?.entries?.["lossless-claw"]?.config).toEqual({
      summaryModel: "openai/gpt-5.4-mini",
    });
    expect(result.cfg.agents?.defaults?.compaction).toBeUndefined();
    expect(result.cfg.agents?.list?.[0]?.compaction).toBeUndefined();
    expect(result.cfg.agents?.list?.[1]?.compaction).toBeUndefined();
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4-mini"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(result.cfg.agents?.list?.[1]?.models?.["openai/gpt-5.4-mini"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(result.changes).toContain(
      'Set agents.list.fast.models.openai/gpt-5.4-mini.agentRuntime.id to "codex" so repaired OpenAI refs keep Codex auth routing.',
    );
    expect(result.changes).toContain(
      'Set agents.list.deep.models.openai/gpt-5.4-mini.agentRuntime.id to "codex" so repaired OpenAI refs keep Codex auth routing.',
    );
  });

  it("preserves Codex runtime policy for blocked Lossless summary rewrites", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://proxy.example.test/v1",
            },
          },
        },
        plugins: {
          slots: {
            contextEngine: "qmd",
          },
        },
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            models: {
              "openai/gpt-5.5": {
                agentRuntime: {
                  id: "codex",
                },
              },
            },
            compaction: {
              model: "openai-codex/gpt-5.4-mini",
              provider: "lossless-claw",
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([
      [
        "Repaired Codex model routes:",
        "- agents.defaults.compaction.model: openai-codex/gpt-5.4-mini -> openai/gpt-5.4-mini.",
      ].join("\n"),
      'Set agents.defaults.models.openai/gpt-5.4-mini.agentRuntime.id to "codex" so repaired OpenAI refs keep Codex auth routing.',
    ]);
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4-mini",
      provider: "lossless-claw",
    });
    expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.4-mini"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(result.warnings).toStrictEqual([
      [
        "- Legacy Lossless compaction config should use the Lossless context-engine slot for Codex.",
        "- agents.defaults.compaction.provider: lossless-claw should become plugins.slots.contextEngine: lossless-claw.",
        "- agents.defaults.compaction.model: openai/gpt-5.4-mini should become plugins.entries.lossless-claw.config.summaryModel.",
        "- Move the Lossless config manually; doctor will not overwrite an existing non-Lossless context-engine slot or collapse conflicting per-agent summary models.",
      ].join("\n"),
    ]);
  });

  it("points inherited Lossless model warnings at defaults when migration is blocked", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          slots: {
            contextEngine: "qmd",
          },
        },
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              model: "openai/gpt-5.4-mini",
            },
          },
          list: [
            {
              id: "fast",
              model: "openai/gpt-5.5",
              models: {
                "openai/gpt-5.5": {
                  agentRuntime: {
                    id: "codex",
                  },
                },
              },
              compaction: {
                provider: "lossless-claw",
              },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4-mini",
    });
    expect(
      (result.cfg.agents?.list?.[0] as Record<string, unknown> | undefined)?.compaction,
    ).toEqual({
      provider: "lossless-claw",
    });
    expect(result.warnings).toStrictEqual([
      [
        "- Legacy Lossless compaction config should use the Lossless context-engine slot for Codex.",
        "- agents.list.fast.compaction.provider: lossless-claw should become plugins.slots.contextEngine: lossless-claw.",
        "- agents.defaults.compaction.model: openai/gpt-5.4-mini should become plugins.entries.lossless-claw.config.summaryModel.",
        "- Move the Lossless config manually; doctor will not overwrite an existing non-Lossless context-engine slot or collapse conflicting per-agent summary models.",
      ].join("\n"),
    ]);
  });

  it("canonicalizes inherited Lossless summary models when migration is blocked", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://proxy.example.test/v1",
            },
          },
        },
        plugins: {
          slots: {
            contextEngine: "qmd",
          },
        },
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-6",
            compaction: {
              model: "openai-codex/gpt-5.4-mini",
            },
          },
          list: [
            {
              id: "fast",
              model: "openai/gpt-5.5",
              models: {
                "openai/gpt-5.5": {
                  agentRuntime: {
                    id: "codex",
                  },
                },
              },
              compaction: {
                provider: "lossless-claw",
              },
            },
            {
              id: "deep",
              model: "openai/gpt-5.5",
              models: {
                "openai/gpt-5.5": {
                  agentRuntime: {
                    id: "codex",
                  },
                },
              },
              compaction: {
                provider: "lossless-claw",
              },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([
      [
        "Repaired Codex model routes:",
        "- agents.defaults.compaction.model: openai-codex/gpt-5.4-mini -> openai/gpt-5.4-mini.",
      ].join("\n"),
      'Set agents.list.fast.models.openai/gpt-5.4-mini.agentRuntime.id to "codex" so repaired OpenAI refs keep Codex auth routing.',
      'Set agents.list.deep.models.openai/gpt-5.4-mini.agentRuntime.id to "codex" so repaired OpenAI refs keep Codex auth routing.',
    ]);
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4-mini",
    });
    expect(result.cfg.agents?.list?.[0]?.compaction).toEqual({
      provider: "lossless-claw",
    });
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4-mini"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(result.cfg.agents?.list?.[1]?.compaction).toEqual({
      provider: "lossless-claw",
    });
    expect(result.cfg.agents?.list?.[1]?.models?.["openai/gpt-5.4-mini"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(result.warnings).toStrictEqual([
      [
        "- Legacy Lossless compaction config should use the Lossless context-engine slot for Codex.",
        "- agents.list.fast.compaction.provider: lossless-claw should become plugins.slots.contextEngine: lossless-claw.",
        "- agents.defaults.compaction.model: openai/gpt-5.4-mini should become plugins.entries.lossless-claw.config.summaryModel.",
        "- agents.list.deep.compaction.provider: lossless-claw should become plugins.slots.contextEngine: lossless-claw.",
        "- agents.defaults.compaction.model: openai/gpt-5.4-mini should become plugins.entries.lossless-claw.config.summaryModel.",
        "- Move the Lossless config manually; doctor will not overwrite an existing non-Lossless context-engine slot or collapse conflicting per-agent summary models.",
      ].join("\n"),
    ]);
  });

  it("does not migrate Lossless compaction for agents whose Codex runtime pin is being cleared", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          list: [
            {
              id: "worker",
              model: "anthropic/claude-sonnet-4-6",
              agentRuntime: { id: "codex" },
              compaction: {
                model: "openai/gpt-5.4",
                provider: "lossless-claw",
              },
            },
          ],
        },
        hooks: {
          gmail: {
            model: "openai-codex/gpt-5.4",
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([
      "Repaired Codex model routes:\n- hooks.gmail.model: openai-codex/gpt-5.4 -> openai/gpt-5.4.",
      "Removed agents.list.worker.agentRuntime; runtime is now provider/model scoped.",
    ]);
    expect(result.cfg.plugins).toBeUndefined();
    expect(result.cfg.agents?.list?.[0]).toEqual({
      id: "worker",
      model: "anthropic/claude-sonnet-4-6",
      compaction: {
        model: "openai/gpt-5.4",
        provider: "lossless-claw",
      },
    });
    expect(result.warnings).toStrictEqual([]);
  });

  it("preserves local compaction overrides for agents whose Codex runtime pin is being cleared", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          list: [
            {
              id: "worker",
              model: "anthropic/claude-sonnet-4-6",
              agentRuntime: { id: "codex" },
              compaction: {
                model: "openai/gpt-5.4",
                provider: "custom-summary",
              },
            },
          ],
        },
        hooks: {
          gmail: {
            model: "openai-codex/gpt-5.4",
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([
      "Repaired Codex model routes:\n- hooks.gmail.model: openai-codex/gpt-5.4 -> openai/gpt-5.4.",
      "Removed agents.list.worker.agentRuntime; runtime is now provider/model scoped.",
    ]);
    expect(result.cfg.agents?.list?.[0]).toEqual({
      id: "worker",
      model: "anthropic/claude-sonnet-4-6",
      compaction: {
        model: "openai/gpt-5.4",
        provider: "custom-summary",
      },
    });
    expect(result.warnings).toStrictEqual([]);
  });

  it("does not warn about compaction overrides for runtime pins doctor will clear", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "worker",
            model: "anthropic/claude-sonnet-4-6",
            agentRuntime: { id: "codex" },
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
            },
          },
        ],
      },
      hooks: {
        gmail: {
          model: "openai-codex/gpt-5.4",
        },
      },
    } as unknown as OpenClawConfig;

    expect(collectCodexRouteWarnings({ cfg })).toStrictEqual([
      [
        "- Legacy `openai-codex/*` model refs should be rewritten to `openai/*`.",
        "- hooks.gmail.model: openai-codex/gpt-5.4 should become openai/gpt-5.4.",
        "- Run `openclaw doctor --fix`: it rewrites configured model refs and stale sessions to `openai/*`, moves Codex intent to provider/model runtime policy, and clears old whole-agent runtime pins.",
      ].join("\n"),
    ]);
  });

  it("does not migrate shared Lossless summary models inherited by non-Codex agents", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              model: "openai/gpt-5.4",
            },
          },
          list: [
            {
              id: "codex",
              model: "openai/gpt-5.5",
              compaction: {
                provider: "lossless-claw",
              },
            },
            {
              id: "worker",
              model: "anthropic/claude-sonnet-4-6",
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins).toBeUndefined();
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4",
    });
    expect(result.cfg.agents?.list?.[0]?.compaction).toEqual({
      provider: "lossless-claw",
    });
    expect(result.warnings).toStrictEqual([
      [
        "- Legacy Lossless compaction config should use the Lossless context-engine slot for Codex.",
        "- agents.list.codex.compaction.provider: lossless-claw should become plugins.slots.contextEngine: lossless-claw.",
        "- agents.defaults.compaction.model: openai/gpt-5.4 should become plugins.entries.lossless-claw.config.summaryModel.",
        "- Move the Lossless config manually; doctor will not overwrite an existing non-Lossless context-engine slot or collapse conflicting per-agent summary models.",
      ].join("\n"),
    ]);
  });

  it("does not discard a legacy Lossless model that conflicts with an existing summary model", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            "lossless-claw": {
              enabled: true,
              config: {
                summaryModel: "openai/gpt-5.5",
              },
            },
          },
        },
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              model: "openai/gpt-5.4",
              provider: "lossless-claw",
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.["lossless-claw"]?.config).toEqual({
      summaryModel: "openai/gpt-5.5",
    });
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4",
      provider: "lossless-claw",
    });
    expect(result.warnings).toStrictEqual([
      [
        "- Legacy Lossless compaction config should use the Lossless context-engine slot for Codex.",
        "- agents.defaults.compaction.provider: lossless-claw should become plugins.slots.contextEngine: lossless-claw.",
        "- agents.defaults.compaction.model: openai/gpt-5.4 should become plugins.entries.lossless-claw.config.summaryModel.",
        "- Move the Lossless config manually; doctor will not overwrite an existing non-Lossless context-engine slot or collapse conflicting per-agent summary models.",
      ].join("\n"),
    ]);
  });

  it("does not migrate shared Lossless defaults inherited by non-Codex agents", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-6",
            compaction: {
              model: "openai/gpt-5.4",
              provider: "lossless-claw",
            },
          },
          list: [
            {
              id: "codex",
              model: "openai/gpt-5.5",
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins).toBeUndefined();
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4",
      provider: "lossless-claw",
    });
    expect(result.warnings).toStrictEqual([
      [
        "- Legacy Lossless compaction config should use the Lossless context-engine slot for Codex.",
        "- agents.defaults.compaction.provider: lossless-claw should become plugins.slots.contextEngine: lossless-claw.",
        "- agents.defaults.compaction.model: openai/gpt-5.4 should become plugins.entries.lossless-claw.config.summaryModel.",
        "- Move the Lossless config manually; doctor will not overwrite an existing non-Lossless context-engine slot or collapse conflicting per-agent summary models.",
      ].join("\n"),
    ]);
  });

  it("preserves shared Lossless summary models inherited by non-Codex agents with local providers", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              model: "openai/gpt-5.4",
              provider: "lossless-claw",
            },
          },
          list: [
            {
              id: "worker",
              model: "anthropic/claude-sonnet-4-6",
              compaction: {
                provider: "custom-summary",
              },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins).toBeUndefined();
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4",
      provider: "lossless-claw",
    });
    expect((result.cfg.agents?.list?.[0] as Record<string, unknown>).compaction).toEqual({
      provider: "custom-summary",
    });
    expect(result.warnings).toStrictEqual([
      [
        "- Legacy Lossless compaction config should use the Lossless context-engine slot for Codex.",
        "- agents.defaults.compaction.provider: lossless-claw should become plugins.slots.contextEngine: lossless-claw.",
        "- agents.defaults.compaction.model: openai/gpt-5.4 should become plugins.entries.lossless-claw.config.summaryModel.",
        "- Move the Lossless config manually; doctor will not overwrite an existing non-Lossless context-engine slot or collapse conflicting per-agent summary models.",
      ].join("\n"),
    ]);
  });

  it("keeps shared default compaction summarizer overrides for non-Codex agents", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
              keepRecentTokens: 10_000,
            },
          },
          list: [
            {
              id: "worker",
              model: "anthropic/claude-sonnet-4-6",
              models: {
                "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "pi" } },
              },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4",
      provider: "custom-summary",
      keepRecentTokens: 10_000,
    });
    expect(result.warnings).toStrictEqual([
      [
        "- Codex runtime uses native server-side compaction and ignores OpenClaw compaction summarizer overrides.",
        "- agents.defaults.compaction.model: openai/gpt-5.4 is ignored while this agent uses Codex runtime.",
        "- agents.defaults.compaction.provider: custom-summary is ignored while this agent uses Codex runtime.",
        "- Move or remove shared `agents.defaults.compaction.model/provider` settings manually; doctor keeps shared defaults while non-Codex agents can inherit them.",
      ].join("\n"),
    ]);
  });

  it("warns when listed Codex agents inherit shared default compaction overrides", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-6",
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
            },
          },
          list: [
            {
              id: "codex",
              model: "openai/gpt-5.5",
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4",
      provider: "custom-summary",
    });
    expect(result.warnings).toStrictEqual([
      [
        "- Codex runtime uses native server-side compaction and ignores OpenClaw compaction summarizer overrides.",
        "- agents.defaults.compaction.model: openai/gpt-5.4 is ignored while this agent uses Codex runtime.",
        "- agents.defaults.compaction.provider: custom-summary is ignored while this agent uses Codex runtime.",
        "- Move or remove shared `agents.defaults.compaction.model/provider` settings manually; doctor keeps shared defaults while non-Codex agents can inherit them.",
      ].join("\n"),
    ]);
  });

  it("removes shared default compaction fields that non-Codex agents override", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
              keepRecentTokens: 10_000,
            },
          },
          list: [
            {
              id: "worker",
              model: "anthropic/claude-sonnet-4-6",
              ...({
                compaction: {
                  model: "anthropic/claude-haiku-4-6",
                },
              } as Record<string, unknown>),
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([
      "Removed agents.defaults.compaction.model; Codex runtime uses native server-side compaction.",
    ]);
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      provider: "custom-summary",
      keepRecentTokens: 10_000,
    });
    expect(result.warnings).toStrictEqual([
      [
        "- Codex runtime uses native server-side compaction and ignores OpenClaw compaction summarizer overrides.",
        "- agents.defaults.compaction.provider: custom-summary is ignored while this agent uses Codex runtime.",
        "- Move or remove shared `agents.defaults.compaction.model/provider` settings manually; doctor keeps shared defaults while non-Codex agents can inherit them.",
      ].join("\n"),
    ]);
  });

  it("keeps shared default compaction overrides when repairing legacy runtime pins", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
            },
          },
          list: [
            {
              id: "worker",
              model: "anthropic/claude-sonnet-4-6",
              agentRuntime: { id: "codex" },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4",
      provider: "custom-summary",
    });
    expect(result.cfg.agents?.list?.[0]?.agentRuntime).toBeUndefined();
    expect(result.changes.join("\n")).not.toContain("Removed agents.defaults.compaction");
    expect(result.warnings).toStrictEqual([
      [
        "- Codex runtime uses native server-side compaction and ignores OpenClaw compaction summarizer overrides.",
        "- agents.defaults.compaction.model: openai/gpt-5.4 is ignored while this agent uses Codex runtime.",
        "- agents.defaults.compaction.provider: custom-summary is ignored while this agent uses Codex runtime.",
        "- Move or remove shared `agents.defaults.compaction.model/provider` settings manually; doctor keeps shared defaults while non-Codex agents can inherit them.",
      ].join("\n"),
    ]);
  });

  it("removes defaults when listed agents still have active Codex runtime pins", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
            },
          },
          list: [
            {
              id: "worker",
              model: "anthropic/claude-sonnet-4-6",
              agentRuntime: { id: "codex" },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Removed agents.defaults.compaction.model; Codex runtime uses native server-side compaction.",
      "Removed agents.defaults.compaction.provider; Codex runtime uses native server-side compaction.",
    ]);
    expect(result.cfg.agents?.defaults?.compaction).toBeUndefined();
    expect(result.cfg.agents?.list?.[0]?.agentRuntime).toEqual({ id: "codex" });
  });

  it("does not clear active runtime pins for compaction-only legacy refs", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              model: "openai-codex/gpt-5.4",
              provider: "custom-summary",
            },
          },
          list: [
            {
              id: "worker",
              model: "anthropic/claude-sonnet-4-6",
              agentRuntime: { id: "codex" },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([
      "Removed agents.defaults.compaction.model; Codex runtime uses native server-side compaction.",
      "Removed agents.defaults.compaction.provider; Codex runtime uses native server-side compaction.",
    ]);
    expect(result.cfg.agents?.defaults?.compaction).toBeUndefined();
    expect(result.cfg.agents?.defaults?.models).toBeUndefined();
    expect(result.cfg.agents?.list?.[0]?.agentRuntime).toEqual({ id: "codex" });
  });

  it("keeps active runtime pins when shared compaction-only refs are preserved", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              model: "openai-codex/gpt-5.4",
              provider: "custom-summary",
            },
          },
          list: [
            {
              id: "codex-worker",
              model: "anthropic/claude-sonnet-4-6",
              agentRuntime: { id: "codex" },
            },
            {
              id: "pi-worker",
              model: "anthropic/claude-sonnet-4-6",
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes.join("\n")).toContain(
      "agents.defaults.compaction.model: openai-codex/gpt-5.4 -> openai/gpt-5.4.",
    );
    expect(result.changes.join("\n")).not.toContain(
      "Removed agents.list.codex-worker.agentRuntime",
    );
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4",
      provider: "custom-summary",
    });
    expect(result.cfg.agents?.list?.[0]?.agentRuntime).toEqual({ id: "codex" });
  });

  it("does not ignore active runtime pins for unrepaired stale refs", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://proxy.example.test/v1",
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          agentRuntime: { id: "codex" },
          compaction: {
            model: "openai/gpt-5.4",
            provider: "custom-summary",
          },
        },
        list: [
          {
            id: "worker",
            model: "anthropic/claude-sonnet-4-6",
          },
        ],
      },
      hooks: {
        gmail: {
          model: "openai-codex/gpt-5.4",
        },
      },
    } as unknown as OpenClawConfig;

    expect(collectCodexRouteWarnings({ cfg })).toStrictEqual([
      [
        "- Legacy `openai-codex/*` model refs should be rewritten to `openai/*`.",
        "- hooks.gmail.model: openai-codex/gpt-5.4 should become openai/gpt-5.4.",
        "- Run `openclaw doctor --fix`: it rewrites configured model refs and stale sessions to `openai/*`, moves Codex intent to provider/model runtime policy, and clears old whole-agent runtime pins.",
      ].join("\n"),
      [
        "- Codex runtime uses native server-side compaction and ignores OpenClaw compaction summarizer overrides.",
        "- agents.defaults.compaction.model: openai/gpt-5.4 is ignored while this agent uses Codex runtime.",
        "- agents.defaults.compaction.provider: custom-summary is ignored while this agent uses Codex runtime.",
        "- Run `openclaw doctor --fix`: it removes unsupported Codex compaction overrides.",
      ].join("\n"),
    ]);

    const result = maybeRepairCodexRoutes({
      cfg,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([
      "Removed agents.defaults.compaction.model; Codex runtime uses native server-side compaction.",
      "Removed agents.defaults.compaction.provider; Codex runtime uses native server-side compaction.",
    ]);
    expect(result.cfg.agents?.defaults?.compaction).toBeUndefined();
    expect(result.cfg.agents?.defaults?.agentRuntime).toEqual({ id: "codex" });
    expect(result.cfg.hooks?.gmail?.model).toBe("openai-codex/gpt-5.4");
  });

  it("keeps default compaction overrides when route repair clears the default Codex pin", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-6",
            agentRuntime: { id: "codex" },
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
            },
          },
        },
        hooks: {
          gmail: {
            model: "openai-codex/gpt-5.4",
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Repaired Codex model routes:\n- hooks.gmail.model: openai-codex/gpt-5.4 -> openai/gpt-5.4.",
      "Removed agents.defaults.agentRuntime; runtime is now provider/model scoped.",
    ]);
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4",
      provider: "custom-summary",
    });
    expect(result.cfg.agents?.defaults?.agentRuntime).toBeUndefined();
    expect(result.cfg.hooks?.gmail?.model).toBe("openai/gpt-5.4");
  });

  it("keeps doctor fix hint for agent-specific compaction overrides", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-6",
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
            },
          },
          list: [
            {
              id: "codex",
              model: "openai/gpt-5.5",
              compaction: {
                model: "openai/gpt-5.4",
              },
            },
            {
              id: "worker",
              model: "anthropic/claude-sonnet-4-6",
            },
          ],
        },
      } as unknown as OpenClawConfig,
    });

    expect(warnings).toStrictEqual([
      [
        "- Codex runtime uses native server-side compaction and ignores OpenClaw compaction summarizer overrides.",
        "- agents.defaults.compaction.provider: custom-summary is ignored while this agent uses Codex runtime.",
        "- Move or remove shared `agents.defaults.compaction.model/provider` settings manually; doctor keeps shared defaults while non-Codex agents can inherit them.",
      ].join("\n"),
      [
        "- Codex runtime uses native server-side compaction and ignores OpenClaw compaction summarizer overrides.",
        "- agents.list.codex.compaction.model: openai/gpt-5.4 is ignored while this agent uses Codex runtime.",
        "- Run `openclaw doctor --fix`: it removes unsupported Codex compaction overrides.",
      ].join("\n"),
    ]);
  });

  it("canonicalizes kept shared default compaction model refs", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            compaction: {
              model: "openai-codex/gpt-5.4",
              provider: "custom-summary",
            },
          },
          list: [
            {
              id: "worker",
              model: "anthropic/claude-sonnet-4-6",
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4",
      provider: "custom-summary",
    });
    expect(result.cfg.agents?.defaults?.models).toBeUndefined();
    expect(result.cfg.agents?.defaults?.agentRuntime).toBeUndefined();
    expect(result.warnings).toStrictEqual([
      [
        "- Codex runtime uses native server-side compaction and ignores OpenClaw compaction summarizer overrides.",
        "- agents.defaults.compaction.model: openai/gpt-5.4 is ignored while this agent uses Codex runtime.",
        "- agents.defaults.compaction.provider: custom-summary is ignored while this agent uses Codex runtime.",
        "- Move or remove shared `agents.defaults.compaction.model/provider` settings manually; doctor keeps shared defaults while non-Codex agents can inherit them.",
      ].join("\n"),
    ]);
  });

  it("does not broaden runtime policy from kept compaction-only refs", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "pi" },
              models: [],
            },
          },
        },
        agents: {
          defaults: {
            agentRuntime: { id: "codex" },
            model: "openai-codex/gpt-5.5",
            heartbeat: {
              model: "openai/gpt-5.4",
            },
            compaction: {
              model: "openai-codex/gpt-5.4",
              provider: "custom-summary",
            },
          },
          list: [
            {
              id: "worker",
              model: "anthropic/claude-sonnet-4-6",
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.cfg.agents?.defaults?.heartbeat?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4",
      provider: "custom-summary",
    });
    expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.4"]).toBeUndefined();
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.4",
        config: result.cfg,
      }).runtime,
    ).toBe("pi");
  });

  it("repairs configured Codex model refs to canonical OpenAI refs with model-scoped Codex runtime", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            agentRuntime: { id: "codex" },
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
      } as unknown as OpenClawConfig,
      shouldRepair: true,
      codexRuntimeReady: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      [
        "Repaired Codex model routes:",
        "- agents.defaults.model.primary: openai-codex/gpt-5.5 -> openai/gpt-5.5.",
        "- agents.defaults.model.fallbacks.0: openai-codex/gpt-5.4 -> openai/gpt-5.4.",
        "- agents.defaults.heartbeat.model: openai-codex/gpt-5.4-mini -> openai/gpt-5.4-mini.",
        "- agents.defaults.subagents.model.primary: openai-codex/gpt-5.5 -> openai/gpt-5.5.",
        "- agents.defaults.subagents.model.fallbacks.0: openai-codex/gpt-5.4 -> openai/gpt-5.4.",
        "- agents.defaults.compaction.memoryFlush.model: openai-codex/gpt-5.4-mini -> openai/gpt-5.4-mini.",
        "- agents.defaults.models.openai-codex/gpt-5.5: openai-codex/gpt-5.5 -> openai/gpt-5.5.",
        "- agents.list.worker.model: openai-codex/gpt-5.4 -> openai/gpt-5.4.",
        "- channels.modelByChannel.telegram.default: openai-codex/gpt-5.4 -> openai/gpt-5.4.",
        "- hooks.mappings.0.model: openai-codex/gpt-5.4-mini -> openai/gpt-5.4-mini.",
        "- hooks.gmail.model: openai-codex/gpt-5.4 -> openai/gpt-5.4.",
        "- tools.subagents.model.primary: openai-codex/gpt-5.4 -> openai/gpt-5.4.",
        "- tools.subagents.model.fallbacks.0: openai-codex/gpt-5.4-mini -> openai/gpt-5.4-mini.",
        "- messages.tts.summaryModel: openai-codex/gpt-5.4-mini -> openai/gpt-5.4-mini.",
      ].join("\n"),
      'Set agents.defaults.models.openai/gpt-5.5.agentRuntime.id to "codex" so repaired OpenAI refs keep Codex auth routing.',
      'Set agents.defaults.models.openai/gpt-5.4.agentRuntime.id to "codex" so repaired OpenAI refs keep Codex auth routing.',
      'Set agents.list.worker.models.openai/gpt-5.4.agentRuntime.id to "codex" so repaired OpenAI refs keep Codex auth routing.',
      "Removed agents.defaults.agentRuntime; runtime is now provider/model scoped.",
      "Removed agents.list.worker.agentRuntime; runtime is now provider/model scoped.",
      "Removed agents.defaults.compaction.model; Codex runtime uses native server-side compaction.",
    ]);
    expect(result.cfg.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
    });
    expect(result.cfg.agents?.defaults?.heartbeat?.model).toBe("openai/gpt-5.4-mini");
    expect(result.cfg.agents?.defaults?.subagents?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["openai/gpt-5.4"],
    });
    expect(result.cfg.agents?.defaults?.compaction?.model).toBeUndefined();
    expect(result.cfg.agents?.defaults?.compaction?.memoryFlush?.model).toBe("openai/gpt-5.4-mini");
    expect(result.cfg.agents?.defaults?.agentRuntime).toBeUndefined();
    expect(result.cfg.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "codex", agentRuntime: { id: "codex" } },
      "openai/gpt-5.4": { agentRuntime: { id: "codex" } },
    });
    expect(result.cfg.agents?.list?.[0]?.id).toBe("worker");
    expect(result.cfg.agents?.list?.[0]?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.list?.[0]?.agentRuntime).toBeUndefined();
    expect(result.cfg.agents?.list?.[0]?.models).toEqual({
      "openai/gpt-5.4": { agentRuntime: { id: "codex" } },
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

  it("keeps whole-agent runtime pins while repairing compaction-only model refs and overrides", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            agentRuntime: { id: "codex" },
            model: "anthropic/claude-sonnet-4.6",
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
              memoryFlush: {
                model: "openai-codex/gpt-5.4-mini",
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
      codexRuntimeReady: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      [
        "Repaired Codex model routes:",
        "- agents.defaults.compaction.memoryFlush.model: openai-codex/gpt-5.4-mini -> openai/gpt-5.4-mini.",
      ].join("\n"),
      "Removed agents.defaults.compaction.model; Codex runtime uses native server-side compaction.",
      "Removed agents.defaults.compaction.provider; Codex runtime uses native server-side compaction.",
    ]);
    expect(result.cfg.agents?.defaults?.agentRuntime).toEqual({ id: "codex" });
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      memoryFlush: {
        model: "openai/gpt-5.4-mini",
      },
    });
  });

  it("repairs legacy routes without requiring OAuth readiness", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.cfg.agents?.defaults?.agentRuntime).toBeUndefined();
    expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(result.changes.join("\n")).toContain("agentRuntime.id");
  });

  it("re-enables the Codex plugin when default OpenAI routes use Codex runtime", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          allow: ["openai"],
          entries: {
            openai: { enabled: true },
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "gpt-5.5",
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
      "Added codex to plugins.allow because configured agent routes use Codex runtime.",
    ]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.cfg.plugins?.allow).toEqual(["openai", "codex"]);
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.5",
        config: result.cfg,
      }).runtime,
    ).toBe("codex");
  });

  it("re-enables the Codex plugin when a default heartbeat model uses Codex runtime", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-6",
            heartbeat: {
              model: "gpt-5.5",
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
    ]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("re-enables the Codex plugin when a default subagent model uses Codex runtime", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-6",
            subagents: {
              model: {
                primary: "gpt-5.5",
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
    ]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("re-enables the Codex plugin when an agent inherits a default heartbeat model that uses Codex runtime", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            heartbeat: {
              model: "gpt-5.5",
            },
          },
          list: [
            {
              id: "research",
              model: "anthropic/claude-sonnet-4-6",
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
    ]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("re-enables the Codex plugin when an agent model alias resolves to OpenAI", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: "xiaomi/mimo-v2-pro-mit",
            models: {
              "openai/xiaomi/mimo-v2-pro-mit": {
                alias: "xiaomi/mimo-v2-pro-mit",
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
    ]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("keeps the Codex plugin disabled when a bare alias resolves through a non-OpenAI default provider", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-6",
            models: {
              "claude-opus-4-6": {
                alias: "opus",
              },
            },
            subagents: {
              model: "opus",
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
  });

  it("keeps the Codex plugin disabled when a bare alias inherits a default provider from the primary alias", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: "sonnet",
            models: {
              "anthropic/claude-sonnet-4-6": {
                alias: "sonnet",
              },
              "claude-opus-4-6": {
                alias: "opus",
              },
            },
            subagents: {
              model: "opus",
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
  });

  it("keeps the Codex plugin disabled when an auth-profiled bare alias resolves outside OpenAI", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: "fast@work",
            models: {
              "anthropic/claude-sonnet-4-6": {
                alias: "fast",
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
  });

  it("re-enables the Codex plugin when a per-agent-only bare alias falls back to OpenAI", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          list: [
            {
              id: "worker",
              model: "fast",
              models: {
                "anthropic/claude-sonnet-4-6": {
                  alias: "fast",
                },
              },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
    ]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("re-enables the Codex plugin when a listed-agent bare primary ignores per-agent provider metadata", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          list: [
            {
              id: "worker",
              model: "claude-sonnet-4-6",
              models: {
                "anthropic/claude-sonnet-4-6": {},
              },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
    ]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("re-enables the Codex plugin when defaults inherit the implicit OpenAI model", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            models: {
              "anthropic/claude-sonnet-4-6": {
                alias: "sonnet",
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
    ]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("keeps Codex disabled when no agent routes are configured", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          allow: ["brave"],
          entries: {
            brave: { enabled: true },
            codex: { enabled: false },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
    expect(result.cfg.plugins?.allow).toEqual(["brave"]);
  });

  it("re-enables the Codex plugin when defaults configure only non-Codex fallbacks", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: {
              fallbacks: ["anthropic/claude-sonnet-4-6"],
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
    ]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("keeps Codex disabled when implicit defaults resolve to a configured provider", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        models: {
          providers: {
            anthropic: {
              models: [{ id: "claude-sonnet-4-6" }],
            },
          },
        },
        agents: {
          defaults: {},
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
  });

  it("keeps Codex disabled for unused OpenAI model-map metadata", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-6",
            models: {
              "openai/gpt-5.5": {
                alias: "gpt",
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
  });

  it("re-enables Codex for model-map runtime policies even when the primary is non-Codex", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-6",
            models: {
              "openai/gpt-5.5": {
                agentRuntime: { id: "codex" },
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
    ]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("re-enables Codex for default model-map runtime policies inherited by listed agents", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.5": {
                agentRuntime: { id: "codex" },
              },
            },
          },
          list: [
            {
              id: "worker",
              model: "anthropic/claude-sonnet-4-6",
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
    ]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("keeps Codex disabled when openrouter:auto resolves outside OpenAI", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: "openrouter:auto",
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
  });

  it("keeps Codex disabled when a bare alias inherits an OpenRouter compat primary provider", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: "openrouter:auto",
            models: {
              "claude-sonnet-4-6": {
                alias: "sonnet",
              },
            },
            subagents: {
              model: "sonnet",
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
  });

  it("keeps Codex disabled when an alias resolves to an OpenRouter compat model", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: "router-auto",
            models: {
              "openrouter:auto": {
                alias: "router-auto",
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
  });

  it("re-enables the Codex plugin when a channel model override uses Codex runtime", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-6",
          },
        },
        channels: {
          modelByChannel: {
            telegram: {
              default: "gpt-5.5",
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
    ]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("uses normalized runtime agent ids when checking model runtime policy", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          list: [
            {
              id: "",
              model: "gpt-5.5",
              models: {
                "openai/gpt-5.5": {
                  agentRuntime: { id: "pi" },
                },
              },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
  });

  it("does not make an empty plugin allowlist restrictive when re-enabling Codex", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          allow: [],
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: "gpt-5.5",
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.changes).toStrictEqual([
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
    ]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.cfg.plugins?.allow).toEqual([]);
  });

  it("adds Codex to a non-empty plugin allowlist when OpenAI routes require Codex runtime", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          allow: ["openai"],
          entries: {
            openai: { enabled: true },
          },
        },
        agents: {
          defaults: {
            model: "gpt-5.5",
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
      "Added codex to plugins.allow because configured agent routes use Codex runtime.",
    ]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.cfg.plugins?.allow).toEqual(["openai", "codex"]);
  });

  it("treats bundled discovery compat allowlists as restrictive for the Codex harness", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          allow: ["openai"],
          bundledDiscovery: "compat",
          entries: {
            openai: { enabled: true },
          },
        },
        agents: {
          defaults: {
            model: "gpt-5.5",
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
      "Added codex to plugins.allow because configured agent routes use Codex runtime.",
    ]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.cfg.plugins?.allow).toEqual(["openai", "codex"]);
  });

  it("adds Codex to bundled discovery compat allowlists when re-enabling Codex", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          allow: ["openai"],
          bundledDiscovery: "compat",
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: "gpt-5.5",
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
      "Added codex to plugins.allow because configured agent routes use Codex runtime.",
    ]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.cfg.plugins?.allow).toEqual(["openai", "codex"]);
  });

  it("keeps the Codex plugin disabled when OpenAI routes explicitly use the PI runtime", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        models: {
          providers: {
            openai: {
              agentRuntime: { id: "pi" },
              models: [],
            },
          },
        },
        agents: {
          defaults: {
            model: "gpt-5.5",
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.5",
        config: result.cfg,
      }).runtime,
    ).toBe("pi");
  });

  it("keeps the Codex plugin disabled when an auth-profiled OpenAI route explicitly uses the PI runtime", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        agents: {
          defaults: {
            model: "openai/gpt-5.5@work",
            models: {
              "openai/gpt-5.5": {
                agentRuntime: { id: "pi" },
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
  });

  it("keeps the Codex plugin disabled when a bare model resolves to a configured provider", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        models: {
          providers: {
            "qwen-dashscope": {
              models: [{ id: "qwen-max" }],
            },
          },
        },
        agents: {
          defaults: {
            model: "qwen-max",
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
  });

  it("keeps the Codex plugin disabled when a bare model case-insensitively resolves to a configured provider", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        models: {
          providers: {
            "qwen-dashscope": {
              models: [{ id: "Qwen-Max" }],
            },
          },
        },
        agents: {
          defaults: {
            model: "qwen-max",
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
  });

  it("re-enables the Codex plugin when a provider-prefixed catalog model does not claim a bare model", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          entries: {
            codex: { enabled: false },
          },
        },
        models: {
          providers: {
            "qwen-dashscope": {
              models: [{ id: "qwen-dashscope/qwen-max" }],
            },
          },
        },
        agents: {
          defaults: {
            model: "qwen-max",
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
    ]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("keeps repaired OpenAI refs on Codex runtime even when the OpenAI provider is otherwise PI/API-key routed", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "pi" },
              models: [],
            },
          },
        },
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.5",
        config: result.cfg,
      }).runtime,
    ).toBe("codex");
  });

  it("preserves explicit listed-agent canonical refs when default legacy model repair adds Codex policy", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "pi" },
              models: [],
            },
          },
        },
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
          },
          list: [
            {
              id: "main",
              default: true,
            },
            {
              id: "worker",
              model: "openai/gpt-5.5",
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(result.cfg.agents?.list?.[1]?.model).toBe("openai/gpt-5.5");
    expect(result.cfg.agents?.list?.[1]?.models?.["openai/gpt-5.5"]?.agentRuntime).toEqual({
      id: "pi",
    });
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.5",
        config: result.cfg,
      }).runtime,
    ).toBe("codex");
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.5",
        agentId: "worker",
        config: result.cfg,
      }).runtime,
    ).toBe("pi");
  });

  it("preserves explicit model-scoped runtime pins when repairing legacy model map keys", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai-codex/gpt-5.5": {
                alias: "legacy-codex",
                agentRuntime: { id: "pi" },
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": {
        alias: "legacy-codex",
        agentRuntime: { id: "pi" },
      },
    });
    expect(result.changes.join("\n")).not.toContain(
      'Set agents.defaults.models.openai/gpt-5.5.agentRuntime.id to "codex"',
    );
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.5",
        config: result.cfg,
      }).runtime,
    ).toBe("pi");
  });

  it("overwrites non-concrete model-scoped runtime pins when preserving Codex route intent", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://proxy.example.test/v1",
              models: [],
            },
          },
        },
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "auto" } },
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.5",
        config: result.cfg,
      }).runtime,
    ).toBe("codex");
  });

  it("leaves path-scoped agent refs unchanged when repair would broaden another canonical agent slot", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "pi" },
              models: [],
            },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4",
            },
            heartbeat: {
              model: "openai-codex/gpt-5.4",
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.model).toEqual({ primary: "openai/gpt-5.4" });
    expect(result.cfg.agents?.defaults?.heartbeat?.model).toBe("openai-codex/gpt-5.4");
    expect(result.cfg.agents?.defaults?.models).toBeUndefined();
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.4",
        config: result.cfg,
      }).runtime,
    ).toBe("pi");
    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([
      [
        "- Legacy `openai-codex/*` model refs should be rewritten to `openai/*`.",
        "- agents.defaults.heartbeat.model: openai-codex/gpt-5.4 should become openai/gpt-5.4.",
        "- Run `openclaw doctor --fix`: it rewrites configured model refs and stale sessions to `openai/*`, moves Codex intent to provider/model runtime policy, and clears old whole-agent runtime pins.",
      ].join("\n"),
    ]);
  });

  it("repairs non-agent OpenAI Codex refs when canonical OpenAI already uses Codex runtime", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        channels: {
          modelByChannel: {
            telegram: {
              default: "openai-codex/gpt-5.5",
            },
          },
          discord: {
            voice: {
              model: "openai-codex/gpt-5.4-mini",
            },
          },
        },
        hooks: {
          mappings: [{ model: "openai-codex/gpt-5.4" }],
        },
        tools: {
          subagents: {
            model: {
              primary: "openai-codex/gpt-5.5",
              fallbacks: ["openai-codex/gpt-5.4-mini"],
            },
          },
        },
        messages: {
          tts: {
            summaryModel: "openai-codex/gpt-5.4",
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.channels?.modelByChannel?.telegram?.default).toBe("openai/gpt-5.5");
    expect(result.cfg.channels?.discord?.voice?.model).toBe("openai/gpt-5.4-mini");
    expect(result.cfg.hooks?.mappings?.[0]?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.tools?.subagents?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["openai/gpt-5.4-mini"],
    });
    expect(result.cfg.messages?.tts?.summaryModel).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.defaults?.models).toBeUndefined();
  });

  it("leaves path-scoped OpenAI Codex refs unchanged when repair would broaden default-agent runtime policy", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "pi" },
              models: [],
            },
          },
        },
        agents: {
          defaults: {
            model: "openai/gpt-5.4",
          },
        },
        hooks: {
          gmail: {
            model: "openai-codex/gpt-5.4",
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.defaults?.models).toBeUndefined();
    expect(result.cfg.hooks?.gmail?.model).toBe("openai-codex/gpt-5.4");
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.4",
        config: result.cfg,
      }).runtime,
    ).toBe("pi");
    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([
      [
        "- Legacy `openai-codex/*` model refs should be rewritten to `openai/*`.",
        "- hooks.gmail.model: openai-codex/gpt-5.4 should become openai/gpt-5.4.",
        "- Run `openclaw doctor --fix`: it rewrites configured model refs and stale sessions to `openai/*`, moves Codex intent to provider/model runtime policy, and clears old whole-agent runtime pins.",
      ].join("\n"),
    ]);
  });

  it("repairs persisted session route refs, clears stale runtime pins, and preserves auth pins", () => {
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
      now: 123,
    });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(store.main.updatedAt).toBe(123);
    expect(store.main.modelProvider).toBe("openai");
    expect(store.main.model).toBe("gpt-5.5");
    expect(store.main.providerOverride).toBe("openai");
    expect(store.main.modelOverride).toBe("gpt-5.4");
    expect(store.main.modelOverrideSource).toBe("auto");
    expect(store.main.authProfileOverride).toBe("openai-codex:default");
    expect(store.main.authProfileOverrideSource).toBe("auto");
    expect(store.main.authProfileOverrideCompactionCount).toBe(2);
    expect(store.main.agentHarnessId).toBeUndefined();
    expect(store.main.agentRuntimeOverride).toBeUndefined();
    expect(store.main.fallbackNoticeSelectedModel).toBeUndefined();
    expect(store.main.fallbackNoticeActiveModel).toBeUndefined();
    expect(store.main.fallbackNoticeReason).toBeUndefined();
    expect(store.other.updatedAt).toBe(2);
    expect(store.other.agentHarnessId).toBe("codex");
  });

  it("keeps Codex session auth pins while leaving runtime unpinned", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.5",
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "auto",
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
    });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(store.main.updatedAt).toBe(123);
    expect(store.main.providerOverride).toBe("openai");
    expect(store.main.modelOverride).toBe("gpt-5.5");
    expect(store.main.authProfileOverride).toBe("openai-codex:default");
    expect(store.main.authProfileOverrideSource).toBe("auto");
    expect(store.main.agentHarnessId).toBeUndefined();
    expect(store.main.agentRuntimeOverride).toBeUndefined();
  });

  it("preserves canonical OpenAI sessions that are explicitly pinned to PI", () => {
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
        authProfileOverride: "openai:work",
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
    });

    expect(result).toEqual({ changed: false, sessionKeys: [] });
    expect(store.main.updatedAt).toBe(1);
    expect(store.main.agentHarnessId).toBe("pi");
    expect(store.main.agentRuntimeOverride).toBe("pi");
    expect(store.main.authProfileOverride).toBe("openai:work");
  });

  it("repairs legacy routes without probing OAuth readiness", () => {
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
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(mocks.loadInstalledPluginIndex).not.toHaveBeenCalled();
    expect(mocks.isInstalledPluginEnabled).not.toHaveBeenCalled();
    expect(mocks.resolveAuthProfileOrder).not.toHaveBeenCalled();
    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.cfg.agents?.defaults?.agentRuntime).toBeUndefined();
  });

  it("still repairs routes when installed plugin metadata is unavailable", () => {
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
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.cfg.agents?.defaults?.agentRuntime).toBeUndefined();
  });
});
