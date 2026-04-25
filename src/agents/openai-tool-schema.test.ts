import { describe, expect, it } from "vitest";
import {
  isStrictOpenAIJsonSchemaCompatible,
  normalizeStrictOpenAIJsonSchema,
  resolveOpenAIStrictToolFlagForInventory,
} from "./openai-tool-schema.js";

describe("OpenAI strict tool schema normalization", () => {
  it("does not close permissive nested object schemas implicitly", () => {
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
});
