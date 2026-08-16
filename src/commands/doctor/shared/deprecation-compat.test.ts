// Deprecation compatibility tests cover doctor warnings and repairs for deprecated config.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { listDoctorDeprecationCompatRecords } from "./deprecation-compat.js";

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

function addUtcMonths(date: string, months: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next.toISOString().slice(0, 10);
}

const requiredDoctorCompatCodes = [
  "doctor-agent-runtime-embedded-harness",
  "doctor-agent-embedded-pi-config",
  "doctor-plugin-install-config-ledger",
  "doctor-bundled-plugin-load-paths",
  "doctor-bundled-provider-discovery-allowlist",
  "doctor-cli-backends-plugin-registration",
  "doctor-codex-supervisor-plugin-config",
  "doctor-message-queue-steering-modes",
  "doctor-web-search-plugin-config",
  "doctor-web-fetch-plugin-config",
  "doctor-x-search-plugin-config",
] as const;

describe("doctor deprecation compatibility inventory", () => {
  it("keeps compatibility codes unique", () => {
    const records = listDoctorDeprecationCompatRecords();
    const codes = new Set(records.map((record) => record.code));

    expect(codes.size).toBe(records.length);
    expect(codes.has("doctor-web-search-plugin-config")).toBe(true);
    expect(codes.has("missing-code")).toBe(false);
    expect(records.find((record) => record.code === "doctor-web-search-plugin-config")?.owner).toBe(
      "provider",
    );
  });

  it("tracks the known doctor migrations that protect plugin/config rollout", () => {
    const codes = new Set(listDoctorDeprecationCompatRecords().map((record) => record.code));
    for (const code of requiredDoctorCompatCodes) {
      expect(codes.has(code), code).toBe(true);
    }
  });

  it("keeps dated deprecation metadata in chronological order", () => {
    const records = listDoctorDeprecationCompatRecords().filter(
      (record) => record.status === "deprecated" || record.status === "removal-pending",
    );
    for (const record of records) {
      expect(record.introduced, record.code).toMatch(datePattern);
      expect(record.deprecated, record.code).toMatch(datePattern);
      expect(record.warningStarts, record.code).toMatch(datePattern);
      expect(record.removeAfter, record.code).toMatch(datePattern);
      if (!record.deprecated || !record.warningStarts || !record.removeAfter) {
        throw new Error(`${record.code} is missing deprecation window dates`);
      }
      expect(record.introduced <= record.deprecated, record.code).toBe(true);
      expect(record.deprecated <= record.warningStarts, record.code).toBe(true);
      expect(record.warningStarts <= record.removeAfter, record.code).toBe(true);
      expect(record.removeAfter <= addUtcMonths(record.warningStarts, 3), record.code).toBe(true);
    }
  });

  it("keeps every record actionable", () => {
    for (const record of listDoctorDeprecationCompatRecords()) {
      expect(record.introduced, record.code).toMatch(datePattern);
      expect(record.source, record.code).toMatch(/\S/u);
      expect(record.migration, record.code).toMatch(/\S/u);
      expect(record.replacement, record.code).toMatch(/\S/u);
      expect(record.docsPath, record.code).toMatch(/^\//u);
      expect(fs.existsSync(record.migration), `${record.code}: ${record.migration}`).toBe(true);
      expect(record.tests.length, record.code).toBeGreaterThan(0);
      for (const testPath of record.tests) {
        expect(fs.existsSync(testPath), `${record.code}: ${testPath}`).toBe(true);
      }
    }
  });
});
