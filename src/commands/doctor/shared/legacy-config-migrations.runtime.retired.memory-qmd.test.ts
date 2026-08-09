import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";

function applyRetired(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}

describe("retired QMD memory config migration", () => {
  it("reports every retired QMD memory config scope", () => {
    const issues = findLegacyConfigIssues({
      memory: {
        backend: "builtin",
        qmd: {},
        search: { qmd: { extraCollections: [] } },
      },
      agents: {
        defaults: { memory: { search: { qmd: {} } } },
        entries: { research: { memory: { search: { qmd: {} } } } },
        list: [{ id: "legacy", memory: { search: { qmd: {} } } }],
      },
    });

    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "memory.backend",
        "memory.qmd",
        "memory.search.qmd",
        "agents.defaults.memory.search.qmd",
        "agents.entries",
        "agents.list",
      ]),
    );
    expect(issues.every((issue) => issue.message.includes("doctor --fix"))).toBe(true);
  });

  it("removes retired QMD config while preserving builtin memory siblings", () => {
    const result = applyRetired({
      memory: {
        backend: "qmd",
        citations: "on",
        qmd: { sessions: { enabled: true } },
        search: { provider: "openai", qmd: { extraCollections: [{ path: "/tmp/shared" }] } },
      },
      agents: {
        defaults: {
          memory: { search: { extraPaths: ["notes"], qmd: { extraCollections: [] } } },
        },
        entries: {
          research: { memory: { search: { enabled: false, qmd: { extraCollections: [] } } } },
        },
        list: [{ id: "legacy", memory: { search: { qmd: {} } } }],
      },
    });

    expect(result.raw).not.toHaveProperty("memory.backend");
    expect(result.raw).not.toHaveProperty("memory.qmd");
    expect(result.raw).not.toHaveProperty("memory.search.qmd");
    expect(result.raw).not.toHaveProperty("agents.defaults.memory.search.qmd");
    expect(result.raw).not.toHaveProperty("agents.entries.research.memory.search.qmd");
    expect(result.raw).not.toHaveProperty("agents.list.0.memory.search.qmd");
    expect(result.raw).toHaveProperty("memory.citations", "on");
    expect(result.raw).toHaveProperty("memory.search.provider", "openai");
    expect(result.raw).toHaveProperty("agents.defaults.memory.search.extraPaths", ["notes"]);
    expect(result.raw).toHaveProperty("agents.entries.research.memory.search.enabled", false);
    expect(result.changes).toContain(
      "Removed retired QMD memory configuration; builtin memory is now the only memory engine.",
    );
  });
});
