import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

const ZERO_DURATIONS = [0, "0", "0ms", "0s", "0m", "0h", "0d", "0.0h", "0h0m"];

type MaintenanceKey = "pruneAfter" | "resetArchiveRetention";

function configWith(key: MaintenanceKey, value: unknown) {
  return { session: { maintenance: { [key]: value } } };
}

describe.each([
  { key: "pruneAfter" as const, outcome: "30d" },
  { key: "resetArchiveRetention" as const, outcome: "keep-by-default" },
])("session.maintenance.$key zero-duration migration", ({ key, outcome }) => {
  it.each(ZERO_DURATIONS)("detects and removes %s", (value) => {
    const raw = configWith(key, value);
    const issues = findLegacyConfigIssues(raw);

    expect(issues.some((issue) => issue.message.includes(key))).toBe(true);

    const result = applyLegacyDoctorMigrations(raw);
    expect(result.next?.session).toEqual({ maintenance: {} });
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toContain(key);
    expect(result.changes[0]).toContain(outcome);
    expect(applyLegacyDoctorMigrations(result.next)).toEqual({ next: null, changes: [] });
  });

  it.each(["500ms", "24h", "30d", 30])("preserves positive duration %s", (value) => {
    const raw = configWith(key, value);
    expect(findLegacyConfigIssues(raw).some((issue) => issue.message.includes(key))).toBe(false);
    expect(applyLegacyDoctorMigrations(raw)).toEqual({ next: null, changes: [] });
  });

  it("leaves invalid values for schema validation", () => {
    const raw = configWith(key, "invalid");
    expect(findLegacyConfigIssues(raw).some((issue) => issue.message.includes(key))).toBe(false);
    expect(applyLegacyDoctorMigrations(raw)).toEqual({ next: null, changes: [] });
  });
});

describe("session maintenance zero-duration migration interactions", () => {
  it("preserves the documented reset archive disable value", () => {
    const raw = configWith("resetArchiveRetention", false);
    expect(findLegacyConfigIssues(raw)).toEqual([]);
    expect(applyLegacyDoctorMigrations(raw)).toEqual({ next: null, changes: [] });
  });

  it("removes both zero durations in one pass", () => {
    const raw = {
      session: { maintenance: { pruneAfter: 0, resetArchiveRetention: "0h" } },
    };
    const result = applyLegacyDoctorMigrations(raw);

    expect(result.next?.session).toEqual({ maintenance: {} });
    expect(result.changes).toHaveLength(2);
    expect(result.changes.join("\n")).toContain("30d");
    expect(result.changes.join("\n")).toContain("keep-by-default");
  });

  it("removes only the zero field", () => {
    const raw = {
      session: { maintenance: { pruneAfter: "0h", resetArchiveRetention: "30d" } },
    };
    const result = applyLegacyDoctorMigrations(raw);

    expect(result.next?.session).toEqual({
      maintenance: { resetArchiveRetention: "30d" },
    });
    expect(result.changes).toHaveLength(1);
  });
});
