import { describe, expect, it } from "vitest";
import {
  getPluginCompatRecord,
  isPluginCompatCode,
  listDeprecatedPluginCompatRecords,
  listPluginCompatRecords,
} from "./registry.js";

const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

describe("plugin compatibility registry", () => {
  it("keeps compatibility codes unique and lookup-safe", () => {
    const records = listPluginCompatRecords();
    const codes = records.map((record) => record.code);

    expect(new Set(codes).size).toBe(codes.length);
    expect(isPluginCompatCode("legacy-root-sdk-import")).toBe(true);
    expect(isPluginCompatCode("missing-code")).toBe(false);
    expect(getPluginCompatRecord("legacy-root-sdk-import").owner).toBe("sdk");
  });

  it("requires dated deprecation metadata for deprecated records", () => {
    for (const record of listDeprecatedPluginCompatRecords()) {
      expect(record.deprecated, record.code).toMatch(datePattern);
      expect(record.warningStarts, record.code).toMatch(datePattern);
      expect(record.replacement, record.code).toBeTruthy();
      expect(record.docsPath, record.code).toMatch(/^\//u);
    }
  });

  it("keeps every record actionable", () => {
    for (const record of listPluginCompatRecords()) {
      expect(record.introduced, record.code).toMatch(datePattern);
      expect(record.docsPath, record.code).toMatch(/^\//u);
      expect(record.surfaces.length, record.code).toBeGreaterThan(0);
      expect(record.diagnostics.length, record.code).toBeGreaterThan(0);
      expect(record.tests.length, record.code).toBeGreaterThan(0);
    }
  });
});
