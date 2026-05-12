import { describe, expect, it } from "vitest";
import type { MigrationItem, MigrationPlan } from "../../plugins/types.js";
import {
  applyMigrationPluginSelection,
  applyMigrationSelectedPluginItemIds,
  applyMigrationSelectedSkillItemIds,
  applyMigrationSkillSelection,
  formatMigrationPluginSelectionHint,
  getDefaultMigrationPluginSelectionValues,
  getSelectableMigrationPluginItems,
  getDefaultMigrationSkillSelectionValues,
  MIGRATION_SKILL_SELECTION_SKIP,
  MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF,
  MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON,
  MIGRATION_PLUGIN_NOT_SELECTED_REASON,
  MIGRATION_SKILL_NOT_SELECTED_REASON,
  reconcileInteractiveMigrationShortcutValues,
  reconcileInteractiveMigrationSkillToggleValues,
  resolveInteractiveMigrationPluginSelection,
  resolveInteractiveMigrationSkillSelection,
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

function pluginItem(params: {
  id: string;
  name: string;
  status?: MigrationItem["status"];
  reason?: string;
}): MigrationItem {
  return {
    id: params.id,
    kind: "plugin",
    action: "install",
    status: params.status ?? "planned",
    reason: params.reason,
    source: `openai-curated/${params.name}`,
    target: `plugins.entries.codex.config.codexPlugins.plugins.${params.name}`,
    details: {
      configKey: params.name,
      marketplaceName: "openai-curated",
      pluginName: params.name,
    },
  };
}

function codexPluginConfigItem(pluginNames: string[]): MigrationItem {
  return {
    id: "config:codex-plugins",
    kind: "config",
    action: "merge",
    status: "planned",
    details: {
      value: {
        enabled: true,
        config: {
          codexPlugins: {
            enabled: true,
            allow_destructive_actions: true,
            plugins: Object.fromEntries(
              pluginNames.map((name) => [
                name,
                {
                  enabled: true,
                  marketplaceName: "openai-curated",
                  pluginName: name,
                },
              ]),
            ),
          },
        },
      },
    },
  };
}

function plan(items: MigrationItem[]): MigrationPlan {
  const countStatus = (status: MigrationItem["status"]): number => {
    let count = 0;
    for (const item of items) {
      if (item.status === status) {
        count += 1;
      }
    }
    return count;
  };

  return {
    providerId: "codex",
    source: "/tmp/codex",
    summary: {
      total: items.length,
      planned: countStatus("planned"),
      migrated: 0,
      skipped: countStatus("skipped"),
      conflicts: countStatus("conflict"),
      errors: 0,
      sensitive: 0,
    },
    items,
  };
}

function expectSummaryFields(
  summary: MigrationPlan["summary"],
  fields: Partial<MigrationPlan["summary"]>,
) {
  for (const [key, value] of Object.entries(fields)) {
    expect(summary[key as keyof MigrationPlan["summary"]]).toBe(value);
  }
}

function requireItem(items: MigrationItem[], id: string): MigrationItem {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) {
    throw new Error(`missing migration item ${id}`);
  }
  return item;
}

