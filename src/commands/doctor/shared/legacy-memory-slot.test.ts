import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  collectLegacyMemorySlotWarnings,
  maybeRepairLegacyMemorySlotConfig,
  scanLegacyMemorySlotConfig,
} from "./legacy-memory-slot.js";

describe("legacy memory slot doctor migration", () => {
  it("migrates global legacy memory slot to memory.recall", () => {
    const cfg = {
      plugins: {
        slots: {
          memory: "memory-lancedb",
          contextEngine: "legacy",
        },
      },
    } as OpenClawConfig;

    expect(scanLegacyMemorySlotConfig(cfg)).toEqual([
      {
        location: { scope: "root" },
        pathLabel: "plugins.slots.memory",
        legacyValue: "memory-lancedb",
        recallValue: undefined,
        conflict: false,
      },
    ]);

    const result = maybeRepairLegacyMemorySlotConfig(cfg);

    expect(result.changes).toEqual([
      "- plugins.slots.memory: moved legacy memory slot to memory.recall (memory-lancedb) and removed the legacy selector.",
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.config.plugins?.slots).toEqual({
      "memory.recall": "memory-lancedb",
      contextEngine: "legacy",
    });
  });

  it("migrates legacy memory=none to canonical recall disablement", () => {
    const cfg = {
      plugins: {
        slots: {
          memory: "none",
        },
      },
    } as OpenClawConfig;

    const result = maybeRepairLegacyMemorySlotConfig(cfg);

    expect(result.changes).toEqual([
      "- plugins.slots.memory: moved legacy memory slot to memory.recall (none) and removed the legacy selector.",
    ]);
    expect(result.config.plugins?.slots).toEqual({
      "memory.recall": "none",
    });
  });

  it("migrates per-agent legacy memory slot overrides", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "main",
            plugins: {
              slots: {
                memory: "openclaw-honcho",
              },
            },
          },
        ],
      },
    } as OpenClawConfig;

    const result = maybeRepairLegacyMemorySlotConfig(cfg);

    expect(result.changes).toEqual([
      "- agents.list.0.plugins.slots.memory: moved legacy memory slot to memory.recall (openclaw-honcho) and removed the legacy selector.",
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.config.agents?.list?.[0]?.plugins?.slots).toEqual({
      "memory.recall": "openclaw-honcho",
    });
  });

  it("migrates authored agents.entries memory slots without materialized list mutation", () => {
    const entry = {
      default: true,
      plugins: {
        slots: {
          memory: "entry-memory",
        },
      },
    };
    const materialized = {
      id: "main",
      plugins: {
        slots: {
          memory: "materialized-memory",
        },
      },
    };
    const cfg = {
      agents: {
        entries: { main: entry },
      },
    } as OpenClawConfig;
    Object.defineProperty(cfg.agents!, "list", {
      configurable: true,
      enumerable: false,
      value: [materialized],
    });

    const result = maybeRepairLegacyMemorySlotConfig(cfg);

    expect(result.changes).toEqual([
      "- agents.entries.main.plugins.slots.memory: moved legacy memory slot to memory.recall (entry-memory) and removed the legacy selector.",
    ]);
    expect(result.config.agents?.entries?.main?.plugins?.slots).toEqual({
      "memory.recall": "entry-memory",
    });
    expect(materialized.plugins.slots).toEqual({
      memory: "materialized-memory",
    });
  });

  it("removes redundant legacy memory when memory.recall already matches", () => {
    const cfg = {
      plugins: {
        slots: {
          memory: "memory-lancedb",
          "memory.recall": "memory-lancedb",
        },
      },
    } as OpenClawConfig;

    const result = maybeRepairLegacyMemorySlotConfig(cfg);

    expect(result.changes).toEqual([
      "- plugins.slots.memory: removed redundant legacy memory slot selector already covered by memory.recall (memory-lancedb).",
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.config.plugins?.slots).toEqual({
      "memory.recall": "memory-lancedb",
    });
  });

  it("removes conflicting legacy slot while preserving canonical recall", () => {
    const cfg = {
      plugins: {
        slots: {
          memory: "memory-lancedb",
          "memory.recall": "memory-core",
        },
      },
    } as OpenClawConfig;

    const result = maybeRepairLegacyMemorySlotConfig(cfg);

    expect(result.changes).toEqual([
      "- plugins.slots.memory: removed legacy memory slot selector (memory-lancedb) and preserved existing memory.recall (memory-core).",
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.config.plugins?.slots).toEqual({
      "memory.recall": "memory-core",
    });
    expect(maybeRepairLegacyMemorySlotConfig(result.config).changes).toEqual([]);
  });

  it("formats doctor preview warnings for fixable and conflicting legacy slots", () => {
    const warnings = collectLegacyMemorySlotWarnings({
      doctorFixCommand: "openclaw doctor --fix",
      hits: [
        {
          location: { scope: "root" },
          pathLabel: "plugins.slots.memory",
          legacyValue: "memory-lancedb",
          conflict: false,
        },
        {
          location: { scope: "agent", roster: "list", index: 0 },
          pathLabel: "agents.list.0.plugins.slots.memory",
          legacyValue: "memory-a",
          recallValue: "memory-b",
          conflict: true,
        },
      ],
    });

    expect(warnings).toEqual([
      "- Found 2 legacy memory slot selectors (for example plugins.slots.memory).",
      '- `plugins.slots.memory` is removed from runtime routing; use `plugins.slots["memory.recall"]` for factual recall provider selection.',
      "- Doctor migrates legacy-only selectors to memory.recall, removes the old memory key, and preserves an existing canonical memory.recall value when both are present.",
      '- Run "openclaw doctor --fix" before normal runtime to migrate/remove 2 legacy memory slots.',
    ]);
  });
});
