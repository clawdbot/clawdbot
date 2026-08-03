// Normalization Core tests cover record coerce behavior.
import { readFileSync } from "node:fs";
import path from "node:path";
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

  it("stays isolated from utils.ts so browser bundles stay Node-free", () => {
    const source = readFileSync(
      path.resolve("packages/normalization-core/src/record-coerce.ts"),
      "utf8",
    );

    expect(source).not.toContain("../utils.js");
  });
});
