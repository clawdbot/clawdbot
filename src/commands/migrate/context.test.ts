// Migration context tests cover report directory naming and timestamp fallback behavior.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildMigrationReportDir } from "./context.js";

describe("migration context helpers", () => {
  it("builds report directories with filename-safe timestamps", () => {
    const now = Date.parse("2026-02-23T12:34:56.000Z");
    expect(buildMigrationReportDir("codex", "/state", now)).toBe(
      path.join("/state", "migration", "codex", "2026-02-23T12-34-56.000Z"),
    );
  });

  it("falls back instead of throwing for out-of-range report timestamps", () => {
    expect(buildMigrationReportDir("codex", "/state", 9_000_000_000_000_000)).toMatch(
      /[/\\]migration[/\\]codex[/\\]\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/,
    );
  });
});
