// Covers the manifest-schema boundary that keeps third-party schema failures out of the loader.
import { describe, expect, it } from "vitest";
import { validateManifestSchemaValue } from "./schema-validator.js";
describe("validateManifestSchemaValue", () => {
  it("returns an error instead of throwing for a structurally invalid schema", () => {
    const result = validateManifestSchemaValue({
      cacheKey: "manifest-schema.unresolved-ref",
      schema: { type: "object", properties: { mode: { $ref: "#/$defs/Mode" } } },
      value: {},
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.errors[0]?.text).toContain("invalid schema");
  });

  it("strips terminal control characters a manifest embedded in the thrown text", () => {
    const escape = String.fromCharCode(27);
    const result = validateManifestSchemaValue({
      cacheKey: "manifest-schema.ansi-pattern",
      schema: {
        type: "object",
        properties: { a: { type: "string", pattern: `${escape}[31m(unclosed` } },
      },
      value: { a: "x" },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.errors[0]?.text).not.toContain(escape);
  });

  it("keeps returning results for a valid schema", () => {
    const result = validateManifestSchemaValue({
      cacheKey: "manifest-schema.valid",
      schema: { type: "object", properties: { a: { type: "string" } } },
      value: { a: "ok" },
    });

    expect(result).toEqual({ ok: true, value: { a: "ok" } });
  });
});
