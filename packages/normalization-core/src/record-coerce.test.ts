// Normalization Core tests cover record coerce behavior.
import { describe, expect, it } from "vitest";
import { asNullableRecord, asOptionalRecord } from "./record-coerce.js";

describe("record-coerce", () => {
  it("keeps record coercion behavior for optional and nullable variants", () => {
    expect(asOptionalRecord({ ok: true })).toEqual({ ok: true });
    expect(asOptionalRecord(null)).toBeUndefined();
    expect(asOptionalRecord([{ ok: true }])).toBeUndefined();
    expect(asNullableRecord({ ok: true })).toEqual({ ok: true });
    expect(asNullableRecord(null)).toBeNull();
    expect(asNullableRecord([{ ok: true }])).toBeNull();
  });
});
