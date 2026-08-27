import { describe, expect, it } from "vitest";
import { stripUnsupportedSchemaKeywords } from "./schema-keyword-strip.js";

describe("stripUnsupportedSchemaKeywords", () => {
  it("strips unsupported keywords nested under additionalProperties", () => {
    const schema = {
      type: "object",
      additionalProperties: { type: "string", maxLength: 100 },
    };

    const result = stripUnsupportedSchemaKeywords(schema, new Set(["maxLength"]));

    expect(result).toEqual({
      type: "object",
      additionalProperties: { type: "string" },
    });
  });

  it("strips unsupported keywords nested under prefixItems", () => {
    const schema = {
      type: "array",
      prefixItems: [{ type: "string", minLength: 2 }],
    };

    const result = stripUnsupportedSchemaKeywords(schema, new Set(["minLength"]));

    expect(result).toEqual({
      type: "array",
      prefixItems: [{ type: "string" }],
    });
  });

  it("strips unsupported keywords nested under patternProperties", () => {
    const schema = {
      type: "object",
      patternProperties: { "^x-": { type: "array", maxItems: 3 } },
    };

    const result = stripUnsupportedSchemaKeywords(schema, new Set(["maxItems"]));

    expect(result).toEqual({
      type: "object",
      patternProperties: { "^x-": { type: "array" } },
    });
  });

  it("strips schema dependencies without changing property dependency arrays", () => {
    const schema = {
      type: "object",
      dependencies: {
        payload: { type: "string", maxLength: 100 },
        billingAddress: ["creditCard"],
      },
    };

    const result = stripUnsupportedSchemaKeywords(schema, new Set(["maxLength"]));

    expect(result).toEqual({
      type: "object",
      dependencies: {
        payload: { type: "string" },
        billingAddress: ["creditCard"],
      },
    });
  });

  it.each([
    "additionalItems",
    "contentSchema",
    "unevaluatedItems",
    "unevaluatedProperties",
  ] as const)("strips unsupported keywords nested under %s", (container) => {
    const schema = {
      type: "object",
      [container]: { type: "string", maxLength: 100 },
    };

    const result = stripUnsupportedSchemaKeywords(schema, new Set(["maxLength"]));

    expect(result).toEqual({
      type: "object",
      [container]: { type: "string" },
    });
  });

  it("preserves boolean schemas and non-schema object values", () => {
    const schema = {
      type: "object",
      additionalProperties: true,
      unevaluatedItems: false,
      default: { maxLength: 100 },
      examples: [{ maxLength: 100 }],
      metadata: { maxLength: 100 },
    };

    expect(stripUnsupportedSchemaKeywords(schema, new Set(["maxLength"]))).toEqual(schema);
  });
});
