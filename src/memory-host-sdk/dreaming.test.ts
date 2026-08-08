// Memory host dreaming tests cover dreaming artifact persistence and lookup.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  formatMemoryDreamingDay,
  isSameMemoryDreamingDay,
  resolveMemoryDreamingPluginConfig,
  resolveMemoryDreamingPluginId,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingSelection,
  resolveMemoryDreamingWorkspaces,
} from "./dreaming.js";

describe("memory dreaming host helpers", () => {
  it("normalizes string settings from the dreaming config", () => {
    const resolved = resolveMemoryDreamingConfig({
      pluginConfig: {
        dreaming: {
          enabled: true,
          frequency: "0 */4 * * *",
          timezone: "Europe/London",
          model: " anthropic/claude-sonnet-4-6 ",
          storage: {
            mode: "both",
            separateReports: true,
          },
          phases: {
            deep: {
              limit: "5",
              minScore: "0.9",
              minRecallCount: "4",
              minUniqueQueries: "2",
              recencyHalfLifeDays: "21",
              maxAgeDays: "30",
              maxPriorEntryLossFraction: 0.1,
            },
          },
        },
      },
    });

    expect(resolved.enabled).toBe(true);
    expect(resolved.frequency).toBe("0 */4 * * *");
    expect(resolved.timezone).toBe("Europe/London");
    expect(resolved.execution.defaults.model).toBe("anthropic/claude-sonnet-4-6");
    expect(resolved.phases.light.execution.model).toBe("anthropic/claude-sonnet-4-6");
    expect(resolved.phases.deep.execution.model).toBe("anthropic/claude-sonnet-4-6");
    expect(resolved.phases.rem.execution.model).toBe("anthropic/claude-sonnet-4-6");
    expect(resolved.storage).toEqual({
      mode: "both",
      separateReports: true,
    });
    expect(resolved.phases.deep.cron).toBe("0 */4 * * *");
    expect(resolved.phases.deep.limit).toBe(5);
    expect(resolved.phases.deep.minScore).toBe(0.9);
    expect(resolved.phases.deep.minRecallCount).toBe(4);
    expect(resolved.phases.deep.minUniqueQueries).toBe(2);
    expect(resolved.phases.deep.recencyHalfLifeDays).toBe(21);
    expect(resolved.phases.deep.maxAgeDays).toBe(30);
    expect(resolved.phases.deep.maxPriorEntryLossFraction).toBe(0.1);
  });

  it("rejects non-strict integer tokens instead of flooring/coercing them", () => {
    const resolved = resolveMemoryDreamingConfig({
      pluginConfig: {
        dreaming: {
          phases: {
            light: {
              lookbackDays: "0x10",
              limit: "2e2",
            },
            deep: {
              limit: "4.9",
              minRecallCount: " 4 ",
              minUniqueQueries: 2.2,
              maxAgeDays: "30.5",
              maxPromotedSnippetTokens: "160",
            },
          },
          execution: {
            defaults: {
              maxOutputTokens: "64.5",
              timeoutMs: "2e3",
            },
          },
        },
      },
    });

    expect(resolved.phases.light.lookbackDays).toBe(2);
    expect(resolved.phases.light.limit).toBe(100);
    expect(resolved.phases.deep.limit).toBe(10);
    expect(resolved.phases.deep.minRecallCount).toBe(4);
    expect(resolved.phases.deep.minUniqueQueries).toBe(3);
    expect(resolved.phases.deep.maxAgeDays).toBe(30);
    expect(resolved.phases.deep.maxPromotedSnippetTokens).toBe(160);
    expect(resolved.execution.defaults.maxOutputTokens).toBeUndefined();
    expect(resolved.execution.defaults.timeoutMs).toBeUndefined();
  });

  it("parses true/false strings while keeping invalid-value defaults local", () => {
    const resolved = resolveMemoryDreamingConfig({
      pluginConfig: {
        dreaming: {
          enabled: " TRUE ",
          verboseLogging: "false",
          storage: { separateReports: "invalid" },
          phases: { light: { enabled: " FALSE " } },
        },
      },
    });

    expect(resolved.enabled).toBe(true);
    expect(resolved.verboseLogging).toBe(false);
    expect(resolved.storage.separateReports).toBe(false);
    expect(resolved.phases.light.enabled).toBe(false);
  });

  it("lets execution defaults and phase execution override the top-level dreaming model", () => {
    const resolved = resolveMemoryDreamingConfig({
      pluginConfig: {
        dreaming: {
          model: "anthropic/claude-haiku-4-5",
          execution: {
            defaults: {
              model: "openai/gpt-5.4",
            },
          },
          phases: {
            rem: {
              execution: {
                model: "xai/grok-4.1-fast",
              },
            },
          },
        },
      },
    });

    expect(resolved.execution.defaults.model).toBe("openai/gpt-5.4");
    expect(resolved.phases.light.execution.model).toBe("openai/gpt-5.4");
    expect(resolved.phases.deep.execution.model).toBe("openai/gpt-5.4");
    expect(resolved.phases.rem.execution.model).toBe("xai/grok-4.1-fast");
  });

  it("enables dreaming by default and falls back to cfg timezone and deep defaults", () => {
    const cfg = {
      agents: {
        defaults: {
          userTimezone: "America/Los_Angeles",
        },
      },
    } as OpenClawConfig;

    const resolved = resolveMemoryDreamingConfig({
      pluginConfig: {},
      cfg,
    });

    expect(resolved.enabled).toBe(true);
    expect(resolved.frequency).toBe("0 3 * * *");
    expect(resolved.timezone).toBe("America/Los_Angeles");
    expect(resolved.phases.deep.cron).toBe("0 3 * * *");
    expect(resolved.phases.deep.limit).toBe(10);
    expect(resolved.phases.deep.minScore).toBe(0.75);
    expect(resolved.phases.deep.recencyHalfLifeDays).toBe(14);
    expect(resolved.phases.deep.maxAgeDays).toBe(30);
  });

  it("defaults storage mode to separate so phase blocks do not pollute daily memory files", () => {
    const resolved = resolveMemoryDreamingConfig({
      pluginConfig: {},
    });

    expect(resolved.storage).toEqual({
      mode: "separate",
      separateReports: false,
    });
  });

  it("preserves explicit inline storage mode for callers that opt in", () => {
    const resolved = resolveMemoryDreamingConfig({
      pluginConfig: {
        dreaming: {
          storage: {
            mode: "inline",
          },
        },
      },
    });

    expect(resolved.storage.mode).toBe("inline");
  });

  it("applies top-level dreaming frequency across all phases", () => {
    const resolved = resolveMemoryDreamingConfig({
      pluginConfig: {
        dreaming: {
          enabled: true,
          frequency: "15 */8 * * *",
        },
      },
    });

    expect(resolved.frequency).toBe("15 */8 * * *");
    expect(resolved.phases.light.cron).toBe("15 */8 * * *");
    expect(resolved.phases.deep.cron).toBe("15 */8 * * *");
    expect(resolved.phases.rem.cron).toBe("15 */8 * * *");
  });

  it("dedupes shared workspaces across all configured agents", () => {
    const cfg = {
      agents: {
        list: [
          { id: "alpha", default: true, workspace: "/workspace/shared" },
          { id: "beta", workspace: "/workspace/beta" },
          { id: "gamma", workspace: "/workspace/shared" },
        ],
      },
    } as OpenClawConfig;

    expect(resolveMemoryDreamingWorkspaces(cfg)).toEqual([
      {
        workspaceDir: "/workspace/shared",
        agentIds: ["alpha", "gamma"],
      },
      {
        workspaceDir: "/workspace/beta",
        agentIds: ["beta"],
      },
    ]);
  });

  it("includes the runtime primary workspace alongside configured subagent workspaces", () => {
    const cfg = {
      agents: {
        list: [
          { id: "agi-ceo", default: true, workspace: "/workspace/agi-ceo" },
          { id: "agi-cdo", workspace: "/workspace/agi-cdo" },
        ],
      },
    } as OpenClawConfig;

    expect(
      resolveMemoryDreamingWorkspaces(cfg, {
        primaryWorkspaceDir: "/workspace/main",
        primaryAgentId: "main",
      }),
    ).toEqual([
      {
        workspaceDir: "/workspace/agi-ceo",
        agentIds: ["agi-ceo"],
      },
      {
        workspaceDir: "/workspace/agi-cdo",
        agentIds: ["agi-cdo"],
      },
      {
        workspaceDir: "/workspace/main",
        agentIds: ["main"],
      },
    ]);
  });

  it("uses default agent fallback and timezone-aware day helpers", () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: "/workspace",
        },
        entries: { main: { default: true } },
      },
    } as OpenClawConfig;

    expect(resolveMemoryDreamingWorkspaces(cfg)).toEqual([
      {
        workspaceDir: "/workspace",
        agentIds: ["main"],
      },
    ]);

    expect(
      formatMemoryDreamingDay(Date.parse("2026-04-02T06:30:00.000Z"), "America/Los_Angeles"),
    ).toBe("2026-04-01");
    expect(
      isSameMemoryDreamingDay(
        Date.parse("2026-04-02T06:30:00.000Z"),
        Date.parse("2026-04-02T06:50:00.000Z"),
        "America/Los_Angeles",
      ),
    ).toBe(true);
  });

  it.each([
    {
      name: "configured memory.dreaming slot",
      slots: {
        "memory.dreaming": "memory-dreamer",
        "memory.recall": "memory-recall",
        memory: "legacy-memory",
      },
      expected: "memory-dreamer",
    },
    {
      name: "memory.recall fallback before the legacy memory slot",
      slots: {
        "memory.recall": "memory-recall",
        memory: "legacy-memory",
      },
      expected: "memory-recall",
    },
  ])("resolves the $name for dreaming", ({ slots, expected }) => {
    expect(resolveMemoryDreamingPluginId({ plugins: { slots } } as OpenClawConfig)).toBe(expected);
  });

  it("reads dreaming config from the configured memory.dreaming owner", () => {
    expect(
      resolveMemoryDreamingPluginConfig({
        plugins: {
          slots: {
            "memory.dreaming": "memory-dreamer",
            "memory.recall": "memory-recall",
          },
          entries: {
            "memory-dreamer": {
              config: {
                dreaming: {
                  enabled: true,
                },
              },
            },
          },
        },
      } as OpenClawConfig),
    ).toEqual({
      dreaming: {
        enabled: true,
      },
    });
  });

  it("routes dreaming config through the selected per-agent memory.dreaming slot", () => {
    const cfg = {
      plugins: {
        slots: {
          "memory.dreaming": "global-dreamer",
        },
        entries: {
          "global-dreamer": {
            config: { dreaming: { enabled: true, frequency: "0 1 * * *" } },
          },
          "agent-dreamer": {
            config: { dreaming: { enabled: true, frequency: "0 2 * * *" } },
          },
        },
      },
      agents: {
        list: [
          {
            id: "alpha",
            plugins: {
              slots: {
                "memory.dreaming": "agent-dreamer",
              },
            },
          },
        ],
      },
    } as OpenClawConfig;

    expect(resolveMemoryDreamingPluginId(cfg, { agentId: "alpha" })).toBe("agent-dreamer");
    expect(resolveMemoryDreamingPluginConfig(cfg, { agentId: "alpha" })).toEqual({
      dreaming: { enabled: true, frequency: "0 2 * * *" },
    });
  });

  it("keeps an agent override enabled when the root dreaming slot is none", () => {
    const cfg = {
      plugins: {
        slots: { "memory.dreaming": "none" },
        entries: {
          "agent-dreamer": {
            config: { dreaming: { enabled: true, frequency: "0 4 * * *" } },
          },
        },
      },
      agents: {
        list: [
          {
            id: "alpha",
            plugins: { slots: { "memory.dreaming": "agent-dreamer" } },
          },
        ],
      },
    } as OpenClawConfig;

    const selection = resolveMemoryDreamingSelection(cfg, { agentId: "alpha" });
    expect(selection.pluginId).toBe("agent-dreamer");
    expect(selection.config.enabled).toBe(true);
    expect(selection.config.frequency).toBe("0 4 * * *");
  });

  it("disables an agent whose dreaming slot overrides the root slot with none", () => {
    const cfg = {
      plugins: {
        slots: { "memory.dreaming": "root-dreamer" },
        entries: {
          "root-dreamer": {
            config: { dreaming: { enabled: true, frequency: "0 4 * * *" } },
          },
        },
      },
      agents: {
        list: [
          {
            id: "alpha",
            plugins: { slots: { "memory.dreaming": "none" } },
          },
        ],
      },
    } as OpenClawConfig;

    const selection = resolveMemoryDreamingSelection(cfg, { agentId: "alpha" });
    expect(selection.pluginId).toBeNull();
    expect(selection.pluginConfig).toBeUndefined();
    expect(selection.config.enabled).toBe(false);
  });

  it("reads dreaming config from memory.recall when no memory.dreaming slot is configured", () => {
    expect(
      resolveMemoryDreamingPluginConfig({
        plugins: {
          slots: {
            "memory.recall": "memory-lancedb",
          },
          entries: {
            "memory-lancedb": {
              config: {
                dreaming: {
                  enabled: true,
                  frequency: "0 */6 * * *",
                },
              },
            },
          },
        },
      } as OpenClawConfig),
    ).toEqual({
      dreaming: {
        enabled: true,
        frequency: "0 */6 * * *",
      },
    });
  });

  it("falls back to memory-core when no memory slot override is configured", () => {
    expect(
      resolveMemoryDreamingPluginConfig({
        plugins: {
          entries: {
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                },
              },
            },
          },
        },
      } as OpenClawConfig),
    ).toEqual({
      dreaming: {
        enabled: true,
      },
    });
  });

  it("does not use legacy memory slot as the dreaming owner", () => {
    expect(
      resolveMemoryDreamingPluginId({
        plugins: {
          slots: {
            memory: "legacy-memory",
          },
        },
      } as OpenClawConfig),
    ).toBe("memory-core");

    expect(
      resolveMemoryDreamingPluginConfig({
        plugins: {
          slots: {
            memory: "legacy-memory",
          },
          entries: {
            "legacy-memory": {
              config: {
                dreaming: {
                  enabled: false,
                },
              },
            },
            "memory-core": {
              config: {
                dreaming: {
                  enabled: true,
                },
              },
            },
          },
        },
      } as OpenClawConfig),
    ).toEqual({
      dreaming: {
        enabled: true,
      },
    });
  });

  it("does not use legacy memory fallback for dreaming when canonical recall is disabled", () => {
    expect(
      resolveMemoryDreamingPluginId({
        plugins: {
          slots: {
            memory: "legacy-memory",
            "memory.recall": "none",
          },
        },
      } as OpenClawConfig),
    ).toBe("memory-core");
  });

  it("disables dreaming when the dedicated dreaming slot is none", () => {
    const cfg = {
      plugins: {
        slots: {
          "memory.dreaming": "none",
          "memory.recall": "memory-recall",
        },
        entries: {
          "memory-recall": {
            config: {
              dreaming: {
                enabled: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveMemoryDreamingPluginId(cfg)).toBeNull();
    expect(resolveMemoryDreamingPluginConfig(cfg)).toBeUndefined();
    expect(
      resolveMemoryDreamingConfig({
        cfg,
        pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
      }).enabled,
    ).toBe(false);
  });
});
