import { describe, expect, it } from "vitest";
import {
  findExpiredDeprecatedDoctorRecords,
  main,
} from "../../scripts/check-doctor-deprecation-registry.js";
import { listDoctorDeprecationCompatRecords } from "../../src/commands/doctor/shared/deprecation-compat.js";
import { createCapturedIo } from "../helpers/captured-io.js";

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

  it("prints every offending code and date with actionable guidance", () => {
    const asOf = "9999-12-31";
    const offenders = findExpiredDeprecatedDoctorRecords(
      listDoctorDeprecationCompatRecords(),
      asOf,
    );
    const { io, readStderr } = createCapturedIo();
    const exitCode = main(["--as-of", asOf], io);
    const stderr = readStderr();

    expect(offenders.length).toBeGreaterThan(0);
    expect(exitCode).toBe(1);
    for (const offender of offenders) {
      expect(stderr).toContain(`${offender.code}: removeAfter ${offender.removeAfter}`);
    }
    expect(stderr).toContain("Remove each migration after supported-upgrade proof");
    expect(stderr).toContain("move it to removal-pending with a documented blocker");
  });
});
