// Migration output tests cover preview and apply result formatting plus conflict validation.
import { describe, expect, it } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import type { MigrationItem, MigrationPlan } from "../../plugins/types.js";
import { formatMigrationPreview, formatMigrationResult } from "./output.js";

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

function configItem(): MigrationItem {
  return {
    id: "config:codex-plugins-root",
    kind: "config",
    action: "update",
    status: "planned",
  };
}

function fakeSecret(label: string): string {
  return ["sk", label, "secret", "12345678"].join("-");
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

describe("formatMigrationPreview", () => {
  it("groups items under per-kind headings", () => {
    const output = formatMigrationPreview(
      plan([skillItem(1), pluginItem("google-calendar"), pluginItem("gmail")]),
    )
      .map(stripAnsi)
      .join("\n");

    expect(output).toContain("Skills:");
    expect(output).toContain("Plugins:");
    expect(output).not.toContain("Native Codex plugins:");
    expect(output).toContain("• skill-1");
    expect(output).toContain("• google-calendar");
    expect(output).toContain("• gmail");
  });

  it("hides config items from display and excludes them from the count", () => {
    const output = formatMigrationPreview(plan([skillItem(1), configItem()]))
      .map(stripAnsi)
      .join("\n");

    expect(output).toContain("1 item, 0 conflicts, 0 sensitive items");
    expect(output).not.toContain("Config:");
    expect(output).not.toContain("codex-plugins-root");
  });

  it("counts hidden config conflicts in the preview header", () => {
    const output = formatMigrationPreview({
      ...plan([skillItem(1), { ...configItem(), status: "conflict", sensitive: true }]),
      summary: {
        total: 2,
        planned: 1,
        migrated: 0,
        skipped: 0,
        conflicts: 1,
        errors: 0,
        sensitive: 1,
      },
    })
      .map(stripAnsi)
      .join("\n");

    expect(output).toContain("1 item, 1 conflict, 1 sensitive item");
    expect(output).not.toContain("Config:");
    expect(output).not.toContain("codex-plugins-root");
  });

  it("renders migration warnings with a warning glyph", () => {
    const output = formatMigrationPreview({
      ...plan([skillItem(1)]),
      warnings: [
        "Some Codex plugins could not be migrated. Run `openclaw migrate codex` after onboarding.",
      ],
    })
      .map(stripAnsi)
      .join("\n");

    expect(output).toContain(
      "⚠️  Some Codex plugins could not be migrated. Run `openclaw migrate codex` after onboarding.",
    );
  });

  it("redacts secrets from item text and warnings", () => {
    const secret = fakeSecret("preview");
    const output = formatMigrationPreview({
      ...plan([
        {
          ...pluginItem("google-calendar"),
          status: "error",
          reason: `Provider rejected ${secret}`,
        },
      ]),
      warnings: [`Retry with Bearer ${secret}`],
    })
      .map(stripAnsi)
      .join("\n");

    expect(output).not.toContain(secret);
    expect(output).toContain("[redacted]");
  });
});

describe("formatMigrationResult", () => {
  it("renders a check glyph and (Migrated) for migrated items", () => {
    const output = formatMigrationResult(plan([{ ...skillItem(1), status: "migrated" }]))
      .map(stripAnsi)
      .join("\n");

    expect(output).toContain("✅");
    expect(output).toContain("(Migrated)");
  });

  it("humanizes known error reason codes", () => {
    const output = formatMigrationResult(
      plan([{ ...pluginItem("google-calendar"), status: "error", reason: "plugin_missing" }]),
    )
      .map(stripAnsi)
      .join("\n");

    expect(output).toContain("❌");
    expect(output).toContain("Plugin not found in the Codex marketplace");
  });

  it("renders warning plugin items under the plugin section", () => {
    const output = formatMigrationResult(
      plan([
        {
          ...pluginItem("google-calendar"),
          status: "warning",
          reason: "marketplace_missing",
          message: 'Codex plugin "google-calendar" could not be migrated automatically',
        },
      ]),
    )
      .map(stripAnsi)
      .join("\n");

    expect(output).toContain("Plugins:");
    expect(output).not.toContain("Manual review:");
    expect(output).toContain("⚠️");
    expect(output).toContain(
      'google-calendar (Codex plugin "google-calendar" could not be migrated automatically)',
    );
  });

  it("renders warning-backed next steps with a warning glyph", () => {
    const warning =
      "Some Codex plugins could not be migrated. Run `openclaw migrate codex` after onboarding.";
    const output = formatMigrationResult({
      ...plan([{ ...pluginItem("google-calendar"), status: "warning" }]),
      warnings: [warning],
      nextSteps: [warning, "Run openclaw doctor after applying the migration."],
    })
      .map(stripAnsi)
      .join("\n");

    expect(output).toContain(`⚠️  ${warning}`);
    expect(output).toContain("• Run openclaw doctor after applying the migration.");
  });

  it("says (Skipped) for user-deselected skill/plugin items", () => {
    const output = formatMigrationResult(
      plan([{ ...skillItem(1), status: "skipped", reason: "not selected for migration" }]),
    )
      .map(stripAnsi)
      .join("\n");

    expect(output).toContain("(Skipped)");
  });

  it("redacts secrets from item text and next steps", () => {
    const secret = fakeSecret("result");
    const output = formatMigrationResult({
      ...plan([
        {
          ...pluginItem("google-calendar"),
          status: "warning",
          message: `Provider returned Bearer ${secret}`,
        },
      ]),
      nextSteps: [`Save ${secret} for retry`],
    })
      .map(stripAnsi)
      .join("\n");

    expect(output).not.toContain(secret);
    expect(output).toContain("[redacted]");
  });
});
