// Covers the manifest-schema boundary that keeps third-party schema failures out of the loader.
import { describe, expect, it } from "vitest";
import { validatePluginSchemaValue } from "./schema-validator.js";
describe("validatePluginSchemaValue", () => {
  it("returns an error instead of throwing for a structurally invalid schema", () => {
    const result = validatePluginSchemaValue({
      origin: "global",
      cacheKey: "manifest-schema.unresolved-ref",
      schema: { type: "object", properties: { mode: { $ref: "#/$defs/Mode" } } },
      value: {},
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.errors[0]?.text).toContain("invalid schema");
  });

  it("strips terminal control characters a manifest embedded in the thrown text", () => {
    const escape = String.fromCharCode(27);
    const result = validatePluginSchemaValue({
      origin: "global",
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
    const result = validatePluginSchemaValue({
      origin: "global",
      cacheKey: "manifest-schema.valid",
      schema: { type: "object", properties: { a: { type: "string" } } },
      value: { a: "ok" },
    });

    expect(result).toEqual({ ok: true, value: { a: "ok" } });
  });

  it("flags schemaError only when the schema itself is unusable, not on ordinary value failures", () => {
    const malformedSchema = validatePluginSchemaValue({
      origin: "global",
      cacheKey: "manifest-schema.schema-error-flag",
      schema: { type: "object", properties: { mode: { $ref: "#/$defs/Mode" } } },
      value: {},
    });
    expect(malformedSchema).toMatchObject({ ok: false, schemaError: true });

    const wellFormedSchemaRejectingValue = validatePluginSchemaValue({
      origin: "global",
      cacheKey: "manifest-schema.value-error-flag",
      schema: { type: "object", required: ["token"], properties: { token: { type: "string" } } },
      value: {},
    });
    expect(wellFormedSchemaRejectingValue).toMatchObject({ ok: false, schemaError: false });
  });
});
