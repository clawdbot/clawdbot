import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { findExpiredDeprecatedDoctorRecords } from "../../scripts/check-doctor-deprecation-registry.js";
import { listDoctorDeprecationCompatRecords } from "../../src/commands/doctor/shared/deprecation-compat.js";

const deadlineRecord = {
  code: "doctor-test-deadline",
  status: "deprecated",
  removeAfter: "2026-07-26",
} as const;

describe("doctor deprecation registry guard", () => {
  it.each([
    ["before", "2026-07-25", 0],
    ["on", "2026-07-26", 1],
    ["after", "2026-07-27", 1],
  ])("handles the %s-deadline date", (_label, asOf, expectedCount) => {
    expect(findExpiredDeprecatedDoctorRecords([deadlineRecord], asOf)).toHaveLength(expectedCount);
  });

  it("leaves removal-pending records in the explicit review queue", () => {
    expect(
      findExpiredDeprecatedDoctorRecords(
        [{ ...deadlineRecord, status: "removal-pending" }],
        "2026-08-08",
      ),
    ).toEqual([]);
  });

  it("keeps the real registry current as of 2026-08-08", () => {
    const records = listDoctorDeprecationCompatRecords();
    const removalPending = records.filter((record) => record.status === "removal-pending");

    expect(records).toHaveLength(43);
    expect(removalPending).toHaveLength(23);
    expect(new Set(removalPending.map((record) => record.removeAfter))).toEqual(
      new Set(["2026-07-26"]),
    );
    expect(findExpiredDeprecatedDoctorRecords(records, "2026-08-08")).toEqual([]);
  });

  it("prints every offending code and date with actionable guidance", () => {
    const asOf = "9999-12-31";
    const offenders = findExpiredDeprecatedDoctorRecords(
      listDoctorDeprecationCompatRecords(),
      asOf,
    );
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/check-doctor-deprecation-registry.ts", "--as-of", asOf],
      { encoding: "utf8" },
    );

    expect(offenders.length).toBeGreaterThan(0);
    expect(result.status).toBe(1);
    for (const offender of offenders) {
      expect(result.stderr).toContain(`${offender.code}: removeAfter ${offender.removeAfter}`);
    }
    expect(result.stderr).toContain("Remove each migration after supported-upgrade proof");
    expect(result.stderr).toContain("move it to removal-pending with a documented blocker");
  });
});
