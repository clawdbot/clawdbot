import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";

function applyRetiredMigrations(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}

describe("automatic local-model lean migration", () => {
  it.each([
    { model: "ollama/local", localModelLean: true, expected: undefined },
    { model: { primary: "ollama/local" }, localModelLean: true, expected: undefined },
    { model: "openai/selected", localModelLean: true, expected: true },
    { model: undefined, localModelLean: true, expected: true },
    { model: "ollama/local", localModelLean: false, expected: false },
  ])("retires only proven automatic lean ownership: %j", ({ model, localModelLean, expected }) => {
    const raw = {
      wizard: { localModelLeanAutoModel: "ollama/local", lastRunVersion: "2026.9.1" },
      agents: {
        defaults: { model, experimental: { localModelLean, other: "preserved" } },
        entries: { work: { experimental: { localModelLean: true } } },
      },
    };
    const entries = structuredClone(raw.agents.entries);
    expect(findLegacyConfigIssues(raw)).toContainEqual({
      path: "wizard.localModelLeanAutoModel",
      message: expect.stringContaining('Run "openclaw doctor --fix"'),
    });

    const { changes } = applyRetiredMigrations(raw);

    expect(raw.wizard).toEqual({ lastRunVersion: "2026.9.1" });
    expect(raw.agents.defaults.experimental).toEqual({
      other: "preserved",
      ...(expected !== undefined ? { localModelLean: expected } : {}),
    });
    expect(raw.agents.entries).toEqual(entries);
    if (expected === true) {
      expect(changes).toContainEqual(expect.stringContaining("remove it or set it to false"));
    }
    expect(findLegacyConfigIssues(raw)).toEqual([]);
    expect(applyRetiredMigrations(raw).changes).toEqual([]);
  });

  it.each([undefined, false, true])(
    "leaves unmarked lean configuration unchanged: %s",
    (localModelLean) => {
      const raw = {
        agents: {
          defaults: {
            experimental: localModelLean !== undefined ? { localModelLean } : {},
          },
        },
      };
      const expected = structuredClone(raw);
      expect(findLegacyConfigIssues(raw)).toEqual([]);
      expect(applyRetiredMigrations(raw)).toEqual({ raw: expected, changes: [] });
    },
  );
});
