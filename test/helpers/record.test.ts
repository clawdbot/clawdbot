import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";

describe("createRequireRecord", () => {
  it("preserves object assertions that allow arrays", () => {
    const requireRecord = createRequireRecord("object", "expected-label");

    expect(requireRecord([], "payload")).toEqual([]);
    expect(() => requireRecord(null, "payload")).toThrow("expected payload");
  });

  it("preserves strict record assertions and diagnostics", () => {
    const requireRecord = createRequireRecord("record", "expected-label-record");

    expect(requireRecord({ ok: true }, "payload")).toEqual({ ok: true });
    expect(() => requireRecord([], "payload")).toThrow("expected payload to be a record");
  });
});
