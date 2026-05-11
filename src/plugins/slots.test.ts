import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyExclusiveSlotSelection,
  hasKind,
  kindsEqual,
  normalizeKinds,
  slotKeysForPluginKind,
} from "./slots.js";
import type { PluginKind } from "./types.js";

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
      expect(result.config.plugins?.slots?.memory).toBe(params.selectedId);
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
          'Exclusive slot "memory" switched from "memory-core" to "memory".',
          'Disabled other "memory" slot plugins: memory-core.',
        ],
      },
    },
    {
      name: "warns when the slot falls back to a default",
      config: createMemoryConfig(),
      warningChecks: {
        expected: [
          'Exclusive slot "memory" switched from "memory-core" to "memory".',
          'Disabled other "memory" slot plugins: memory-core.',
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
        expected: ['Exclusive slot "memory" switched from "memory-core" to "memory".'],
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
        slots: { memory: "memory" },
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
        slots: { memory: "memory-core", contextEngine: "legacy" },
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
    expect(result.config.plugins?.slots?.memory).toBe("dual-plugin");
    expect(result.config.plugins?.slots?.contextEngine).toBe("dual-plugin");
    expect(result.config.plugins?.entries?.["memory-core"]?.enabled).toBe(false);
    expect(result.config.plugins?.entries?.legacy?.enabled).toBe(false);
  });

  it("does not disable a dual-kind plugin that still owns another slot", () => {
    const config: OpenClawConfig = {
      plugins: {
        slots: { memory: "dual-plugin", contextEngine: "dual-plugin" },
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
    expect(result.config.plugins?.slots?.memory).toBe("new-memory");
    // dual-plugin still owns contextEngine — must NOT be disabled
    expect(result.config.plugins?.entries?.["dual-plugin"]?.enabled).not.toBe(false);
  });

  it("does not disable a dual-kind plugin that owns another slot via default", () => {
    // contextEngine is NOT explicitly set — defaults to "legacy"
    const config: OpenClawConfig = {
      plugins: {
        slots: { memory: "legacy" },
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
    expect(result.config.plugins?.slots?.memory).toBe("new-memory");
    // legacy still owns contextEngine via default — must NOT be disabled
    expect(result.config.plugins?.entries?.legacy?.enabled).not.toBe(false);
  });
});

describe("normalizeKinds", () => {
  it("returns empty array for undefined", () => {
    expect(normalizeKinds(undefined)).toStrictEqual([]);
  });

  it("wraps a single kind in an array", () => {
    expect(normalizeKinds("memory")).toEqual(["memory"]);
  });

  it("returns an array kind as-is", () => {
    expect(normalizeKinds(["memory", "context-engine"])).toEqual(["memory", "context-engine"]);
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

describe("slotKeysForPluginKind", () => {
  it("returns empty for undefined", () => {
    expect(slotKeysForPluginKind(undefined)).toStrictEqual([]);
  });

  it("returns single slot key for single kind", () => {
    expect(slotKeysForPluginKind("memory")).toEqual(["memory"]);
  });

  it("returns multiple slot keys for multi-kind", () => {
    expect(slotKeysForPluginKind(["memory", "context-engine"])).toEqual([
      "memory",
      "contextEngine",
    ]);
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
