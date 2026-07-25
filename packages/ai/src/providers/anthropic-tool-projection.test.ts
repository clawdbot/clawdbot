import { describe, expect, it } from "vitest";
import { projectAnthropicTools } from "./anthropic-tool-projection.js";

describe("projectAnthropicTools", () => {
  it("converts draft-07 tuple items to draft 2020-12 prefixItems for Anthropic", () => {
    const projection = projectAnthropicTools(
      [
        {
          name: "Edit",
          description: "Apply an edit",
          parameters: {
            type: "object",
            properties: {
              ranges: {
                type: "array",
                items: [
                  { type: "integer", minimum: 0 },
                  { type: "integer", minimum: 0 },
                ],
                additionalItems: false,
              },
            },
            required: ["ranges"],
          },
        },
      ],
      (name) => name,
    );

    expect(projection.unavailableOriginalNames.size).toBe(0);
    expect(projection.tools).toHaveLength(1);
    expect(projection.tools[0]?.inputSchema).toEqual({
      type: "object",
      properties: {
        ranges: {
          type: "array",
          prefixItems: [
            { type: "integer", minimum: 0 },
            { type: "integer", minimum: 0 },
          ],
          items: false,
        },
      },
      required: ["ranges"],
    });
  });

  it("normalizes nested draft-07 tuple schemas without mutating the original descriptor", () => {
    const tupleSchema = {
      type: "object",
      properties: {
        patch: {
          type: "object",
          properties: {
            spans: {
              type: "array",
              items: [{ type: "string" }],
              additionalItems: { type: "number" },
            },
          },
        },
      },
    };

    const projection = projectAnthropicTools(
      [
        {
          name: "Write",
          description: "Write a file",
          parameters: tupleSchema,
        },
      ],
      (name) => name,
    );

    expect(projection.tools[0]?.inputSchema.properties.patch).toEqual({
      type: "object",
      properties: {
        spans: {
          type: "array",
          prefixItems: [{ type: "string" }],
          items: { type: "number" },
        },
      },
    });
    expect(tupleSchema.properties.patch.properties.spans).toEqual({
      type: "array",
      items: [{ type: "string" }],
      additionalItems: { type: "number" },
    });
  });

  it("quarantines Anthropic tools with non-finite numeric schema values", () => {
    const projection = projectAnthropicTools(
      [
        {
          name: "BadLimits",
          description: "Read a numeric value",
          parameters: {
            type: "object",
            properties: {
              amount: { type: "number", maximum: Number.POSITIVE_INFINITY },
            },
          },
        },
        {
          name: "Lookup",
          description: "Lookup a value",
          parameters: { type: "object", properties: {} },
        },
      ],
      (name) => name.toLowerCase(),
    );

    expect(projection.tools).toHaveLength(1);
    expect(projection.tools[0]?.wireName).toBe("lookup");
    expect(projection.unavailableOriginalNames).toEqual(new Set(["BadLimits"]));
  });

  it("does not rewrite instance data that resembles a tuple schema", () => {
    const tupleLikeValue = {
      items: ["first", "second"],
      additionalItems: false,
    };
    const projection = projectAnthropicTools(
      [
        {
          name: "Match",
          description: "Match a literal value",
          parameters: {
            type: "object",
            properties: {
              value: {
                const: tupleLikeValue,
                default: tupleLikeValue,
              },
            },
          },
        },
      ],
      (name) => name,
    );

    expect(projection.tools[0]?.inputSchema.properties.value).toEqual({
      const: tupleLikeValue,
      default: tupleLikeValue,
    });
  });
});
