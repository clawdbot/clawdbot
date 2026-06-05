// Verifies OpenAI strict tool schema normalization and cache behavior.
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearOpenAIToolSchemaCacheForTest,
  isStrictOpenAIJsonSchemaCompatible,
  normalizeStrictOpenAIJsonSchema,
  resolveOpenAIStrictToolFlagForInventory,
} from "./openai-tool-schema.js";

describe("OpenAI strict tool schema normalization", () => {
  beforeEach(() => {
    clearOpenAIToolSchemaCacheForTest();
  });

  it("repairs top-level object schemas with missing or invalid properties", () => {
    const schemas = [
      { type: "object" },
      { type: "object", properties: undefined },
      { type: "object", properties: null },
      { type: "object", properties: [] },
      { type: "object", properties: "invalid" },
    ];

    for (const schema of schemas) {
      expect(normalizeStrictOpenAIJsonSchema(schema)).toEqual({
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      });
      expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
      expect(
        resolveOpenAIStrictToolFlagForInventory([{ name: "empty", parameters: schema }], true),
      ).toBe(true);
    }
  });

  it("does not close permissive nested object schemas implicitly", () => {
    // Nested permissive objects stay incompatible unless callers make them strict.
    const schema = {
      type: "object",
      properties: {
        metadata: {
          type: "object",
        },
      },
      required: ["metadata"],
    };

    const normalized = normalizeStrictOpenAIJsonSchema(schema) as {
      additionalProperties?: boolean;
      properties?: { metadata?: { additionalProperties?: boolean } };
    };

    expect(normalized.additionalProperties).toBe(false);
    expect(normalized.properties?.metadata).not.toHaveProperty("additionalProperties");
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(false);
    expect(
      resolveOpenAIStrictToolFlagForInventory([{ name: "write", parameters: schema }], true),
    ).toBe(false);
  });

  it("normalizes truly empty MCP tool schema {} for strict mode", () => {
    const schema = {};
    const normalized = normalizeStrictOpenAIJsonSchema(schema) as Record<string, unknown>;
    expect(normalized.type).toBe("object");
    expect(normalized.properties).toStrictEqual({});
    expect(normalized.required).toStrictEqual([]);
    expect(normalized.additionalProperties).toBe(false);
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
  });

  it("reuses normalized strict schemas for stable tool schema objects", () => {
    // Cache keys include unsupported-keyword policy, not just object identity.
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    };

    const first = normalizeStrictOpenAIJsonSchema(schema);
    const second = normalizeStrictOpenAIJsonSchema(schema);
    const third = normalizeStrictOpenAIJsonSchema(schema, {
      unsupportedToolSchemaKeywords: ["minimum"],
    });

    expect(second).toBe(first);
    expect(third).not.toBe(first);
    expect(
      normalizeStrictOpenAIJsonSchema(schema, {
        unsupportedToolSchemaKeywords: ["minimum"],
      }),
    ).toBe(third);
  });
});
