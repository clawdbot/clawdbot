import { describe, expect, it } from "vitest";
import { projectAnthropicTools } from "./anthropic-tool-projection.js";

describe("projectAnthropicTools", () => {
  it("keeps projected wire tools identical across discovery orders", () => {
    const tools = [
      {
        name: "ZuluLookup",
        description: "Look up the last value",
        parameters: { type: "object", properties: { value: { type: "string" } } },
      },
      {
        name: "AlphaLookup",
        description: "Look up the first value",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    ];
    const toWireName = (name: string) => name.toLowerCase();

    const first = projectAnthropicTools(tools, toWireName);
    const reversed = projectAnthropicTools(tools.toReversed(), toWireName);

    expect(first.tools.map((tool) => tool.wireName)).toEqual(["alphalookup", "zululookup"]);
    expect(reversed.tools).toEqual(first.tools);
  });

  it("retains same-original duplicates while sorting their descriptions", () => {
    const projection = projectAnthropicTools(
      ["Zulu", "Alpha"].map((description) => ({
        name: "Read",
        description,
        parameters: { type: "object", properties: {} },
      })),
      (name) => name.toLowerCase(),
    );

    expect(projection.inputToolCount).toBe(2);
    expect(projection.unavailableOriginalNames).toEqual(new Set());
    expect(projection.tools).toEqual([
      {
        originalName: "Read",
        wireName: "read",
        description: "Alpha",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        originalName: "Read",
        wireName: "read",
        description: "Zulu",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ]);
  });

  it.each([
    { names: ["Read", "Read", "read"], first: "Read", last: "read" },
    { names: ["read", "read", "Read"], first: "read", last: "Read" },
  ])(
    "keeps the first accepted spelling in a collision after $first duplicates",
    ({ names, first, last }) => {
      expect(() =>
        projectAnthropicTools(
          names.map((name) => ({ name, description: name, parameters: { type: "object" } })),
          () => "Read",
        ),
      ).toThrow(`Anthropic tool names "${first}" and "${last}" both map to "Read"`);
    },
  );

  it.each([
    { name: "implicit dialect", dialect: undefined, definitionsKey: "$defs" },
    {
      name: "explicit draft-07",
      dialect: "http://json-schema.org/draft-07/schema#",
      definitionsKey: "definitions",
    },
  ])(
    "preserves root constraints and tuple definitions for $name",
    ({ dialect, definitionsKey }) => {
      const parameters = {
        ...(dialect ? { $schema: dialect } : {}),
        type: "object",
        properties: { range: { $ref: `#/${definitionsKey}/Range` } },
        required: ["range"],
        additionalProperties: false,
        allOf: [{ propertyNames: { enum: ["range"] } }],
        [definitionsKey]: {
          Range: {
            ...(dialect ? { $schema: dialect } : {}),
            type: "array",
            items: [{ type: "integer" }, { type: "integer" }],
            additionalItems: false,
          },
        },
      };
      const original = structuredClone(parameters);
      const projection = projectAnthropicTools(
        [{ name: "select_range", description: "Select a range", parameters }],
        (name) => name,
      );

      expect(projection.tools[0]?.inputSchema).toEqual({
        type: "object",
        properties: parameters.properties,
        required: ["range"],
        additionalProperties: false,
        allOf: parameters.allOf,
        [definitionsKey]: {
          Range: {
            type: "array",
            prefixItems: [{ type: "integer" }, { type: "integer" }],
            items: false,
          },
        },
      });
      expect(parameters).toEqual(original);
    },
  );

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
      $schema: "http://json-schema.org/draft-07/schema#",
      items: ["first", "second"],
      additionalItems: false,
    };
    const projection = projectAnthropicTools(
      [
        {
          name: "Match",
          description: "Match a literal value",
          parameters: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
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
    expect(projection.tools[0]?.inputSchema.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
  });
});