function expectItemStatus(
  items: MigrationItem[],
  id: string,
  status: MigrationItem["status"],
  reason?: string,
) {
  const item = requireItem(items, id);
  expect(item.status).toBe(status);
  if (reason !== undefined) {
    expect(item.reason).toBe(reason);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function requireCodexPluginConfigPlugins(item: MigrationItem): Record<string, unknown> {
  const details = requireRecord(item.details, "config details");
  const value = requireRecord(details.value, "config value");
  const config = requireRecord(value.config, "config object");
  const codexPlugins = requireRecord(config.codexPlugins, "codex plugin config");
  return requireRecord(codexPlugins.plugins, "configured plugins");
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

    expectSummaryFields(selected.summary, {
      total: 4,
      planned: 2,
      skipped: 2,
      conflicts: 0,
    });
    expectItemStatus(selected.items, "skill:alpha", "planned");
    expectItemStatus(selected.items, "skill:beta", "skipped", MIGRATION_SKILL_NOT_SELECTED_REASON);
    expectItemStatus(selected.items, "archive:config.toml", "planned");
  });

  it("accepts item ids as non-interactive skill selectors", () => {
    const selected = applyMigrationSkillSelection(
      plan([skillItem({ id: "skill:alpha", name: "alpha" })]),
      ["skill:alpha"],
    );

    expect(selected.items).toHaveLength(1);
    expectItemStatus(selected.items, "skill:alpha", "planned");
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
    expectItemStatus(selected.items, "skill:alpha", "planned");
    expectItemStatus(selected.items, "skill:beta", "skipped", MIGRATION_SKILL_NOT_SELECTED_REASON);
  });

  it("allows interactive selection to choose no skills", () => {
    const selected = applyMigrationSelectedSkillItemIds(
      plan([
        skillItem({ id: "skill:alpha", name: "alpha" }),
        skillItem({ id: "skill:beta", name: "beta" }),
      ]),
      new Set(),
    );

    expectSummaryFields(selected.summary, { planned: 0, skipped: 2 });
    expect(selected.items.map((item) => item.status)).toEqual(["skipped", "skipped"]);
  });

  it("defaults interactive selection to planned skills only", () => {
    expect(
      getDefaultMigrationSkillSelectionValues([
        skillItem({ id: "skill:alpha", name: "alpha" }),
        skillItem({
          id: "skill:beta",
          name: "beta",
          status: "conflict",
          reason: "target exists",
        }),
      ]),
    ).toEqual(["skill:alpha"]);
  });

  it("resolves interactive special options with skip and toggle-off precedence", () => {
    const items = [
      skillItem({ id: "skill:alpha", name: "alpha" }),
      skillItem({
        id: "skill:beta",
        name: "beta",
        status: "conflict",
        reason: "target exists",
      }),
    ];

    expect(
      resolveInteractiveMigrationSkillSelection(items, [
        MIGRATION_SKILL_SELECTION_SKIP,
        MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON,
      ]),
    ).toEqual({ action: "skip" });
    expect(
      resolveInteractiveMigrationSkillSelection(items, [
        MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON,
        MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF,
      ]),
    ).toEqual({ action: "select", selectedItemIds: new Set() });
    expect(
      resolveInteractiveMigrationSkillSelection(items, [MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON]),
    ).toEqual({
      action: "select",
      selectedItemIds: new Set(["skill:alpha", "skill:beta"]),
    });
    expect(
      resolveInteractiveMigrationSkillSelection(items, [
        MIGRATION_SKILL_SELECTION_SKIP,
        "skill:alpha",
      ]),
    ).toEqual({
      action: "select",
      selectedItemIds: new Set(["skill:alpha"]),
    });
  });

  it("reconciles live interactive bulk toggle checkbox state", () => {
    const selectable = ["skill:alpha", "skill:beta"];

    expect(
      reconcileInteractiveMigrationSkillToggleValues(
        [MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON],
        MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON,
        selectable,
      ),
    ).toEqual([MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON, "skill:alpha", "skill:beta"]);

    expect(
      reconcileInteractiveMigrationSkillToggleValues(
        [
          MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON,
          "skill:alpha",
          "skill:beta",
          MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF,
        ],
        MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF,
        selectable,
      ),
    ).toEqual([MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF]);

    expect(
      reconcileInteractiveMigrationSkillToggleValues(
        [MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF, "skill:alpha"],
        "skill:alpha",
        selectable,
      ),
    ).toEqual(["skill:alpha"]);

    expect(
      reconcileInteractiveMigrationSkillToggleValues(
        [
          MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON,
          "skill:alpha",
          "skill:beta",
          MIGRATION_SKILL_SELECTION_SKIP,
        ],
        MIGRATION_SKILL_SELECTION_SKIP,
        selectable,
      ),
    ).toEqual([MIGRATION_SKILL_SELECTION_SKIP]);

    expect(
      reconcileInteractiveMigrationSkillToggleValues(
        [MIGRATION_SKILL_SELECTION_SKIP, "skill:alpha"],
        "skill:alpha",
        selectable,
      ),
    ).toEqual(["skill:alpha"]);

    expect(
      reconcileInteractiveMigrationShortcutValues(
        ["skill:alpha", "skill:beta"],
        [
          MIGRATION_SKILL_SELECTION_SKIP,
          MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON,
          MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF,
          "skill:alpha",
          "skill:beta",
        ],
        selectable,
        "a",
      ),
    ).toEqual([MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF]);

    expect(
      reconcileInteractiveMigrationShortcutValues(
        [MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF],
        [
          MIGRATION_SKILL_SELECTION_SKIP,
          MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF,
          MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON,
        ],
        selectable,
        "i",
      ),
    ).toEqual([MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF]);

    expect(
      reconcileInteractiveMigrationShortcutValues(
        [MIGRATION_SKILL_SELECTION_SKIP],
        [MIGRATION_SKILL_SELECTION_SKIP, "skill:beta"],
        selectable,
        "i",
      ),
    ).toEqual(["skill:beta"]);
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

describe("applyMigrationPluginSelection", () => {
  it("keeps selected plugins and skips unselected plugin install items", () => {
    const selected = applyMigrationPluginSelection(
      plan([
        pluginItem({ id: "plugin:google-calendar", name: "google-calendar" }),
        pluginItem({ id: "plugin:gmail", name: "gmail" }),
        codexPluginConfigItem(["google-calendar", "gmail"]),
      ]),
      ["google-calendar"],
    );

    expectSummaryFields(selected.summary, { planned: 2, skipped: 1, conflicts: 0 });
    expectItemStatus(selected.items, "plugin:google-calendar", "planned");
    expectItemStatus(
      selected.items,
      "plugin:gmail",
      "skipped",
      MIGRATION_PLUGIN_NOT_SELECTED_REASON,
    );
    const configItem = requireItem(selected.items, "config:codex-plugins");
    expect(configItem.status).toBe("planned");
    const plugins = requireCodexPluginConfigPlugins(configItem);
    expect(requireRecord(plugins["google-calendar"], "google calendar plugin config")).toEqual({
      enabled: true,
      marketplaceName: "openai-curated",
      pluginName: "google-calendar",
    });
    expect(Object.keys(plugins)).toEqual(["google-calendar"]);
  });

  it("skips the Codex plugin config item when no plugin remains selected", () => {
    const selected = applyMigrationPluginSelection(
      plan([
        pluginItem({ id: "plugin:google-calendar", name: "google-calendar" }),
        pluginItem({ id: "plugin:gmail", name: "gmail" }),
        codexPluginConfigItem(["google-calendar", "gmail"]),
      ]),
      [],
    );

    expectSummaryFields(selected.summary, { planned: 0, skipped: 3, conflicts: 0 });
    expectItemStatus(
      selected.items,
      "plugin:google-calendar",
      "skipped",
      MIGRATION_PLUGIN_NOT_SELECTED_REASON,
    );
    expectItemStatus(
      selected.items,
      "plugin:gmail",
      "skipped",
      MIGRATION_PLUGIN_NOT_SELECTED_REASON,
    );
    expectItemStatus(
      selected.items,
      "config:codex-plugins",
      "skipped",
      MIGRATION_PLUGIN_NOT_SELECTED_REASON,
    );
  });

  it("allows interactive selection to choose no plugins", () => {
    const selected = applyMigrationSelectedPluginItemIds(
      plan([
        pluginItem({ id: "plugin:google-calendar", name: "google-calendar" }),
        pluginItem({ id: "plugin:gmail", name: "gmail" }),
        codexPluginConfigItem(["google-calendar", "gmail"]),
      ]),
      new Set(),
    );

    expectSummaryFields(selected.summary, { planned: 0, skipped: 3 });
    expect(selected.items.every((item) => item.status === "skipped")).toBe(true);
  });

  it("defaults interactive plugin selection to planned plugins", () => {
    expect(
      getDefaultMigrationPluginSelectionValues([
        pluginItem({ id: "plugin:google-calendar", name: "google-calendar" }),
        pluginItem({
          id: "plugin:gmail",
          name: "gmail",
          status: "conflict",
          reason: "plugin exists",
        }),
      ]),
    ).toEqual(["plugin:google-calendar"]);
  });

  it("includes conflicting plugins in the selector with a conflict hint", () => {
    const items = [
      pluginItem({ id: "plugin:google-calendar", name: "google-calendar" }),
      pluginItem({
        id: "plugin:gmail",
        name: "gmail",
        status: "conflict",
        reason: "plugin exists",
      }),
    ];

    expect(getSelectableMigrationPluginItems(plan(items)).map((item) => item.id)).toEqual([
      "plugin:google-calendar",
      "plugin:gmail",
    ]);
    expect(formatMigrationPluginSelectionHint(items[1])).toBe(
      "openai-curated; conflict: plugin exists",
    );
  });

  it("resolves interactive plugin special options with toggle-off precedence", () => {
    const items = [
      pluginItem({ id: "plugin:google-calendar", name: "google-calendar" }),
      pluginItem({ id: "plugin:gmail", name: "gmail" }),
    ];

    expect(
      resolveInteractiveMigrationPluginSelection(items, [
        MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON,
        MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF,
      ]),
    ).toEqual({ action: "select", selectedItemIds: new Set() });
    expect(
      resolveInteractiveMigrationPluginSelection(items, [MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON]),
    ).toEqual({
      action: "select",
      selectedItemIds: new Set(["plugin:google-calendar", "plugin:gmail"]),
    });
    expect(resolveInteractiveMigrationPluginSelection(items, ["plugin:gmail"])).toEqual({
      action: "select",
      selectedItemIds: new Set(["plugin:gmail"]),
    });
  });

  it("accepts item ids as non-interactive plugin selectors", () => {
    const selected = applyMigrationPluginSelection(
      plan([pluginItem({ id: "plugin:google-calendar", name: "google-calendar" })]),
      ["plugin:google-calendar"],
    );

    expect(selected.items).toHaveLength(1);
    expectItemStatus(selected.items, "plugin:google-calendar", "planned");
  });

  it("rejects unknown explicit plugin selectors with available choices", () => {
    expect(() =>
      applyMigrationPluginSelection(
        plan([
          pluginItem({ id: "plugin:google-calendar", name: "google-calendar" }),
          pluginItem({ id: "plugin:gmail", name: "gmail" }),
        ]),
        ["calendar"],
      ),
    ).toThrow(
      'No migratable plugin matched "calendar". Available plugins: gmail, google-calendar.',
    );
  });
});
