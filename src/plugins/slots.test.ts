import { describe, expect, it } from "vitest";

import type { MoltbotConfig } from "../config/config.js";
import { applyExclusiveSlotSelection } from "./slots.js";

describe("applyExclusiveSlotSelection", () => {
  it("selects the slot and disables other entries for the same kind", () => {
    const config: MoltbotConfig = {
      plugins: {
        slots: { memory: "memory-core" },
        entries: {
          "memory-core": { enabled: true },
          memory: { enabled: true },
        },
      },
    };

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
    expect(result.config.plugins?.entries?.["memory-core"]?.enabled).toBe(false);
    expect(result.warnings).toContain(
      'Exclusive slot "memory" switched from "memory-core" to "memory".',
    );
    expect(result.warnings).toContain('Disabled other "memory" slot plugins: memory-core.');
  });

  it("does nothing when the slot already matches", () => {
    const config: MoltbotConfig = {
      plugins: {
        slots: { memory: "memory" },
        entries: {
          memory: { enabled: true },
        },
      },
    };

    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "memory",
      selectedKind: "memory",
      registry: { plugins: [{ id: "memory", kind: "memory" }] },
    });

    expect(result.changed).toBe(false);
    expect(result.warnings).toHaveLength(0);
    expect(result.config).toBe(config);
  });

  it("warns when the slot falls back to a default", () => {
    const config: MoltbotConfig = {
      plugins: {
        entries: {
          memory: { enabled: true },
        },
      },
    };

    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "memory",
      selectedKind: "memory",
      registry: { plugins: [{ id: "memory", kind: "memory" }] },
    });

    expect(result.changed).toBe(true);
    expect(result.warnings).toContain(
      'Exclusive slot "memory" switched from "memory-core" to "memory".',
    );
  });

  it("skips changes when no exclusive slot applies", () => {
    const config: MoltbotConfig = {};
    const result = applyExclusiveSlotSelection({
      config,
      selectedId: "custom",
    });

    expect(result.changed).toBe(false);
    expect(result.warnings).toHaveLength(0);
    expect(result.config).toBe(config);
  });
});
