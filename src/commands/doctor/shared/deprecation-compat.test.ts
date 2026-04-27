import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getDoctorDeprecationCompatRecord,
  isDoctorDeprecationCompatCode,
  listDeprecatedDoctorDeprecationCompatRecords,
  listDoctorDeprecationCompatRecords,
} from "./deprecation-compat.js";

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

const requiredDoctorCompatCodes = [
  "doctor-agent-runtime-embedded-harness",
  "doctor-plugin-install-config-ledger",
  "doctor-bundled-plugin-load-paths",
  "doctor-web-search-plugin-config",
  "doctor-web-fetch-plugin-config",
  "doctor-x-search-plugin-config",
] as const;

function parseDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

function addUtcMonths(date: Date, months: number): Date {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

describe("doctor deprecation compatibility inventory", () => {
  it("keeps compatibility codes unique and lookup-safe", () => {
    const records = listDoctorDeprecationCompatRecords();
    const codes = records.map((record) => record.code);

    expect(new Set(codes).size).toBe(codes.length);
    expect(isDoctorDeprecationCompatCode("doctor-web-search-plugin-config")).toBe(true);
    expect(isDoctorDeprecationCompatCode("missing-code")).toBe(false);
    expect(getDoctorDeprecationCompatRecord("doctor-web-search-plugin-config").owner).toBe(
      "provider",
    );
  });

  it("tracks the known doctor migrations that protect plugin/config rollout", () => {
    for (const code of requiredDoctorCompatCodes) {
      expect(isDoctorDeprecationCompatCode(code), code).toBe(true);
    }
  });

  it("requires dated deprecation metadata with a three-month maximum window", () => {
    for (const record of listDeprecatedDoctorDeprecationCompatRecords()) {
      expect(record.deprecated, record.code).toMatch(datePattern);
      expect(record.warningStarts, record.code).toMatch(datePattern);
      expect(record.removeAfter, record.code).toMatch(datePattern);
      if (!record.warningStarts || !record.removeAfter) {
        throw new Error(`${record.code} is missing deprecation window dates`);
      }
      const maxRemoveAfter = addUtcMonths(parseDate(record.warningStarts), 3);
      const removeAfter = parseDate(record.removeAfter);
      expect(removeAfter <= maxRemoveAfter, record.code).toBe(true);
    }
  });

  it("keeps every record actionable", () => {
    for (const record of listDoctorDeprecationCompatRecords()) {
      expect(record.introduced, record.code).toMatch(datePattern);
      expect(record.source, record.code).toBeTruthy();
      expect(record.migration, record.code).toBeTruthy();
      expect(record.replacement, record.code).toBeTruthy();
      expect(record.docsPath, record.code).toMatch(/^\//u);
      expect(fs.existsSync(record.migration), `${record.code}: ${record.migration}`).toBe(true);
      expect(record.tests.length, record.code).toBeGreaterThan(0);
      for (const testPath of record.tests) {
        expect(fs.existsSync(testPath), `${record.code}: ${testPath}`).toBe(true);
      }
    }
  });
});
