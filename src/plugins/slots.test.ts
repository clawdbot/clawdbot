/** Tests plugin slot normalization and exclusive slot selection behavior. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyExclusiveSlotSelection,
  hasKind,
  kindsEqual,
  resetPluginSlotsToDefaults,
} from "./slots.js";

describe("resetPluginSlotsToDefaults", () => {
  it("resets every slot owned by the plugin", () => {
    expect(
      resetPluginSlotsToDefaults(
        { memory: "dual-plugin", contextEngine: "dual-plugin" },
        "dual-plugin",
      ),
    ).toBeUndefined();
  });

  it("preserves slot state when the plugin owns no slot", () => {
    const slots = { memory: "memory-core", contextEngine: "legacy" };

    expect(resetPluginSlotsToDefaults(slots, "other-plugin")).toBe(slots);
    expect(resetPluginSlotsToDefaults(undefined, "other-plugin")).toBeUndefined();
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

  it("keeps the default memory selection implicit", () => {
    const config: OpenClawConfig = {
      plugins: { entries: { "memory-core": { enabled: true } } },
    };

    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "memory-core",
      selectedKind: "memory",
      registry: { plugins: [{ id: "memory-core", kind: "memory" }] },
    });

    expect(result.changed).toBe(false);
    expect(result.warnings).toHaveLength(0);
    expect(result.config).toBe(config);
  });

  it("removes an explicit override when selecting the default memory plugin", () => {
    const config: OpenClawConfig = {
      plugins: {
        slots: { memory: "memory" },
        entries: { memory: { enabled: true }, "memory-core": { enabled: true } },
      },
    };

    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "memory-core",
      selectedKind: "memory",
      registry: {
        plugins: [
          { id: "memory", kind: "memory" },
          { id: "memory-core", kind: "memory" },
        ],
      },
    });

    expect(result.changed).toBe(true);
    expect(result.config.plugins).not.toHaveProperty("slots");
    expect(result.config.plugins?.entries?.memory?.enabled).toBe(false);
  });

  it.each([
    {
      name: "selects the slot and disables other entries for the same kind",
      config: createMemoryConfig({
        slots: { memory: "memory-core" },
        entries: { "memory-core": { enabled: true } },
      }),
      expectedDisabled: false,
      expectedWarnings: [
        'Exclusive slot "memory" switched from "memory-core" to "memory".',
        'Disabled other "memory" slot plugins: memory-core.',
      ],
    },
    {
      name: "warns when the slot falls back to a default",
      config: createMemoryConfig(),
      expectedWarnings: [
        'Exclusive slot "memory" switched from "memory-core" to "memory".',
        'Disabled other "memory" slot plugins: memory-core.',
      ],
    },
    {
      name: "keeps disabled competing plugins disabled without adding disable warnings",
      config: createMemoryConfig({
        entries: {
          "memory-core": { enabled: false },
        },
      }),
      expectedDisabled: false,
      expectedWarnings: ['Exclusive slot "memory" switched from "memory-core" to "memory".'],
    },
  ] as const)("$name", ({ config, expectedDisabled, expectedWarnings }) => {
    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "memory",
      selectedKind: "memory",
      registry: {
        plugins: [
          { id: "memory-core", kind: "memory" },
          { id: "memory", kind: "memory" },
        ],
      },
    });

    expect(result.changed).toBe(true);
    expect(result.config.plugins?.slots?.memory).toBe("memory");
    if (expectedDisabled != null) {
      expect(result.config.plugins?.entries?.["memory-core"]?.enabled).toBe(expectedDisabled);
    }
    expect(result.warnings).toEqual(expectedWarnings);
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
    const result = applyExclusiveSlotSelection({
      config,
      selectedId,
      ...(selectedKind ? { selectedKind } : {}),
      ...(registry ? { registry: { plugins: [...registry.plugins] } } : {}),
    });

    expect(result.changed).toBe(false);
    expect(result.warnings).toHaveLength(0);
    expect(result.config).toBe(config);
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
      registry: {
        plugins: [
          { id: "memory-core", kind: "memory" },
          { id: "legacy", kind: "context-engine" },
          { id: "dual-plugin", kind: ["memory", "context-engine"] },
        ],
      },
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
      registry: {
        plugins: [
          { id: "dual-plugin", kind: ["memory", "context-engine"] },
          { id: "new-memory", kind: "memory" },
        ],
      },
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
      registry: {
        plugins: [
          { id: "legacy", kind: ["memory", "context-engine"] },
          { id: "new-memory", kind: "memory" },
        ],
      },
    });
    expect(result.changed).toBe(true);
    expect(result.config.plugins?.slots?.memory).toBe("new-memory");
    // legacy still owns contextEngine via default — must NOT be disabled
    expect(result.config.plugins?.entries?.legacy?.enabled).not.toBe(false);
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
