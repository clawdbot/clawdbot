import { describe, expect, it } from "vitest";
import type { MigrationItem, MigrationPlan } from "../../plugins/types.js";
import { stripAnsi } from "../../terminal/ansi.js";
import { formatMigrationPlan } from "./output.js";

function skillItem(index: number): MigrationItem {
  return {
    id: `skill:skill-${index}`,
    kind: "skill",
    action: "copy",
    status: "planned",
    details: {
      skillName: `skill-${index}`,
    },
  };
}

function pluginItem(name: string): MigrationItem {
  return {
    id: `plugin:${name}`,
    kind: "plugin",
    action: "install",
    status: "planned",
    details: {
      configKey: name,
      marketplaceName: "openai-curated",
      pluginName: name,
    },
  };
}

function plan(items: MigrationItem[]): MigrationPlan {
  return {
    providerId: "codex",
    source: "/tmp/codex",
    summary: {
      total: items.length,
      planned: items.length,
      migrated: 0,
      skipped: 0,
      conflicts: 0,
      errors: 0,
      sensitive: 0,
    },
    items,
  };
}

describe("formatMigrationPlan", () => {
  it("does not duplicate native Codex plugins when they are already visible", () => {
    const lines = formatMigrationPlan(
      plan([skillItem(1), pluginItem("google-calendar"), pluginItem("gmail")]),
    ).map(stripAnsi);

    expect(lines.join("\n")).not.toContain("Native Codex plugins:");
  });

  it("surfaces native Codex plugin names even when normal item output is truncated", () => {
    const lines = formatMigrationPlan(
      plan([
        ...Array.from({ length: 30 }, (_, index) => skillItem(index + 1)),
        pluginItem("google-calendar"),
        pluginItem("gmail"),
      ]),
    ).map(stripAnsi);

    const output = lines.join("\n");
    expect(output).toContain("Native Codex plugins:\n- google-calendar\n- gmail");
    expect(output.indexOf("Native Codex plugins:")).toBeLessThan(output.indexOf("Items:"));
    expect(output).toContain("- ... 7 more");
  });
});
