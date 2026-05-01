import { describe, expect, it } from "vitest";
import type { MigrationItem, MigrationPlan } from "../../plugins/types.js";
import {
  applyMigrationSelectedSkillItemIds,
  applyMigrationSkillSelection,
  MIGRATION_SKILL_NOT_SELECTED_REASON,
} from "./selection.js";

function skillItem(params: {
  id: string;
  name: string;
  status?: MigrationItem["status"];
  reason?: string;
}): MigrationItem {
  return {
    id: params.id,
    kind: "skill",
    action: "copy",
    status: params.status ?? "planned",
    source: `/tmp/codex/skills/${params.name}`,
    target: `/tmp/openclaw/workspace/skills/${params.name}`,
    reason: params.reason,
    details: {
      skillName: params.name,
      sourceLabel: "Codex CLI skill",
    },
  };
}

function plan(items: MigrationItem[]): MigrationPlan {
  return {
    providerId: "codex",
    source: "/tmp/codex",
    summary: {
      total: items.length,
      planned: items.filter((item) => item.status === "planned").length,
      migrated: 0,
      skipped: items.filter((item) => item.status === "skipped").length,
      conflicts: items.filter((item) => item.status === "conflict").length,
      errors: 0,
      sensitive: 0,
    },
    items,
  };
}

describe("applyMigrationSkillSelection", () => {
  it("keeps selected skills and skips unselected skill copy items", () => {
    const selected = applyMigrationSkillSelection(
      plan([
        skillItem({ id: "skill:alpha", name: "alpha" }),
        skillItem({ id: "skill:beta", name: "beta" }),
        {
          id: "archive:config.toml",
          kind: "archive",
          action: "archive",
          status: "planned",
        },
        {
          id: "plugin:docs:1",
          kind: "manual",
          action: "manual",
          status: "skipped",
        },
      ]),
      ["alpha"],
    );

    expect(selected.summary).toMatchObject({
      total: 4,
      planned: 2,
      skipped: 2,
      conflicts: 0,
    });
    expect(selected.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "skill:alpha", status: "planned" }),
        expect.objectContaining({
          id: "skill:beta",
          status: "skipped",
          reason: MIGRATION_SKILL_NOT_SELECTED_REASON,
        }),
        expect.objectContaining({ id: "archive:config.toml", status: "planned" }),
      ]),
    );
  });

  it("accepts item ids as non-interactive skill selectors", () => {
    const selected = applyMigrationSkillSelection(
      plan([skillItem({ id: "skill:alpha", name: "alpha" })]),
      ["skill:alpha"],
    );

    expect(selected.items).toEqual([
      expect.objectContaining({ id: "skill:alpha", status: "planned" }),
    ]);
  });

  it("can skip conflicting skills before apply conflict checks run", () => {
    const selected = applyMigrationSkillSelection(
      plan([
        skillItem({ id: "skill:alpha", name: "alpha" }),
        skillItem({
          id: "skill:beta",
          name: "beta",
          status: "conflict",
          reason: "target exists",
        }),
      ]),
      ["alpha"],
    );

    expect(selected.summary.conflicts).toBe(0);
    expect(selected.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "skill:alpha", status: "planned" }),
        expect.objectContaining({
          id: "skill:beta",
          status: "skipped",
          reason: MIGRATION_SKILL_NOT_SELECTED_REASON,
        }),
      ]),
    );
  });

  it("allows interactive selection to choose no skills", () => {
    const selected = applyMigrationSelectedSkillItemIds(
      plan([
        skillItem({ id: "skill:alpha", name: "alpha" }),
        skillItem({ id: "skill:beta", name: "beta" }),
      ]),
      new Set(),
    );

    expect(selected.summary).toMatchObject({ planned: 0, skipped: 2 });
    expect(selected.items.every((item) => item.status === "skipped")).toBe(true);
  });

  it("rejects unknown explicit skill selectors with available choices", () => {
    expect(() =>
      applyMigrationSkillSelection(
        plan([
          skillItem({ id: "skill:alpha", name: "alpha" }),
          skillItem({ id: "skill:beta", name: "beta" }),
        ]),
        ["gamma"],
      ),
    ).toThrow('No migratable skill matched "gamma". Available skills: alpha, beta.');
  });
});
