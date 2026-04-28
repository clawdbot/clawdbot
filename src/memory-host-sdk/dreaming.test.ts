import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  formatMemoryDreamingDay,
  isSameMemoryDreamingDay,
  resolveMemoryDreamingPluginConfig,
  resolveMemoryDreamingPluginId,
  resolveMemoryDreamingConfig,
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
    expect(resolved.phases.deep).toMatchObject({
      cron: "0 */4 * * *",
      limit: 5,
      minScore: 0.9,
      minRecallCount: 4,
      minUniqueQueries: 2,
      recencyHalfLifeDays: 21,
      maxAgeDays: 30,
    });
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

  it("falls back to cfg timezone and deep defaults", () => {
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

    expect(resolved.enabled).toBe(false);
    expect(resolved.frequency).toBe("0 3 * * *");
    expect(resolved.timezone).toBe("America/Los_Angeles");
    expect(resolved.phases.deep).toMatchObject({
      cron: "0 3 * * *",
      limit: 10,
      minScore: 0.8,
      recencyHalfLifeDays: 14,
      maxAgeDays: 30,
    });
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
          { id: "alpha", workspace: "/workspace/shared" },
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

  it("uses default agent fallback and timezone-aware day helpers", () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: "/workspace",
        },
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

  it("resolves the configured memory-slot plugin id", () => {
    expect(
      resolveMemoryDreamingPluginId({
        plugins: {
          slots: {
            memory: "memos-local-openclaw-plugin",
          },
        },
      } as OpenClawConfig),
    ).toBe("memos-local-openclaw-plugin");
  });

  it("reads dreaming config from the configured memory-slot owner", () => {
    expect(
      resolveMemoryDreamingPluginConfig({
        plugins: {
          slots: {
            memory: "memos-local-openclaw-plugin",
          },
          entries: {
            "memos-local-openclaw-plugin": {
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

  it("reads dreaming config from memory-lancedb when it owns the memory slot", () => {
    expect(
      resolveMemoryDreamingPluginConfig({
        plugins: {
          slots: {
            memory: "memory-lancedb",
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

  it('falls back to memory-core when memory slot is "none" or blank', () => {
    expect(
      resolveMemoryDreamingPluginId({
        plugins: {
          slots: {
            memory: "none",
          },
        },
      } as OpenClawConfig),
    ).toBe("memory-core");

    expect(
      resolveMemoryDreamingPluginConfig({
        plugins: {
          slots: {
            memory: "   ",
          },
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
});
