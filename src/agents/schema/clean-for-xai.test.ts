// xAI schema tests lock the live-supported JSON Schema bounds used by tools.
import { normalizeToolParameterSchema } from "@openclaw/ai/internal/openai";
import { describe, expect, it } from "vitest";

describe("xAI tool schema compatibility", () => {
  it("preserves supported bounds while stripping documented contains-count bounds", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64 },
        tags: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: { type: "string", minLength: 2, maxLength: 20 },
          contains: { const: "required" },
          minContains: 1,
          maxContains: 1,
        },
      },
      required: ["name", "tags"],
      additionalProperties: false,
    };

    expect(
      normalizeToolParameterSchema(schema, {
        modelProvider: "xai",
        modelCompat: {
          toolSchemaProfile: "xai",
          unsupportedToolSchemaKeywords: ["minContains", "maxContains"],
        },
      }),
    ).toEqual({
      ...schema,
      properties: {
        ...schema.properties,
        tags: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: { type: "string", minLength: 2, maxLength: 20 },
          contains: { const: "required" },
        },
      },
    });
  });
});
