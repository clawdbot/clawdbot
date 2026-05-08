import { describe, expect, it } from "vitest";
import type { MigrationItem, MigrationPlan } from "../../plugins/types.js";
import {
  applyMigrationPluginSelection,
  applyMigrationSelectedSkillItemIds,
  applyMigrationSkillSelection,
  getDefaultMigrationSkillSelectionValues,
  MIGRATION_SKILL_SELECTION_SKIP,
  MIGRATION_SKILL_SELECTION_TOGGLE_ALL_OFF,
  MIGRATION_SKILL_SELECTION_TOGGLE_ALL_ON,
  MIGRATION_PLUGIN_NOT_SELECTED_REASON,
  MIGRATION_SKILL_NOT_SELECTED_REASON,
  reconcileInteractiveMigrationShortcutValues,
  reconcileInteractiveMigrationSkillToggleValues,
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
}): MigrationItem {
  return {
    id: params.id,
    kind: "plugin",
    action: "install",
    status: params.status ?? "planned",
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
            allow_destructive_actions: false,
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

    expect(selected.summary).toMatchObject({ planned: 2, skipped: 1, conflicts: 0 });
    expect(selected.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "plugin:google-calendar", status: "planned" }),
        expect.objectContaining({
          id: "plugin:gmail",
          status: "skipped",
          reason: MIGRATION_PLUGIN_NOT_SELECTED_REASON,
        }),
        expect.objectContaining({ id: "config:codex-plugins", status: "planned" }),
      ]),
    );
    expect(
      selected.items.find((item) => item.id === "config:codex-plugins")?.details?.value,
    ).toMatchObject({
      config: {
        codexPlugins: {
          plugins: {
            "google-calendar": {
              enabled: true,
              marketplaceName: "openai-curated",
              pluginName: "google-calendar",
            },
          },
        },
      },
    });
    expect(
      Object.keys(
        (
          (
            (
              selected.items.find((item) => item.id === "config:codex-plugins")?.details
                ?.value as Record<string, unknown>
            ).config as Record<string, unknown>
          ).codexPlugins as Record<string, unknown>
        ).plugins as Record<string, unknown>,
      ),
    ).toEqual(["google-calendar"]);
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

    expect(selected.summary).toMatchObject({ planned: 0, skipped: 3, conflicts: 0 });
    expect(selected.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "plugin:google-calendar",
          status: "skipped",
          reason: MIGRATION_PLUGIN_NOT_SELECTED_REASON,
        }),
        expect.objectContaining({
          id: "plugin:gmail",
          status: "skipped",
          reason: MIGRATION_PLUGIN_NOT_SELECTED_REASON,
        }),
        expect.objectContaining({
          id: "config:codex-plugins",
          status: "skipped",
          reason: MIGRATION_PLUGIN_NOT_SELECTED_REASON,
        }),
      ]),
    );
  });

  it("accepts item ids as non-interactive plugin selectors", () => {
    const selected = applyMigrationPluginSelection(
      plan([pluginItem({ id: "plugin:google-calendar", name: "google-calendar" })]),
      ["plugin:google-calendar"],
    );

    expect(selected.items).toEqual([
      expect.objectContaining({ id: "plugin:google-calendar", status: "planned" }),
    ]);
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
