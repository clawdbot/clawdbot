import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "./schema-validator.js";

describe.each([true, false])("source-aware schema validation (cache=%s)", (cache) => {
  const schema = {
    type: "object",
    properties: {
      credential: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      retries: { type: "integer", default: 2 },
    },
    required: ["credential"],
  };

  it("validates persisted references and defaults the paired runtime without mutating either", () => {
    const sourceValue = { credential: { id: "KEY" } };
    const value = { credential: "resolved-fixture-key" };
    const params = {
      schema,
      cacheKey: "source-ref",
      value,
      sourceValue,
      applyDefaults: true,
      cache,
    };
    // Exercise a reused validator as well as its initial compilation.
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(validateJsonSchemaValue(params)).toEqual({
        ok: true,
        value: { ...value, retries: 2 },
      });
      expect(
        validateJsonSchemaValue({ ...params, sourceValue: { credential: "plaintext" } }).ok,
      ).toBe(false);
      expect(validateJsonSchemaValue({ ...params, sourceValue: null }).ok).toBe(false);
    }
    expect(sourceValue).toEqual({ credential: { id: "KEY" } });
    expect(value).toEqual({ credential: "resolved-fixture-key" });
  });

  it.each([true, false])(
    "preserves the runtime identity without applicable defaults (%s)",
    (applyDefaults) => {
      const value = { credential: "resolved-fixture-key" };
      const result = validateJsonSchemaValue({
        schema: { ...schema, properties: { credential: schema.properties.credential } },
        cacheKey: "source-no-defaults",
        sourceValue: { credential: { id: "KEY" } },
        value,
        applyDefaults,
        cache,
      });
      expect(result).toEqual({ ok: true, value });
      if (result.ok) {
        expect(result.value).toBe(value);
      }
    },
  );

  it("keeps the conditional-default exception tied to the source input", () => {
    const conditional = {
      ...schema,
      properties: { ...schema.properties, enabled: { type: "boolean", default: true } },
      if: { properties: { enabled: { const: true } }, required: ["enabled"] },
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema branch data, not a promise method.
      then: { required: ["confirmation"] },
    };
    const params = {
      schema: conditional,
      cacheKey: "source-conditional",
      value: { credential: "resolved-fixture-key" },
      sourceValue: { credential: { id: "KEY" } },
      applyDefaults: true,
      cache,
    };
    expect(validateJsonSchemaValue(params)).toEqual({
      ok: true,
      value: { credential: "resolved-fixture-key", retries: 2, enabled: true },
    });
    expect(
      validateJsonSchemaValue({
        ...params,
        sourceValue: { ...params.sourceValue, enabled: true },
      }).ok,
    ).toBe(false);
  });

  it.each([null, { credential: "invalid-plaintext-fixture" }])(
    "rejects invalid source even when the runtime itself matches the schema (%s)",
    (sourceValue) => {
      const result = validateJsonSchemaValue({
        schema,
        cacheKey: "source-invalid",
        sourceValue,
        value: { credential: { id: "VALID" } },
        applyDefaults: true,
        cache,
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain("invalid-plaintext-fixture");
    },
  );

  it("uses source-selected conditional defaults in nested runtime objects and arrays", () => {
    const settingsSchema = {
      ...schema,
      properties: { ...schema.properties, endpoint: { type: "string" } },
      if: { properties: { credential: { type: "object" } }, required: ["credential"] },
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema branch data, not a promise method.
      then: { properties: { endpoint: { default: "https://reference.example" } } },
      else: { properties: { endpoint: { default: "https://plaintext.example" } } },
    };
    const sourceValue = { accounts: [{ credential: { id: "KEY" } }] };
    const value = { accounts: [{ credential: "resolved-fixture-key" }] };
    expect(
      validateJsonSchemaValue({
        schema: {
          type: "object",
          properties: { accounts: { type: "array", items: settingsSchema } },
        },
        cacheKey: "source-conditional-branch",
        value,
        sourceValue,
        applyDefaults: true,
        cache,
      }),
    ).toEqual({
      ok: true,
      value: {
        accounts: [
          { credential: "resolved-fixture-key", retries: 2, endpoint: "https://reference.example" },
        ],
      },
    });
    expect(sourceValue).toEqual({ accounts: [{ credential: { id: "KEY" } }] });
    expect(value).toEqual({ accounts: [{ credential: "resolved-fixture-key" }] });
  });

  it("preserves runtime overrides and removed references while transferring source defaults", () => {
    const sourceValue = { credential: { id: "KEY" }, accounts: [{ credential: { id: "OTHER" } }] };
    const value = { retries: 9, accounts: [{ credential: "resolved-fixture-key" }] };
    const before = structuredClone({ sourceValue, value });
    expect(
      validateJsonSchemaValue({
        schema: {
          ...schema,
          properties: { ...schema.properties, accounts: { type: "array", items: schema } },
        },
        cacheKey: "source-preserve-runtime",
        value,
        sourceValue,
        applyDefaults: true,
        cache,
      }),
    ).toEqual({
      ok: true,
      value: { retries: 9, accounts: [{ credential: "resolved-fixture-key", retries: 2 }] },
    });
    expect({ sourceValue, value }).toEqual(before);
  });
});
