import { describe, expect, it } from "vitest";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

describe("legacy agent roster migration", () => {
  it("marks the first agent as default when none is marked", () => {
    const result = applyLegacyDoctorMigrations({
      agents: { list: [{ id: "alpha" }, { id: "beta" }] },
    });
    expect(result.next?.agents).toEqual({
      list: [{ id: "alpha", default: true }, { id: "beta" }],
    });
    expect(applyLegacyDoctorMigrations(result.next)).toEqual({ next: null, changes: [] });
  });

  it("keeps the first effective default when multiple are marked", () => {
    const result = applyLegacyDoctorMigrations({
      agents: {
        list: [
          { id: "alpha", default: true },
          { id: "beta", default: true },
        ],
      },
    });
    expect(result.next?.agents).toEqual({
      list: [{ id: "alpha", default: true }, { id: "beta" }],
    });
  });

  it("materializes main only for an explicit legacy agent reference", () => {
    const result = applyLegacyDoctorMigrations({
      bindings: [{ agentId: "main", match: { channel: "discord" } }],
    });
    expect(result.next?.agents).toEqual({ list: [{ id: "main", default: true }] });
    expect(applyLegacyDoctorMigrations({ agents: { defaults: { model: "openai/gpt" } } })).toEqual({
      next: null,
      changes: [],
    });
  });
});
