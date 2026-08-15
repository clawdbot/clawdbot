import { describe, expect, it } from "vitest";
import type { MigrationPlan } from "../../plugins/types.js";
import { applyMigrationItemSelection } from "./item-selection.js";

function plan(): MigrationPlan {
  const items: MigrationPlan["items"] = [
    { id: "auth:openai", kind: "auth", action: "copy", status: "planned", sensitive: true },
    { id: "memory:codex", kind: "memory", action: "copy", status: "planned" },
  ];
  return {
    providerId: "codex",
    source: "/tmp/codex-home",
    items,
    summary: {
      total: 2,
      planned: 2,
      migrated: 0,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      sensitive: 1,
    },
  };
}

describe("applyMigrationItemSelection", () => {
  it("limits a plan to the exact selected auth item", () => {
    const selected = applyMigrationItemSelection(plan(), ["auth:openai"]);

    expect(selected.items).toEqual([
      expect.objectContaining({ id: "auth:openai", status: "planned" }),
      expect.objectContaining({
        id: "memory:codex",
        status: "skipped",
        reason: "not selected for migration",
      }),
    ]);
    expect(selected.summary).toMatchObject({ planned: 1, skipped: 1 });
  });

  it("rejects an unavailable item instead of widening the migration", () => {
    expect(() => applyMigrationItemSelection(plan(), ["auth:missing"])).toThrow(
      'Unknown or unavailable migration item ids: "auth:missing".',
    );
  });
});
