// Codex route warning tests cover doctor diagnostics for Codex route configuration.

import { expectDefined } from "@openclaw/normalization-core";
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

import { legacyCodexProviderIdentityKey } from "./codex-route-model-ref.js";
import { repairCodexSessionStoreRoutes } from "./codex-route-session-repair.test-support.js";
import { collectCodexRouteWarnings, maybeRepairCodexRoutes } from "./codex-route-warnings.js";
import { collectBlockedLegacyOpenAICodexProviderPlan } from "./legacy-config-migrations.runtime.models.js";

const REPAIRABLE_CODEX_PLUGIN_CONFIG = { allow: ["openai"] };
const CODEX_PLUGIN_REPAIR_CHANGES = [
  "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
  "Added codex to plugins.allow because configured agent routes use Codex runtime.",
];

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
        "- Legacy `codex/*` and `openai-codex/*` model refs should be rewritten to `openai/*`.",
        "- agents.defaults.model: openai-codex/gpt-5.5 should become openai/gpt-5.5.",
        "- Run `openclaw doctor --fix`: it rewrites configured model refs and stale sessions to `openai/*`, moves Codex intent to provider/model runtime policy, and clears old whole-agent runtime pins.",
      ].join("\n"),
    ]);
  });

  it("surfaces enabled Codex Computer Use in doctor warnings", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        plugins: {
          entries: {
            codex: {
              enabled: true,
              config: {
                computerUse: {
                  enabled: true,
                  healthCheckEnabled: true,
                  healthCheckIntervalMinutes: 120,
                  autoRepair: true,
                },
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(warnings).toStrictEqual([
      [
        "- Codex Computer Use is enabled.",
        "- Doctor config review found Computer Use enabled; run `/codex computer-use status` to inspect installation, exposure, and the live `list_apps` probe.",
        "- Periodic Computer Use health checks are enabled with a 120-minute cadence.",
        "- Stale Computer Use MCP child repair is enabled and limited to SkyComputerUseClient children.",
      ].join("\n"),
    ]);
  });

  it("surfaces opt-in defaults for Codex Computer Use health and repair", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        plugins: {
          entries: {
            codex: {
              enabled: true,
              config: {
                computerUse: {
                  enabled: true,
                },
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(warnings).toStrictEqual([
      [
        "- Codex Computer Use is enabled.",
        "- Doctor config review found Computer Use enabled; run `/codex computer-use status` to inspect installation, exposure, and the live `list_apps` probe.",
        "- Periodic Computer Use health checks are disabled by default; set `computerUse.healthCheckEnabled` to true to enable them.",
        "- Stale Computer Use MCP child repair is disabled by default; set `computerUse.autoRepair` to true to repair before retrying a failed probe.",
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
        "- Legacy `codex/*` and `openai-codex/*` model refs should be rewritten to `openai/*`.",
        '- agents.defaults.model: openai-codex/gpt-5.5 should become openai/gpt-5.5; current runtime is "codex".',
        "- Run `openclaw doctor --fix`: it rewrites configured model refs and stale sessions to `openai/*`, moves Codex intent to provider/model runtime policy, and clears old whole-agent runtime pins.",
      ].join("\n"),
    ]);
  });

  it("ignores OPENCLAW_AGENT_RUNTIME when reporting legacy model refs", () => {
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
        "- Legacy `codex/*` and `openai-codex/*` model refs should be rewritten to `openai/*`.",
        "- agents.defaults.model: openai-codex/gpt-5.5 should become openai/gpt-5.5.",
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

  it("warns when legacy openai-codex model refs are in agents.list.*.models maps", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        agents: {
          list: [
            {
              id: "worker",
              model: "openai/gpt-5.5",
              models: {
                "openai-codex/gpt-5.4": { alias: "legacy" },
              },
            },
          ],
        },
      } as unknown as OpenClawConfig,
    });

    expect(warnings).toStrictEqual([
      [
        "- Legacy `codex/*` and `openai-codex/*` model refs should be rewritten to `openai/*`.",
        "- agents.list.worker.models.openai-codex/gpt-5.4: openai-codex/gpt-5.4 should become openai/gpt-5.4.",
        "- Run `openclaw doctor --fix`: it rewrites configured model refs and stale sessions to `openai/*`, moves Codex intent to provider/model runtime policy, and clears old whole-agent runtime pins.",
      ].join("\n"),
    ]);
  });

  it("repairs legacy openai-codex model refs found only in agents.list.*.models maps", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          list: [
            {
              id: "worker",
              model: "anthropic/claude-sonnet-4-6",
              models: {
                "openai-codex/gpt-5.4": { alias: "legacy" },
              },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      [
        "Repaired Codex model routes:",
        "- agents.list.worker.models.openai-codex/gpt-5.4: openai-codex/gpt-5.4 -> openai/gpt-5.4.",
      ].join("\n"),
      'Set agents.list.worker.models.openai/gpt-5.4.agentRuntime.id to "codex" so repaired OpenAI refs keep Codex auth routing.',
    ]);
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4"]?.alias).toBe("legacy");
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(result.cfg.agents?.list?.[0]?.models?.["openai-codex/gpt-5.4"]).toBeUndefined();
  });

  it("warns when Codex app-server command includes inline arguments", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        plugins: {
          entries: {
            codex: {
              enabled: true,
              config: {
                appServer: {
                  command:
                    "node C:\\Users\\me\\.openclaw\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
                },
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
    });

    expect(warnings).toStrictEqual([
      [
        "- Codex app-server command override includes inline arguments.",
        '- plugins.entries.codex.config.appServer.command: "node C:\\Users\\me\\.openclaw\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" starts with "node" and embeds "C:\\Users\\me\\.openclaw\\npm\\node_modules\\@openai\\codex\\bin\\codex.js". The command field must be only the executable path.',
        "- Remove the override to use managed Codex startup, or move script/options to plugins.entries.codex.config.appServer.args.",
      ].join("\n"),
    ]);
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
        "- Enable plugins.entries.codex and plugin loading, and remove `codex` from plugins.deny; or set the affected OpenAI models to an OpenClaw runtime policy.",
      ].join("\n"),
    ]);
  });

  it("requires the Codex plugin for automatic Platform-only gpt-5.6", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        plugins: { entries: { codex: { enabled: false } } },
        agents: { defaults: { model: { primary: "openai/gpt-5.6" } } },
      } as unknown as OpenClawConfig,
    });

    expect(warnings).toStrictEqual([
      [
        "- Codex runtime is selected, but the Codex plugin is disabled.",
        "- agents.defaults.model.primary: openai/gpt-5.6 resolves to openai/gpt-5.6 with Codex runtime while the Codex plugin is disabled by config.",
        "- Enable plugins.entries.codex and plugin loading, and remove `codex` from plugins.deny; or set the affected OpenAI models to an OpenClaw runtime policy.",
      ].join("\n"),
    ]);
  });

  it("requires the Codex plugin for automatic subscription-only Spark", () => {
    const warnings = collectCodexRouteWarnings({
      cfg: {
        plugins: { entries: { codex: { enabled: false } } },
        agents: {
          defaults: { model: { primary: "openai/gpt-5.3-codex-spark" } },
        },
      } as unknown as OpenClawConfig,
    });

    expect(warnings).toStrictEqual([
      [
        "- Codex runtime is selected, but the Codex plugin is disabled.",
        "- agents.defaults.model.primary: openai/gpt-5.3-codex-spark resolves to openai/gpt-5.3-codex-spark with Codex runtime while the Codex plugin is disabled by config.",
        "- Enable plugins.entries.codex and plugin loading, and remove `codex` from plugins.deny; or set the affected OpenAI models to an OpenClaw runtime policy.",
      ].join("\n"),
    ]);
  });

  it("uses the doctor environment snapshot for implicit OpenAI routing", () => {
    const cfg = {
      plugins: { entries: { codex: { enabled: false } } },
      agents: { defaults: { model: { primary: "openai/gpt-5.4-nano" } } },
    } as unknown as OpenClawConfig;

    expect(
      collectCodexRouteWarnings({
        cfg,
        env: { OPENAI_BASE_URL: "https://proxy.example.invalid/v1" },
      }),
    ).toStrictEqual([]);
    expect(
      collectCodexRouteWarnings({
        cfg,
        env: { OPENAI_BASE_URL: "https://chatgpt.com/backend-api/codex" },
      }),
    ).toStrictEqual([
      [
        "- Codex runtime is selected, but the Codex plugin is disabled.",
        "- agents.defaults.model.primary: openai/gpt-5.4-nano resolves to openai/gpt-5.4-nano with Codex runtime while the Codex plugin is disabled by config.",
        "- Enable plugins.entries.codex and plugin loading, and remove `codex` from plugins.deny; or set the affected OpenAI models to an OpenClaw runtime policy.",
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
              agentRuntime: { id: "openclaw" },
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
        "- Legacy `codex/*` and `openai-codex/*` model refs should be rewritten to `openai/*`.",
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
    expect((result.cfg.agents!.list![0] as Record<string, unknown>).compaction).toEqual({
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
                "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "openclaw" } },
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
              id: "native-worker",
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
        "- Legacy `codex/*` and `openai-codex/*` model refs should be rewritten to `openai/*`.",
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

  it("keeps global runtime pins while a blocked namespace remains", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        models: {
          providers: {
            openai: {
              models: [{ id: "gpt-5.6-sol", api: "openai-responses" }],
            },
            "openai-codex": {
              models: [{ id: "gpt-5.6-sol", api: "openai-chatgpt-responses" }],
            },
          },
        },
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.6-sol",
            agentRuntime: { id: "codex" },
          },
        },
        hooks: {
          mappings: [{ model: "codex/gpt-5.4-mini" }],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.model).toBe("openai-codex/gpt-5.6-sol");
    expect(result.cfg.agents?.defaults?.agentRuntime).toEqual({ id: "codex" });
    expect(result.cfg.hooks?.mappings?.[0]?.model).toBe("openai/gpt-5.4-mini");
    expect(result.changes.join("\n")).not.toContain("Removed agents.defaults.agentRuntime");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(
      "Legacy Codex provider routes require manual reconciliation",
    );
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
              agentRuntime: { id: "openclaw" },
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
    ).toBe("openclaw");
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
            mediaModels: {
              image: {
                primary: "openai-codex/gpt-image-2",
                fallbacks: ["openai-codex/gpt-image-1"],
              },
              video: { primary: "openai-codex/sora-2" },
            },
            models: {
              "openai-codex/gpt-5.5": { alias: "codex" },
            },
          },
          entries: {
            worker: {
              model: "openai-codex/gpt-5.4",
              agentRuntime: { id: "codex" },
            },
          },
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
        tts: {
          summaryModel: "openai-codex/gpt-5.4-mini",
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
        "- agents.defaults.mediaModels.image.primary: openai-codex/gpt-image-2 -> openai/gpt-image-2.",
        "- agents.defaults.mediaModels.image.fallbacks.0: openai-codex/gpt-image-1 -> openai/gpt-image-1.",
        "- agents.defaults.mediaModels.video.primary: openai-codex/sora-2 -> openai/sora-2.",
        "- agents.defaults.models.openai-codex/gpt-5.5: openai-codex/gpt-5.5 -> openai/gpt-5.5.",
        "- agents.entries.worker.model: openai-codex/gpt-5.4 -> openai/gpt-5.4.",
        "- channels.modelByChannel.telegram.default: openai-codex/gpt-5.4 -> openai/gpt-5.4.",
        "- hooks.mappings.0.model: openai-codex/gpt-5.4-mini -> openai/gpt-5.4-mini.",
        "- hooks.gmail.model: openai-codex/gpt-5.4 -> openai/gpt-5.4.",
        "- tts.summaryModel: openai-codex/gpt-5.4-mini -> openai/gpt-5.4-mini.",
      ].join("\n"),
      'Set agents.defaults.models.openai/gpt-5.5.agentRuntime.id to "codex" so repaired OpenAI refs keep Codex auth routing.',
      'Set agents.defaults.models.openai/gpt-5.4.agentRuntime.id to "codex" so repaired OpenAI refs keep Codex auth routing.',
      'Set agents.entries.worker.models.openai/gpt-5.4.agentRuntime.id to "codex" so repaired OpenAI refs keep Codex auth routing.',
      "Removed agents.defaults.agentRuntime; runtime is now provider/model scoped.",
      "Removed agents.entries.worker.agentRuntime; runtime is now provider/model scoped.",
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
    expect(result.cfg.agents?.defaults?.mediaModels?.image).toEqual({
      primary: "openai/gpt-image-2",
      fallbacks: ["openai/gpt-image-1"],
    });
    expect(result.cfg.agents?.defaults?.mediaModels?.video).toEqual({
      primary: "openai/sora-2",
    });
    expect(result.cfg.agents?.defaults?.agentRuntime).toBeUndefined();
    expect(result.cfg.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "codex", agentRuntime: { id: "codex" } },
      "openai/gpt-5.4": { agentRuntime: { id: "codex" } },
    });
    expect(result.cfg.agents?.entries?.worker?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.entries?.worker?.agentRuntime).toBeUndefined();
    expect(result.cfg.agents?.entries?.worker?.models).toEqual({
      "openai/gpt-5.4": { agentRuntime: { id: "codex" } },
    });
    expect(result.cfg.channels?.modelByChannel?.telegram?.default).toBe("openai/gpt-5.4");
    expect(result.cfg.hooks?.mappings?.[0]?.model).toBe("openai/gpt-5.4-mini");
    expect(result.cfg.hooks?.gmail?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.tts?.summaryModel).toBe("openai/gpt-5.4-mini");
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

  it("warns without overriding an explicit Codex plugin opt-out", () => {
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

    expect(result.warnings).toStrictEqual([
      [
        "- Codex runtime is selected, but the Codex plugin is disabled.",
        "- agents.defaults.model.primary: gpt-5.5 resolves to openai/gpt-5.5 with Codex runtime while the Codex plugin is disabled by config.",
        "- Enable plugins.entries.codex and plugin loading, and remove `codex` from plugins.deny; or set the affected OpenAI models to an OpenClaw runtime policy.",
      ].join("\n"),
    ]);
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
    expect(result.cfg.plugins?.allow).toEqual(["openai"]);
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.5",
        config: result.cfg,
      }).runtime,
    ).toBe("codex");
  });

  it("keeps Codex disabled when a bare heartbeat model inherits an Anthropic primary", () => {
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
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
  });

  it("re-enables the Codex plugin when a qualified default heartbeat uses Codex runtime", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: REPAIRABLE_CODEX_PLUGIN_CONFIG,
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-6",
            heartbeat: {
              model: "openai/gpt-5.5",
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual(CODEX_PLUGIN_REPAIR_CHANGES);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("re-enables the Codex plugin when a default subagent model uses Codex runtime", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: REPAIRABLE_CODEX_PLUGIN_CONFIG,
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-6",
            subagents: {
              model: {
                primary: "openai/gpt-5.5",
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual(CODEX_PLUGIN_REPAIR_CHANGES);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("re-enables the Codex plugin when an agent inherits a default heartbeat model that uses Codex runtime", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: REPAIRABLE_CODEX_PLUGIN_CONFIG,
        agents: {
          defaults: {
            heartbeat: {
              model: "openai/gpt-5.5",
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
    expect(result.changes).toStrictEqual(CODEX_PLUGIN_REPAIR_CHANGES);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("re-enables the Codex plugin when an agent model alias resolves to OpenAI", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: REPAIRABLE_CODEX_PLUGIN_CONFIG,
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
    expect(result.changes).toStrictEqual(CODEX_PLUGIN_REPAIR_CHANGES);
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
        plugins: REPAIRABLE_CODEX_PLUGIN_CONFIG,
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
    expect(result.changes).toStrictEqual(CODEX_PLUGIN_REPAIR_CHANGES);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("re-enables the Codex plugin when a listed-agent bare primary ignores per-agent provider metadata", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: REPAIRABLE_CODEX_PLUGIN_CONFIG,
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
    expect(result.changes).toStrictEqual(CODEX_PLUGIN_REPAIR_CHANGES);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("re-enables the Codex plugin when defaults inherit the implicit OpenAI model", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: REPAIRABLE_CODEX_PLUGIN_CONFIG,
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
    expect(result.changes).toStrictEqual(CODEX_PLUGIN_REPAIR_CHANGES);
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
        plugins: REPAIRABLE_CODEX_PLUGIN_CONFIG,
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
    expect(result.changes).toStrictEqual(CODEX_PLUGIN_REPAIR_CHANGES);
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
        plugins: REPAIRABLE_CODEX_PLUGIN_CONFIG,
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
    expect(result.changes).toStrictEqual(CODEX_PLUGIN_REPAIR_CHANGES);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("re-enables Codex for default model-map runtime policies inherited by listed agents", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: REPAIRABLE_CODEX_PLUGIN_CONFIG,
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
    expect(result.changes).toStrictEqual(CODEX_PLUGIN_REPAIR_CHANGES);
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

  it("keeps Codex disabled when a bare channel model inherits an Anthropic primary", () => {
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
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
  });

  it("re-enables the Codex plugin when a qualified channel model uses Codex runtime", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: REPAIRABLE_CODEX_PLUGIN_CONFIG,
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-6",
          },
        },
        channels: {
          modelByChannel: {
            telegram: {
              default: "openai/gpt-5.5",
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual(CODEX_PLUGIN_REPAIR_CHANGES);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("checks channel model runtime policy for every configured agent", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: REPAIRABLE_CODEX_PLUGIN_CONFIG,
        agents: {
          defaults: {
            model: "anthropic/claude-sonnet-4-6",
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
            },
          },
          list: [
            { id: "main" },
            {
              id: "worker",
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
              },
            },
          ],
        },
        channels: {
          modelByChannel: {
            telegram: {
              default: "openai/gpt-5.5",
            },
          },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual(CODEX_PLUGIN_REPAIR_CHANGES);
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
                  agentRuntime: { id: "openclaw" },
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

  it("keeps an empty allowlist unchanged when explicit opt-out blocks repair", () => {
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

    expect(result.warnings).toHaveLength(1);
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
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

  it("treats plugin allowlists as restrictive for the Codex harness", () => {
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

  it("adds Codex to plugin allowlists when re-enabling Codex", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          allow: ["openai"],
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

  it("keeps the Codex plugin disabled when OpenAI routes explicitly use the OpenClaw runtime", () => {
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
              agentRuntime: { id: "openclaw" },
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
    ).toBe("openclaw");
  });

  it("keeps the Codex plugin disabled when an auth-profiled OpenAI route explicitly uses the OpenClaw runtime", () => {
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
                agentRuntime: { id: "openclaw" },
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
        plugins: REPAIRABLE_CODEX_PLUGIN_CONFIG,
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
    expect(result.changes).toStrictEqual(CODEX_PLUGIN_REPAIR_CHANGES);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
  });

  it("repairs live multi-agent Codex upgrade configs and enables Codex through allowlists", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        plugins: {
          allow: ["brave", "discord", "whatsapp"],
          entries: {
            brave: { enabled: true },
            discord: { enabled: true },
            whatsapp: { enabled: true },
          },
        },
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.5",
          },
          list: [
            { id: "main", model: "openai-codex/gpt-5.5" },
            { id: "meimei", model: "openai-codex/gpt-5.5" },
            { id: "youyou-cli", model: "openai-codex/gpt-5.5" },
          ],
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.cfg.agents?.list?.map((agent) => agent.model)).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.5",
      "openai/gpt-5.5",
    ]);
    expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toEqual({
      id: "codex",
    });
    for (const agent of result.cfg.agents?.list ?? []) {
      expect(agent.models?.["openai/gpt-5.5"]?.agentRuntime).toEqual({ id: "codex" });
    }
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.cfg.plugins?.allow).toEqual(["brave", "discord", "whatsapp", "codex"]);
    expect(result.changes.join("\n")).toContain(
      "agents.defaults.model: openai-codex/gpt-5.5 -> openai/gpt-5.5.",
    );
    expect(result.changes.join("\n")).toContain(
      "agents.list.main.model: openai-codex/gpt-5.5 -> openai/gpt-5.5.",
    );
  });

  it("keeps repaired OpenAI refs on Codex runtime even when the OpenAI provider is otherwise OpenClaw/API-key routed", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "openclaw" },
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
              agentRuntime: { id: "openclaw" },
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
      id: "openclaw",
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
    ).toBe("openclaw");
  });

  it("preserves inherited default legacy runtime pins for listed-agent legacy refs", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/gpt-5.4": {
              agentRuntime: { id: "openclaw" },
            },
          },
        },
        list: [
          {
            id: "worker",
            model: "openai-codex/gpt-5.4",
          },
        ],
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveAgentHarnessPolicy({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        agentId: "worker",
        config: cfg,
      }).runtime,
    ).toBe("openclaw");

    const result = maybeRepairCodexRoutes({
      cfg,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.4"]?.agentRuntime).toEqual({
      id: "openclaw",
    });
    expect(result.cfg.agents?.defaults?.models?.["openai-codex/gpt-5.4"]).toBeUndefined();
    expect(result.cfg.agents?.list?.[0]?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4"]).toBeUndefined();
    expect(result.changes.join("\n")).not.toContain(
      'Set agents.list.worker.models.openai/gpt-5.4.agentRuntime.id to "codex"',
    );
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.4",
        agentId: "worker",
        config: result.cfg,
      }).runtime,
    ).toBe("openclaw");
  });

  it("preserves listed-agent legacy model-map runtime pins while repairing listed-agent refs", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "worker",
            model: "openai-codex/gpt-5.4",
            models: {
              "openai-codex/gpt-5.4": {
                agentRuntime: { id: "openclaw" },
              },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveAgentHarnessPolicy({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        agentId: "worker",
        config: cfg,
      }).runtime,
    ).toBe("openclaw");

    const result = maybeRepairCodexRoutes({
      cfg,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.list?.[0]?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4"]?.agentRuntime).toEqual({
      id: "openclaw",
    });
    expect(result.cfg.agents?.list?.[0]?.models?.["openai-codex/gpt-5.4"]).toBeUndefined();
    expect(result.changes.join("\n")).not.toContain(
      'Set agents.list.worker.models.openai/gpt-5.4.agentRuntime.id to "codex"',
    );
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.4",
        agentId: "worker",
        config: result.cfg,
      }).runtime,
    ).toBe("openclaw");
  });

  it("preserves inherited default wildcard runtime pins for listed-agent legacy refs", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/*": {
              agentRuntime: { id: "openclaw" },
            },
          },
        },
        list: [
          {
            id: "worker",
            model: "openai-codex/gpt-5.4",
          },
        ],
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveAgentHarnessPolicy({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        agentId: "worker",
        config: cfg,
      }).runtime,
    ).toBe("openclaw");

    const result = maybeRepairCodexRoutes({
      cfg,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.models?.["openai/*"]?.agentRuntime).toEqual({
      id: "openclaw",
    });
    expect(result.cfg.agents?.defaults?.models?.["openai-codex/*"]).toBeUndefined();
    expect(result.cfg.agents?.list?.[0]?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4"]).toBeUndefined();
    expect(result.changes.join("\n")).not.toContain(
      'Set agents.list.worker.models.openai/gpt-5.4.agentRuntime.id to "codex"',
    );
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.4",
        agentId: "worker",
        config: result.cfg,
      }).runtime,
    ).toBe("openclaw");
  });

  it("preserves provider-level legacy runtime pins while repairing default legacy refs", () => {
    const cfg = {
      models: {
        providers: {
          "openai-codex": {
            agentRuntime: { id: "openclaw" },
          },
        },
      },
      agents: {
        defaults: {
          model: "openai-codex/gpt-5.4",
        },
      },
      plugins: {
        entries: { codex: { enabled: false } },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveAgentHarnessPolicy({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        config: cfg,
      }).runtime,
    ).toBe("openclaw");

    const result = maybeRepairCodexRoutes({
      cfg,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.4"]?.agentRuntime).toEqual({
      id: "openclaw",
    });
    expect(result.changes.join("\n")).toContain(
      'Set agents.defaults.models.openai/gpt-5.4.agentRuntime.id to "openclaw"',
    );
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.4",
        config: result.cfg,
      }).runtime,
    ).toBe("openclaw");
  });

  it("preserves legacy provider catalog runtime pins while repairing default legacy refs", () => {
    const cfg = {
      models: {
        providers: {
          "openai-codex": {
            models: [
              {
                id: "gpt-5.4",
                agentRuntime: { id: "openclaw" },
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: "openai-codex/gpt-5.4",
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveAgentHarnessPolicy({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        config: cfg,
      }).runtime,
    ).toBe("openclaw");

    const result = maybeRepairCodexRoutes({
      cfg,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.4"]?.agentRuntime).toEqual({
      id: "openclaw",
    });
    expect(result.changes.join("\n")).toContain(
      'Set agents.defaults.models.openai/gpt-5.4.agentRuntime.id to "openclaw"',
    );
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.4",
        config: result.cfg,
      }).runtime,
    ).toBe("openclaw");
  });

  it("preserves legacy provider catalog runtime pins while repairing listed-agent legacy refs", () => {
    const cfg = {
      models: {
        providers: {
          "openai-codex": {
            models: [
              {
                id: "gpt-5.4",
                agentRuntime: { id: "openclaw" },
              },
            ],
          },
        },
      },
      agents: {
        list: [
          {
            id: "worker",
            model: "openai-codex/gpt-5.4",
          },
        ],
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveAgentHarnessPolicy({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        agentId: "worker",
        config: cfg,
      }).runtime,
    ).toBe("openclaw");

    const result = maybeRepairCodexRoutes({
      cfg,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.list?.[0]?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4"]?.agentRuntime).toEqual({
      id: "openclaw",
    });
    expect(result.changes.join("\n")).toContain(
      'Set agents.list.worker.models.openai/gpt-5.4.agentRuntime.id to "openclaw"',
    );
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.4",
        agentId: "worker",
        config: result.cfg,
      }).runtime,
    ).toBe("openclaw");
  });

  it("shields listed canonical refs when provider-level legacy default pins migrate", () => {
    const cfg = {
      models: {
        providers: {
          "openai-codex": {
            agentRuntime: { id: "openclaw" },
          },
        },
      },
      agents: {
        defaults: {
          model: "openai-codex/gpt-5.4",
        },
        list: [
          {
            id: "main",
            default: true,
          },
          {
            id: "regular",
            model: "openai/gpt-5.4",
          },
        ],
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveAgentHarnessPolicy({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        agentId: "main",
        config: cfg,
      }).runtime,
    ).toBe("openclaw");
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.4",
        agentId: "regular",
        config: cfg,
      }).runtime,
    ).toBe("codex");

    const result = maybeRepairCodexRoutes({
      cfg,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.4"]?.agentRuntime).toEqual({
      id: "openclaw",
    });
    expect(result.cfg.agents?.list?.[0]?.model).toBeUndefined();
    expect(result.cfg.agents?.list?.[1]?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.list?.[1]?.models?.["openai/gpt-5.4"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(result.changes.join("\n")).toContain(
      'Set agents.list.regular.models.openai/gpt-5.4.agentRuntime.id to "codex"',
    );
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.4",
        agentId: "main",
        config: result.cfg,
      }).runtime,
    ).toBe("openclaw");
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.4",
        agentId: "regular",
        config: result.cfg,
      }).runtime,
    ).toBe("codex");
  });

  it("preserves provider-level legacy runtime pins while repairing listed-agent legacy refs", () => {
    const cfg = {
      models: {
        providers: {
          "openai-codex": {
            agentRuntime: { id: "openclaw" },
          },
        },
      },
      agents: {
        list: [
          {
            id: "worker",
            model: "openai-codex/gpt-5.4",
          },
        ],
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveAgentHarnessPolicy({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        agentId: "worker",
        config: cfg,
      }).runtime,
    ).toBe("openclaw");

    const result = maybeRepairCodexRoutes({
      cfg,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.list?.[0]?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4"]?.agentRuntime).toEqual({
      id: "openclaw",
    });
    expect(result.changes.join("\n")).toContain(
      'Set agents.list.worker.models.openai/gpt-5.4.agentRuntime.id to "openclaw"',
    );
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.4",
        agentId: "worker",
        config: result.cfg,
      }).runtime,
    ).toBe("openclaw");
  });

  it("does not apply pre-existing canonical default runtime pins to listed-agent legacy refs", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/*": {
              agentRuntime: { id: "openclaw" },
            },
          },
        },
        list: [
          {
            id: "worker",
            model: "openai-codex/gpt-5.4",
          },
        ],
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveAgentHarnessPolicy({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        agentId: "worker",
        config: cfg,
      }).runtime,
    ).toBe("auto");

    const result = maybeRepairCodexRoutes({
      cfg,
      shouldRepair: true,
    });

    expect(result.cfg.agents?.defaults?.models?.["openai/*"]?.agentRuntime).toEqual({
      id: "openclaw",
    });
    expect(result.cfg.agents?.list?.[0]?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(result.changes.join("\n")).toContain(
      'Set agents.list.worker.models.openai/gpt-5.4.agentRuntime.id to "codex"',
    );
    expect(
      resolveAgentHarnessPolicy({
        provider: "openai",
        modelId: "gpt-5.4",
        agentId: "worker",
        config: result.cfg,
      }).runtime,
    ).toBe("codex");
  });

  it("preserves explicit model-scoped runtime pins when repairing legacy model map keys", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai-codex/gpt-5.5": {
                alias: "legacy-codex",
                agentRuntime: { id: "openclaw" },
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
        agentRuntime: { id: "openclaw" },
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
    ).toBe("openclaw");
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
              agentRuntime: { id: "openclaw" },
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
    ).toBe("openclaw");
    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([
      [
        "- Legacy `codex/*` and `openai-codex/*` model refs should be rewritten to `openai/*`.",
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
        tts: {
          summaryModel: "openai-codex/gpt-5.4",
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.channels?.modelByChannel?.telegram?.default).toBe("openai/gpt-5.5");
    expect(result.cfg.channels?.discord?.voice?.model).toBe("openai/gpt-5.4-mini");
    expect(result.cfg.hooks?.mappings?.[0]?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.tts?.summaryModel).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.defaults?.models).toBeUndefined();
  });

  it("leaves path-scoped OpenAI Codex refs unchanged when repair would broaden default-agent runtime policy", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              agentRuntime: { id: "openclaw" },
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
    ).toBe("openclaw");
    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([
      [
        "- Legacy `codex/*` and `openai-codex/*` model refs should be rewritten to `openai/*`.",
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
    expect(expectDefined(store.main, "store.main test invariant").updatedAt).toBe(123);
    expect(expectDefined(store.main, "store.main test invariant").modelProvider).toBe("openai");
    expect(expectDefined(store.main, "store.main test invariant").model).toBe("gpt-5.5");
    expect(expectDefined(store.main, "store.main test invariant").providerOverride).toBe("openai");
    expect(expectDefined(store.main, "store.main test invariant").modelOverride).toBe("gpt-5.4");
    expect(expectDefined(store.main, "store.main test invariant").modelOverrideSource).toBe("auto");
    expect(expectDefined(store.main, "store.main test invariant").authProfileOverride).toBe(
      "openai-codex:default",
    );
    expect(expectDefined(store.main, "store.main test invariant").authProfileOverrideSource).toBe(
      "auto",
    );
    expect(
      expectDefined(store.main, "store.main test invariant").authProfileOverrideCompactionCount,
    ).toBe(2);
    expect(expectDefined(store.main, "store.main test invariant").agentHarnessId).toBeUndefined();
    expect(expectDefined(store.main, "store.main test invariant").agentRuntimeOverride).toBe(
      "codex",
    );
    expect(
      expectDefined(store.main, "store.main test invariant").fallbackNoticeSelectedModel,
    ).toBeUndefined();
    expect(
      expectDefined(store.main, "store.main test invariant").fallbackNoticeActiveModel,
    ).toBeUndefined();
    expect(
      expectDefined(store.main, "store.main test invariant").fallbackNoticeReason,
    ).toBeUndefined();
    expect(expectDefined(store.other, "store.other test invariant").updatedAt).toBe(2);
    expect(expectDefined(store.other, "store.other test invariant").agentHarnessId).toBe("codex");
  });

  it("repairs shipped codex namespace session route refs", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "codex",
        model: "codex/gpt-5.6-sol",
        providerOverride: "codex",
        modelOverride: "codex/gpt-5.6-sol",
        authProfileOverride: "codex:default",
        authProfileOverrideSource: "auto",
        fallbackNoticeSelectedModel: "codex/gpt-5.6-sol",
        agentRuntimeOverride: "codex",
      },
    };

    const result = repairCodexSessionStoreRoutes({ store, now: 123 });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(store.main).toMatchObject({
      modelProvider: "openai",
      model: "gpt-5.6-sol",
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
      authProfileOverride: "codex:default",
      updatedAt: 123,
    });
    expect(store.main?.fallbackNoticeSelectedModel).toBeUndefined();
    expect(store.main?.agentRuntimeOverride).toBe("codex");
  });

  it("treats slash model ids as raw for custom providers while migrating legacy pairs", () => {
    const store: Record<string, SessionEntry> = {
      custom: {
        sessionId: "s-custom",
        updatedAt: 1,
        modelProvider: "custom",
        model: "codex/foo",
        providerOverride: "custom",
        modelOverride: "openai-codex/bar",
        agentRuntimeOverride: "openclaw",
      },
      legacy: {
        sessionId: "s-legacy",
        updatedAt: 2,
        modelProvider: "codex",
        model: "codex/foo",
      },
    };

    const result = repairCodexSessionStoreRoutes({ store, now: 123 });

    expect(result).toEqual({ changed: true, sessionKeys: ["legacy"] });
    expect(store.custom).toMatchObject({
      modelProvider: "custom",
      model: "codex/foo",
      providerOverride: "custom",
      modelOverride: "openai-codex/bar",
      agentRuntimeOverride: "openclaw",
      updatedAt: 1,
    });
    expect(store.legacy).toMatchObject({
      modelProvider: "openai",
      model: "foo",
      agentRuntimeOverride: "codex",
      updatedAt: 123,
    });
  });

  it("keeps the whole provider-conflicted session namespace legacy", () => {
    const store: Record<string, SessionEntry> = {
      blocked: {
        sessionId: "s-blocked",
        updatedAt: 1,
        modelProvider: "codex",
        model: "gpt-5.6-sol",
        providerOverride: "codex",
        modelOverride: "codex/gpt-5.6-sol",
      },
      migrate: {
        sessionId: "s-migrate",
        updatedAt: 2,
        modelProvider: "codex",
        model: "gpt-5.3-mini",
      },
      providerOnly: {
        sessionId: "s-provider-only",
        updatedAt: 3,
        modelProvider: "codex",
      },
    };
    const blockedNamespace = expectDefined(
      legacyCodexProviderIdentityKey("codex"),
      "blocked session namespace test invariant",
    );

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
      blockedModelIdentities: new Set([blockedNamespace]),
    });

    expect(result).toEqual({ changed: false, sessionKeys: [] });
    expect(store.blocked).toMatchObject({
      modelProvider: "codex",
      model: "gpt-5.6-sol",
      providerOverride: "codex",
      modelOverride: "codex/gpt-5.6-sol",
      updatedAt: 1,
    });
    expect(store.migrate).toMatchObject({
      modelProvider: "codex",
      model: "gpt-5.3-mini",
      updatedAt: 2,
    });
    expect(store.providerOnly).toMatchObject({
      modelProvider: "codex",
      updatedAt: 3,
    });
  });

  it("clears mixed legacy and canonical fallback notices atomically", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        fallbackNoticeSelectedModel: "codex/gpt-5.6-sol",
        fallbackNoticeActiveModel: "openai/gpt-5.6-sol",
        fallbackNoticeReason: "rate-limit",
      },
    };

    const result = repairCodexSessionStoreRoutes({ store, now: 123 });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(store.main?.fallbackNoticeSelectedModel).toBeUndefined();
    expect(store.main?.fallbackNoticeActiveModel).toBeUndefined();
    expect(store.main?.fallbackNoticeReason).toBeUndefined();
  });

  it("retains a fallback notice atomically when one legacy endpoint is blocked", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        fallbackNoticeSelectedModel: "codex/gpt-5.6-sol",
        fallbackNoticeActiveModel: "openai/gpt-5.6-sol",
        fallbackNoticeReason: "rate-limit",
      },
    };
    // Build the blocked identity through the production plan so the test
    // exercises the same composition doctor uses.
    const blockedIdentity = expectDefined(
      collectBlockedLegacyOpenAICodexProviderPlan({
        models: {
          providers: {
            codex: { models: [{ id: "gpt-5.6-sol", api: "openai-responses" }] },
            openai: { models: [{ id: "gpt-5.6-sol", api: "openai-chatgpt-responses" }] },
          },
        },
      }).blockedModelIdentities[0],
      "blocked fallback notice model identity test invariant",
    );

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
      blockedModelIdentities: new Set([blockedIdentity]),
    });

    expect(result).toEqual({ changed: false, sessionKeys: [] });
    expect(store.main).toMatchObject({
      updatedAt: 1,
      fallbackNoticeSelectedModel: "codex/gpt-5.6-sol",
      fallbackNoticeActiveModel: "openai/gpt-5.6-sol",
      fallbackNoticeReason: "rate-limit",
    });
  });

  it("leaves session runtime intent untouched for fallback-notice-only cleanup", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        fallbackNoticeSelectedModel: "codex/gpt-5.6-sol",
        fallbackNoticeReason: "rate-limit",
      },
    };

    const result = repairCodexSessionStoreRoutes({ store, now: 123 });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(store.main?.fallbackNoticeSelectedModel).toBeUndefined();
    expect(store.main?.fallbackNoticeReason).toBeUndefined();
    expect(store.main?.agentRuntimeOverride).toBeUndefined();
    expect(store.main?.agentHarnessId).toBeUndefined();
  });

  it("skips valid locked agent-harness rows while repairing ordinary legacy routes", () => {
    const supervisedKey = "agent:main:harness:codex:supervision:abc123";
    const ordinaryLockedKey = "agent:main:ordinary-locked";
    const lockedEntry: SessionEntry = {
      sessionId: "s-supervised",
      updatedAt: 1,
      modelSelectionLocked: true,
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
      modelProvider: "openai-codex",
      model: "gpt-5.5",
      providerOverride: "openai-codex",
      modelOverride: "openai-codex/gpt-5.4",
      fallbackNoticeSelectedModel: "openai-codex/gpt-5.5",
    };
    const store: Record<string, SessionEntry> = {
      [supervisedKey]: lockedEntry,
      [ordinaryLockedKey]: { ...lockedEntry, sessionId: "s-ordinary-locked" },
      ordinary: {
        sessionId: "s-ordinary",
        updatedAt: 2,
        modelProvider: "openai-codex",
        model: "gpt-5.5",
        agentHarnessId: "codex",
      },
    };
    const supervised = structuredClone(store[supervisedKey]);
    const ordinaryLocked = structuredClone(store[ordinaryLockedKey]);

    const result = repairCodexSessionStoreRoutes({ store, now: 123 });

    expect(result).toEqual({ changed: true, sessionKeys: ["ordinary"] });
    expect(store[supervisedKey]).toEqual(supervised);
    expect(store[ordinaryLockedKey]).toEqual(ordinaryLocked);
    expect(store.ordinary).toMatchObject({
      updatedAt: 123,
      modelProvider: "openai",
      model: "gpt-5.5",
    });
    expect(
      expectDefined(store.ordinary, "store.ordinary test invariant").agentHarnessId,
    ).toBeUndefined();
  });

  it("preserves explicit OpenClaw runtime pins while repairing legacy session routes", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai-codex",
        model: "gpt-5.5",
        providerOverride: "openai-codex",
        modelOverride: "openai-codex/gpt-5.4",
        agentHarnessId: "pi",
        agentRuntimeOverride: "pi",
        authProfileOverride: "openai-codex:default",
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
    });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(expectDefined(store.main, "store.main test invariant").modelProvider).toBe("openai");
    expect(expectDefined(store.main, "store.main test invariant").model).toBe("gpt-5.5");
    expect(expectDefined(store.main, "store.main test invariant").providerOverride).toBe("openai");
    expect(expectDefined(store.main, "store.main test invariant").modelOverride).toBe("gpt-5.4");
    expect(expectDefined(store.main, "store.main test invariant").agentHarnessId).toBe("pi");
    expect(expectDefined(store.main, "store.main test invariant").agentRuntimeOverride).toBe("pi");
    expect(expectDefined(store.main, "store.main test invariant").authProfileOverride).toBe(
      "openai-codex:default",
    );
  });

  it("preserves Codex runtime intent alongside explicit OpenClaw harness pins", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai-codex",
        model: "gpt-5.5",
        agentHarnessId: "pi",
        agentRuntimeOverride: "codex",
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
    });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(expectDefined(store.main, "store.main test invariant").modelProvider).toBe("openai");
    expect(expectDefined(store.main, "store.main test invariant").model).toBe("gpt-5.5");
    expect(expectDefined(store.main, "store.main test invariant").agentHarnessId).toBe("pi");
    expect(expectDefined(store.main, "store.main test invariant").agentRuntimeOverride).toBe(
      "codex",
    );
  });

  it("installs Codex runtime intent for a session-only legacy route", () => {
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
    expect(expectDefined(store.main, "store.main test invariant").updatedAt).toBe(123);
    expect(expectDefined(store.main, "store.main test invariant").providerOverride).toBe("openai");
    expect(expectDefined(store.main, "store.main test invariant").modelOverride).toBe("gpt-5.5");
    expect(expectDefined(store.main, "store.main test invariant").authProfileOverride).toBe(
      "openai-codex:default",
    );
    expect(expectDefined(store.main, "store.main test invariant").authProfileOverrideSource).toBe(
      "auto",
    );
    expect(expectDefined(store.main, "store.main test invariant").agentHarnessId).toBeUndefined();
    expect(expectDefined(store.main, "store.main test invariant").agentRuntimeOverride).toBe(
      "codex",
    );
  });

  it("repairs Telegram direct session routes while preserving canonical OpenAI auth pins", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:telegram:default:direct:5550100999": {
        sessionId: "s-telegram",
        updatedAt: 1,
        modelProvider: "openai-codex",
        model: "gpt-5.5",
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "auto",
        agentHarnessId: "codex",
        agentRuntimeOverride: "codex",
        authProfileOverride: "openai:work",
        authProfileOverrideSource: "auto",
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
    });
    const entry = expectDefined(
      store["agent:main:telegram:default:direct:5550100999"],
      'store["agent:main:telegram:default:direct:5550100999"] test invariant',
    );

    expect(result).toEqual({
      changed: true,
      sessionKeys: ["agent:main:telegram:default:direct:5550100999"],
    });
    expect(entry.updatedAt).toBe(123);
    expect(entry.modelProvider).toBe("openai");
    expect(entry.model).toBe("gpt-5.5");
    expect(entry.providerOverride).toBe("openai");
    expect(entry.modelOverride).toBe("gpt-5.5");
    expect(entry.modelOverrideSource).toBe("auto");
    expect(entry.authProfileOverride).toBe("openai:work");
    expect(entry.authProfileOverrideSource).toBe("auto");
    expect(entry.agentHarnessId).toBeUndefined();
    expect(entry.agentRuntimeOverride).toBe("codex");
  });

  it("repairs providerless auto Codex session overrides", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "ollama",
        model: "gpt-5.5",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "auto",
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "auto",
        contextTokens: 64_000,
        contextBudgetStatus: {
          schemaVersion: 1,
          source: "pre-prompt-estimate",
          updatedAt: 1,
          provider: "ollama",
          model: "gpt-5.5",
          route: "fits",
          shouldCompact: false,
          estimatedPromptTokens: 1_000,
          contextTokenBudget: 64_000,
          promptBudgetBeforeReserve: 62_000,
          reserveTokens: 2_000,
          effectiveReserveTokens: 2_000,
          remainingPromptBudgetTokens: 61_000,
          overflowTokens: 0,
          toolResultReducibleChars: 0,
          messageCount: 1,
          unwindowedMessageCount: 1,
        },
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
    });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(expectDefined(store.main, "store.main test invariant").updatedAt).toBe(123);
    expect(expectDefined(store.main, "store.main test invariant").providerOverride).toBe("openai");
    expect(expectDefined(store.main, "store.main test invariant").modelOverride).toBe("gpt-5.5");
    expect(expectDefined(store.main, "store.main test invariant").modelOverrideSource).toBe("auto");
    expect(expectDefined(store.main, "store.main test invariant").authProfileOverride).toBe(
      "openai-codex:default",
    );
    expect(expectDefined(store.main, "store.main test invariant").authProfileOverrideSource).toBe(
      "auto",
    );
    expect(expectDefined(store.main, "store.main test invariant").modelProvider).toBeUndefined();
    expect(expectDefined(store.main, "store.main test invariant").model).toBeUndefined();
    expect(expectDefined(store.main, "store.main test invariant").contextTokens).toBeUndefined();
    expect(
      expectDefined(store.main, "store.main test invariant").contextBudgetStatus,
    ).toBeUndefined();
  });

  it("preserves legacy providerless overrides with Codex auth pins", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelOverride: "gpt-5.5",
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "auto",
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
    });

    expect(result).toEqual({ changed: false, sessionKeys: [] });
    expect(expectDefined(store.main, "store.main test invariant").updatedAt).toBe(1);
    expect(expectDefined(store.main, "store.main test invariant").providerOverride).toBeUndefined();
    expect(expectDefined(store.main, "store.main test invariant").modelOverride).toBe("gpt-5.5");
  });

  it("preserves canonical OpenAI sessions that are explicitly pinned to OpenClaw", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5.5",
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        agentHarnessId: "openclaw",
        agentRuntimeOverride: "openclaw",
        authProfileOverride: "openai:work",
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
    });

    expect(result).toEqual({ changed: false, sessionKeys: [] });
    expect(expectDefined(store.main, "store.main test invariant").updatedAt).toBe(1);
    expect(expectDefined(store.main, "store.main test invariant").agentHarnessId).toBe("openclaw");
    expect(expectDefined(store.main, "store.main test invariant").agentRuntimeOverride).toBe(
      "openclaw",
    );
    expect(expectDefined(store.main, "store.main test invariant").authProfileOverride).toBe(
      "openai:work",
    );
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

  it("preserves an explicit non-default agentRuntime pin on the legacy model entry during migration (#84038)", () => {
    const result = maybeRepairCodexRoutes({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai-codex/gpt-5.4" },
            models: {
              "openai-codex/gpt-5.4": {
                agentRuntime: { id: "openclaw" },
              },
            },
          },
        },
        auth: {
          order: {
            "openai-codex": ["openai-codex:user@example.com"],
          },
        },
        plugins: {
          entries: { codex: { enabled: false } },
        },
      } as unknown as OpenClawConfig,
      shouldRepair: true,
    });

    const migrated = result.cfg.agents?.defaults?.models?.["openai/gpt-5.4"] as
      | { agentRuntime?: { id?: string } }
      | undefined;
    expect(migrated).toBeDefined();
    expect(migrated?.agentRuntime).toEqual({ id: "openclaw" });
    expect(result.cfg.agents?.defaults?.models?.["openai-codex/gpt-5.4"]).toBeUndefined();
  });

  for (const canonicalRuntimeId of ["auto", "default"] as const) {
    it(`preserves an explicit legacy runtime pin over canonical ${canonicalRuntimeId} during model-map migration`, () => {
      const result = maybeRepairCodexRoutes({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openai-codex/gpt-5.4" },
              models: {
                "openai-codex/gpt-5.4": {
                  agentRuntime: { id: "openclaw" },
                },
                "openai/gpt-5.4": {
                  alias: "canonical-codex",
                  agentRuntime: { id: canonicalRuntimeId },
                },
              },
            },
          },
          plugins: {
            entries: { codex: { enabled: false } },
          },
        } as unknown as OpenClawConfig,
        shouldRepair: true,
      });

      expect(result.cfg.agents?.defaults?.model).toEqual({ primary: "openai/gpt-5.4" });
      expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.4"]).toEqual({
        alias: "canonical-codex",
        agentRuntime: { id: "openclaw" },
      });
      expect(result.cfg.agents?.defaults?.models?.["openai-codex/gpt-5.4"]).toBeUndefined();
      expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
      expect(
        resolveAgentHarnessPolicy({
          provider: "openai",
          modelId: "gpt-5.4",
          config: result.cfg,
        }).runtime,
      ).toBe("openclaw");
    });
  }
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
