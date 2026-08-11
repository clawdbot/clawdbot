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
        qmd: {
          sessions: { enabled: true },
          paths: [
            { path: "/tmp/global" },
            { path: "/tmp/patterned", pattern: "notes/*.md" },
            { path: " /tmp/shared ", pattern: "**/*.md" },
            { path: " " },
          ],
        },
        search: {
          provider: "openai",
          extraPaths: ["notes", "/tmp/shared"],
          qmd: { extraCollections: [{ path: "/tmp/search" }] },
        },
      },
      agents: {
        defaults: {
          memory: {
            search: {
              extraPaths: ["notes"],
              qmd: { extraCollections: [{ path: "/tmp/defaults" }] },
            },
          },
        },
        entries: {
          research: {
            memory: {
              search: {
                enabled: false,
                extraPaths: ["/tmp/existing"],
                qmd: {
                  extraCollections: [{ path: "/tmp/research", pattern: "*.md" }],
                },
              },
            },
          },
        },
        list: [
          {
            id: "legacy",
            memory: {
              search: { qmd: { extraCollections: [{ path: "/tmp/list" }] } },
            },
          },
        ],
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
    expect(result.raw).toHaveProperty("memory.search.extraPaths", [
      "notes",
      "/tmp/shared",
      "/tmp/global",
      { path: "/tmp/patterned", pattern: "notes/*.md" },
      { path: "/tmp/shared", pattern: "**/*.md" },
      "/tmp/search",
    ]);
    expect(result.raw).toHaveProperty("agents.defaults.memory.search.extraPaths", [
      "notes",
      "/tmp/defaults",
    ]);
    expect(result.raw).toHaveProperty("agents.entries.research.memory.search.enabled", false);
    expect(result.raw).toHaveProperty("agents.entries.research.memory.search.extraPaths", [
      "/tmp/existing",
      { path: "/tmp/research", pattern: "*.md" },
    ]);
    expect(result.raw).toHaveProperty("agents.list.0.memory.search.extraPaths", ["/tmp/list"]);
    expect(result.changes).toContain(
      "Migrated 4 external QMD paths from memory.qmd.paths and memory.search.qmd.extraCollections → memory.search.extraPaths.",
    );
    expect(result.changes).toContain(
      "Removed retired QMD memory configuration; builtin memory is now the only memory engine.",
    );
    expect(applyRetired(result.raw).changes).toEqual([]);
  });
});
