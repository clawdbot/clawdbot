/** Tests plugin slot normalization and exclusive slot selection behavior. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginKind } from "./plugin-kind.types.js";
import {
  listConfiguredMemoryRolePluginIds,
  listConfiguredMemoryRoleSlotSelections,
  resolveMemoryRoleSlot,
} from "./slot-resolution.js";
import {
  applyExclusiveSlotSelection,
  hasKind,
  kindsEqual,
  resetAgentMemoryPluginSlotReferences,
} from "./slots.js";

describe("resolveMemoryRoleSlot", () => {
  it.each([
    {
      name: "ignores legacy plugins.slots.memory for recall when canonical recall is absent",
      cfg: { plugins: { slots: { memory: "legacy-memory" } } },
      expected: "memory-core",
    },
    {
      name: "ignores legacy plugins.slots.memory=none as runtime recall disablement",
      cfg: { plugins: { slots: { memory: "none" } } },
      expected: "memory-core",
    },
    {
      name: "uses canonical memory.recall when legacy memory conflicts",
      cfg: { plugins: { slots: { memory: "legacy-memory", "memory.recall": "canonical-memory" } } },
      expected: "canonical-memory",
    },
    {
      name: "keeps canonical memory.recall taking precedence over legacy memory=none",
      cfg: { plugins: { slots: { memory: "none", "memory.recall": "canonical-memory" } } },
      expected: "canonical-memory",
    },
    {
      name: "preserves explicit per-agent memory role disablement as a negative selection",
      cfg: {
        plugins: { slots: { "memory.recall": "global-recall" } },
        agents: { list: [{ id: "research", plugins: { slots: { "memory.recall": "none" } } }] },
      },
      agentId: "research",
      expected: null,
      fallbackAgentId: "writer",
      fallbackExpected: "global-recall",
    },
    {
      name: "ignores per-agent legacy memory selectors for recall",
      cfg: {
        plugins: { slots: { "memory.recall": "global-recall" } },
        agents: {
          list: [{ id: "research", plugins: { slots: { memory: "legacy-agent-recall" } } }],
        },
      },
      agentId: "research",
      expected: "global-recall",
    },
  ])("$name", ({ cfg, agentId, expected, fallbackAgentId, fallbackExpected }) => {
    expect(resolveMemoryRoleSlot({ cfg: cfg as OpenClawConfig, role: "recall", agentId })).toBe(
      expected,
    );
    if (fallbackAgentId) {
      expect(
        resolveMemoryRoleSlot({
          cfg: cfg as OpenClawConfig,
          role: "recall",
          agentId: fallbackAgentId,
        }),
      ).toBe(fallbackExpected);
    }
  });

  it("lists only canonical memory-role slot selections and disabled per-agent overrides", () => {
    const cfg = {
      plugins: { slots: { memory: "legacy-memory", "memory.recall": "global-recall" } },
      agents: {
        list: [
          { id: "research", plugins: { slots: { "memory.recall": "none" } } },
          { id: "legacy", plugins: { slots: { memory: "legacy-agent-recall" } } },
        ],
      },
    } as OpenClawConfig;

    expect(listConfiguredMemoryRoleSlotSelections({ cfg })).toEqual([
      { role: "recall", slotKey: "memory.recall", pluginId: "global-recall" },
      {
        role: "recall",
        slotKey: "memory.recall",
        pluginId: "none",
        agentId: "research",
        disabled: true,
      },
    ]);
    expect(listConfiguredMemoryRolePluginIds({ cfg })).toEqual(["global-recall"]);
  });
});

describe("applyExclusiveSlotSelection", () => {
  const createMemoryConfig = (plugins?: OpenClawConfig["plugins"]): OpenClawConfig => ({
    plugins: {
      ...plugins,
      entries: {
        ...plugins?.entries,
        memory: {
          enabled: true,
          ...plugins?.entries?.memory,
        },
      },
    },
  });

  const runMemorySelection = (config: OpenClawConfig, selectedId = "memory") =>
    applyExclusiveSlotSelection({
      config,
      selectedId,
      selectedKind: "memory",
      registry: {
        plugins: [
          { id: "memory-core", kind: "memory" },
          { id: "memory", kind: "memory" },
        ],
      },
    });

  function expectMemorySelectionState(
    result: ReturnType<typeof applyExclusiveSlotSelection>,
    params: {
      changed: boolean;
      selectedId?: string;
      disabledCompetingPlugin?: boolean;
    },
  ) {
    expect(result.changed).toBe(params.changed);
    if (params.selectedId) {
      expect(result.config.plugins?.slots?.["memory.recall"]).toBe(params.selectedId);
    }
    if (params.disabledCompetingPlugin != null) {
      expect(result.config.plugins?.entries?.["memory-core"]?.enabled).toBe(
        params.disabledCompetingPlugin,
      );
    }
  }

  function expectSelectionWarnings(
    warnings: string[],
    params: {
      expected: readonly string[];
    },
  ) {
    expect(warnings).toEqual([...params.expected]);
  }

  function expectUnchangedSelection(result: ReturnType<typeof applyExclusiveSlotSelection>) {
    expect(result.changed).toBe(false);
    expect(result.warnings).toHaveLength(0);
  }

  function buildSelectionRegistry(
    plugins: ReadonlyArray<{ id: string; kind?: PluginKind | PluginKind[] }>,
  ) {
    return {
      plugins: [...plugins],
    };
  }

  function expectUnchangedSelectionCase(params: {
    config: OpenClawConfig;
    selectedId: string;
    selectedKind?: PluginKind | PluginKind[];
    registry?: { plugins: ReadonlyArray<{ id: string; kind?: PluginKind | PluginKind[] }> };
  }) {
    const result = applyExclusiveSlotSelection({
      config: params.config,
      selectedId: params.selectedId,
      ...(params.selectedKind ? { selectedKind: params.selectedKind } : {}),
      ...(params.registry
        ? {
            registry: buildSelectionRegistry(params.registry.plugins),
          }
        : {}),
    });

    expectUnchangedSelection(result);
    expect(result.config).toBe(params.config);
  }

  function expectChangedSelectionCase(params: {
    config: OpenClawConfig;
    selectedId?: string;
    expectedDisabled?: boolean;
    warningChecks: {
      expected: readonly string[];
    };
  }) {
    const result = runMemorySelection(params.config, params.selectedId);

    expectMemorySelectionState(result, {
      changed: true,
      selectedId: params.selectedId ?? "memory",
      ...(params.expectedDisabled != null
        ? { disabledCompetingPlugin: params.expectedDisabled }
        : {}),
    });
    expectSelectionWarnings(result.warnings, params.warningChecks);
  }

  it.each([
    {
      name: "selects the slot and disables other entries for the same kind",
      config: createMemoryConfig({
        slots: { memory: "memory-core" },
        entries: { "memory-core": { enabled: true } },
      }),
      expectedDisabled: false,
      warningChecks: {
        expected: [
          'Exclusive slot "memory.recall" switched from "memory-core" to "memory".',
          'Disabled other "memory.recall" slot plugins: memory-core.',
        ],
      },
    },
    {
      name: "warns when the slot falls back to a default",
      config: createMemoryConfig(),
      warningChecks: {
        expected: [
          'Exclusive slot "memory.recall" switched from "memory-core" to "memory".',
          'Disabled other "memory.recall" slot plugins: memory-core.',
        ],
      },
    },
    {
      name: "keeps disabled competing plugins disabled without adding disable warnings",
      config: createMemoryConfig({
        entries: {
          "memory-core": { enabled: false },
        },
      }),
      expectedDisabled: false,
      warningChecks: {
        expected: ['Exclusive slot "memory.recall" switched from "memory-core" to "memory".'],
      },
    },
  ] as const)("$name", ({ config, expectedDisabled, warningChecks }) => {
    expectChangedSelectionCase({
      config,
      ...(expectedDisabled != null ? { expectedDisabled } : {}),
      warningChecks,
    });
  });

  it.each([
    {
      name: "does nothing when the slot already matches",
      config: createMemoryConfig({
        slots: { "memory.recall": "memory" },
      }),
      selectedId: "memory",
      selectedKind: "memory",
      registry: { plugins: [{ id: "memory", kind: "memory" }] },
    },
    {
      name: "skips changes when no exclusive slot applies",
      config: {} as OpenClawConfig,
      selectedId: "custom",
    },
  ] as const)("$name", ({ config, selectedId, selectedKind, registry }) => {
    expectUnchangedSelectionCase({
      config,
      selectedId,
      ...(selectedKind ? { selectedKind } : {}),
      ...(registry ? { registry: buildSelectionRegistry(registry.plugins) } : {}),
    });
  });

  it("applies slot selection for each kind in a multi-kind array", () => {
    const config: OpenClawConfig = {
      plugins: {
        slots: { "memory.recall": "memory-core", contextEngine: "legacy" },
        entries: {
          "memory-core": { enabled: true },
          legacy: { enabled: true },
        },
      },
    };
    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "dual-plugin",
      selectedKind: ["memory", "context-engine"],
      registry: buildSelectionRegistry([
        { id: "memory-core", kind: "memory" },
        { id: "legacy", kind: "context-engine" },
        { id: "dual-plugin", kind: ["memory", "context-engine"] },
      ]),
    });
    expect(result.changed).toBe(true);
    expect(result.config.plugins?.slots?.["memory.recall"]).toBe("dual-plugin");
    expect(result.config.plugins?.slots?.contextEngine).toBe("dual-plugin");
    expect(result.config.plugins?.entries?.["memory-core"]?.enabled).toBe(false);
    expect(result.config.plugins?.entries?.legacy?.enabled).toBe(false);
  });

  it("does not disable a dual-kind plugin that still owns another slot", () => {
    const config: OpenClawConfig = {
      plugins: {
        slots: { "memory.recall": "dual-plugin", contextEngine: "dual-plugin" },
        entries: {
          "dual-plugin": { enabled: true },
        },
      },
    };
    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "new-memory",
      selectedKind: "memory",
      registry: buildSelectionRegistry([
        { id: "dual-plugin", kind: ["memory", "context-engine"] },
        { id: "new-memory", kind: "memory" },
      ]),
    });
    expect(result.changed).toBe(true);
    expect(result.config.plugins?.slots?.["memory.recall"]).toBe("new-memory");
    // dual-plugin still owns contextEngine — must NOT be disabled
    expect(result.config.plugins?.entries?.["dual-plugin"]?.enabled).not.toBe(false);
  });

  it("does not disable a dual-kind plugin that owns another slot via default", () => {
    // contextEngine is NOT explicitly set — defaults to "legacy"
    const config: OpenClawConfig = {
      plugins: {
        slots: { "memory.recall": "legacy" },
        entries: {
          legacy: { enabled: true },
        },
      },
    };
    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "new-memory",
      selectedKind: "memory",
      registry: buildSelectionRegistry([
        { id: "legacy", kind: ["memory", "context-engine"] },
        { id: "new-memory", kind: "memory" },
      ]),
    });
    expect(result.changed).toBe(true);
    expect(result.config.plugins?.slots?.["memory.recall"]).toBe("new-memory");
    // legacy still owns contextEngine via default — must NOT be disabled
    expect(result.config.plugins?.entries?.legacy?.enabled).not.toBe(false);
  });

  it("does not consume or sync an existing legacy memory selector when selecting recall", () => {
    const config: OpenClawConfig = {
      plugins: {
        slots: { memory: "legacy-memory" },
        entries: {
          "legacy-memory": { enabled: true },
          "new-recall": { enabled: true },
        },
      },
    };
    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "new-recall",
      selectedKind: "memory",
      registry: buildSelectionRegistry([
        { id: "legacy-memory", kind: "memory" },
        { id: "new-recall", kind: "memory" },
      ]),
    });

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.slots?.memory).toBe("legacy-memory");
    expect(result.config.plugins?.slots?.["memory.recall"]).toBe("new-recall");
    expect(result.config.plugins?.entries?.["legacy-memory"]?.enabled).toBe(false);
    expect(result.warnings).toEqual([
      'Exclusive slot "memory.recall" switched from "memory-core" to "new-recall".',
      'Disabled other "memory.recall" slot plugins: legacy-memory.',
    ]);
  });

  it("leaves legacy memory selector drift to doctor even when canonical recall already matches", () => {
    const config: OpenClawConfig = {
      plugins: {
        slots: { memory: "legacy-memory", "memory.recall": "new-recall" },
        entries: {
          "legacy-memory": { enabled: true },
          "new-recall": { enabled: true },
        },
      },
    };
    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "new-recall",
      selectedKind: "memory",
      registry: buildSelectionRegistry([
        { id: "legacy-memory", kind: "memory" },
        { id: "new-recall", kind: "memory" },
      ]),
    });

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.slots?.memory).toBe("legacy-memory");
    expect(result.config.plugins?.slots?.["memory.recall"]).toBe("new-recall");
    expect(result.config.plugins?.entries?.["legacy-memory"]?.enabled).toBe(false);
    expect(result.warnings).toEqual([
      'Disabled other "memory.recall" slot plugins: legacy-memory.',
    ]);
  });

  it("does not create legacy memory selector when selecting recall for canonical-only configs", () => {
    const config: OpenClawConfig = {
      plugins: {
        slots: { "memory.recall": "memory-core" },
        entries: {
          "memory-core": { enabled: true },
          "new-recall": { enabled: true },
        },
      },
    };
    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "new-recall",
      selectedKind: "memory",
      registry: buildSelectionRegistry([
        { id: "memory-core", kind: "memory" },
        { id: "new-recall", kind: "memory" },
      ]),
    });

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.slots?.memory).toBeUndefined();
    expect(result.config.plugins?.slots?.["memory.recall"]).toBe("new-recall");
  });

  it("does not disable a memory plugin selected for another memory role slot", () => {
    const config: OpenClawConfig = {
      plugins: {
        slots: {
          "memory.recall": "memory-core",
          "memory.compaction": "memory-compaction",
          "memory.capture": "memory-capture",
          "memory.dreaming": "memory-dreaming",
          "memory.userModel": "memory-user-model",
        },
        entries: {
          "memory-core": { enabled: true },
          "memory-compaction": { enabled: true },
          "memory-capture": { enabled: true },
          "memory-dreaming": { enabled: true },
          "memory-user-model": { enabled: true },
        },
      },
    };
    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "new-recall",
      selectedKind: "memory",
      registry: buildSelectionRegistry([
        { id: "memory-core", kind: "memory" },
        { id: "memory-compaction", kind: "memory" },
        { id: "memory-capture", kind: "memory" },
        { id: "memory-dreaming", kind: "memory" },
        { id: "memory-user-model", kind: "memory" },
        { id: "new-recall", kind: "memory" },
      ]),
    });

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.slots?.["memory.recall"]).toBe("new-recall");
    expect(result.config.plugins?.entries?.["memory-core"]?.enabled).toBe(false);
    expect(result.config.plugins?.entries?.["memory-compaction"]?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.["memory-capture"]?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.["memory-dreaming"]?.enabled).toBe(true);
    expect(result.config.plugins?.entries?.["memory-user-model"]?.enabled).toBe(true);
    expect(result.warnings).toEqual([
      'Exclusive slot "memory.recall" switched from "memory-core" to "new-recall".',
      'Disabled other "memory.recall" slot plugins: memory-core.',
    ]);
  });

  it.each([
    {
      name: "agent memory role slot",
      agents: {
        list: [
          {
            id: "work",
            plugins: {
              slots: { "memory.capture": "agent-capture" },
            },
          },
        ],
      },
      protectedPluginId: "agent-capture",
      expectedList: [{ id: "work", plugins: { slots: { "memory.capture": "agent-capture" } } }],
      expectedEntries: undefined,
    },
    {
      name: "agent canonical recall slot",
      agents: {
        list: [
          {
            id: "work",
            plugins: {
              slots: { "memory.recall": "agent-recall" },
            },
          },
        ],
      },
      protectedPluginId: "agent-recall",
      expectedList: [{ id: "work", plugins: { slots: { "memory.recall": "agent-recall" } } }],
      expectedEntries: undefined,
    },
    {
      name: "authored agents.entries canonical recall slot",
      agents: {
        entries: {
          work: {
            plugins: {
              slots: { "memory.recall": "agent-recall" },
            },
          },
        },
      },
      protectedPluginId: "agent-recall",
      expectedList: undefined,
      expectedEntries: {
        work: { plugins: { slots: { "memory.recall": "agent-recall" } } },
      },
    },
  ])("does not disable a memory plugin selected for an $name", (testCase) => {
    const config: OpenClawConfig = {
      plugins: {
        slots: { "memory.recall": "memory-core" },
        entries: {
          "memory-core": { enabled: true },
          [testCase.protectedPluginId]: { enabled: true },
        },
      },
      agents: testCase.agents,
    };
    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "new-recall",
      selectedKind: "memory",
      registry: buildSelectionRegistry([
        { id: "memory-core", kind: "memory" },
        { id: testCase.protectedPluginId, kind: "memory" },
        { id: "new-recall", kind: "memory" },
      ]),
    });

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.slots?.["memory.recall"]).toBe("new-recall");
    expect(result.config.plugins?.entries?.["memory-core"]?.enabled).toBe(false);
    expect(result.config.plugins?.entries?.[testCase.protectedPluginId]?.enabled).toBe(true);
    expect(result.config.agents?.list).toEqual(testCase.expectedList);
    expect(result.config.agents?.entries).toEqual(testCase.expectedEntries);
  });

  it("does not protect a memory plugin selected only by an agent legacy memory slot", () => {
    const config: OpenClawConfig = {
      plugins: {
        slots: { "memory.recall": "memory-core" },
        entries: {
          "memory-core": { enabled: true },
          "agent-recall": { enabled: true },
        },
      },
      agents: {
        list: [
          {
            id: "work",
            plugins: {
              slots: { memory: "agent-recall" },
            },
          },
        ],
      },
    };
    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "new-recall",
      selectedKind: "memory",
      registry: buildSelectionRegistry([
        { id: "memory-core", kind: "memory" },
        { id: "agent-recall", kind: "memory" },
        { id: "new-recall", kind: "memory" },
      ]),
    });

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.slots?.["memory.recall"]).toBe("new-recall");
    expect(result.config.plugins?.entries?.["memory-core"]?.enabled).toBe(false);
    expect(result.config.plugins?.entries?.["agent-recall"]?.enabled).toBe(false);
    expect(result.config.agents?.list?.[0]?.plugins?.slots?.memory).toBe("agent-recall");
  });
});

describe("hasKind", () => {
  it("returns false for undefined kind", () => {
    expect(hasKind(undefined, "memory")).toBe(false);
  });

  it("matches a single kind string", () => {
    expect(hasKind("memory", "memory")).toBe(true);
    expect(hasKind("memory", "context-engine")).toBe(false);
  });

  it("matches within a kind array", () => {
    expect(hasKind(["memory", "context-engine"], "memory")).toBe(true);
    expect(hasKind(["memory", "context-engine"], "context-engine")).toBe(true);
  });
});

describe("resetAgentMemoryPluginSlotReferences", () => {
  it("removes stale per-agent memory overrides so global memory recall is inherited", () => {
    const cfg = {
      plugins: {
        slots: {
          "memory.recall": "memory-lancedb",
        },
      },
      agents: {
        list: [
          {
            id: "research",
            plugins: {
              slots: {
                "memory.recall": "missing-agent-recall",
                "memory.compaction": "other-memory",
              },
            },
          },
        ],
      },
    } as OpenClawConfig;

    const result = resetAgentMemoryPluginSlotReferences(cfg.agents, "missing-agent-recall");
    const nextConfig = { ...cfg, agents: result.agents };

    expect(result.changed).toBe(true);
    expect(nextConfig.agents?.list?.[0]?.plugins?.slots).toEqual({
      "memory.compaction": "other-memory",
    });
    expect(resolveMemoryRoleSlot({ cfg: nextConfig, role: "recall", agentId: "research" })).toBe(
      "memory-lancedb",
    );
  });

  it("preserves keyed agents.entries shape while removing matching overrides", () => {
    const cfg = {
      plugins: {
        slots: {
          "memory.recall": "memory-lancedb",
        },
      },
      agents: {
        entries: {
          research: {
            plugins: {
              slots: {
                "memory.recall": "missing-agent-recall",
                "memory.compaction": "other-memory",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const result = resetAgentMemoryPluginSlotReferences(cfg.agents, "missing-agent-recall");
    const nextConfig = { ...cfg, agents: result.agents };

    expect(result.changed).toBe(true);
    expect(nextConfig.agents?.entries?.research?.plugins?.slots).toEqual({
      "memory.compaction": "other-memory",
    });
    expect(nextConfig.agents?.list).toBeUndefined();
    expect(resolveMemoryRoleSlot({ cfg: nextConfig, role: "recall", agentId: "research" })).toBe(
      "memory-lancedb",
    );
  });
});

describe("kindsEqual", () => {
  it("treats undefined as equal to undefined", () => {
    expect(kindsEqual(undefined, undefined)).toBe(true);
  });

  it("matches identical strings", () => {
    expect(kindsEqual("memory", "memory")).toBe(true);
  });

  it("rejects different strings", () => {
    expect(kindsEqual("memory", "context-engine")).toBe(false);
  });

  it("matches arrays in different order", () => {
    expect(kindsEqual(["memory", "context-engine"], ["context-engine", "memory"])).toBe(true);
  });

  it("matches string against single-element array", () => {
    expect(kindsEqual("memory", ["memory"])).toBe(true);
  });

  it("rejects mismatched lengths", () => {
    expect(kindsEqual("memory", ["memory", "context-engine"])).toBe(false);
  });
});
