// Moonshot tests cover the "moonshot flavored json schema" tool normalization.
import { describe, expect, it } from "vitest";
import { normalizeMoonshotSchema, normalizeMoonshotToolSchemas } from "./tool-schemas.js";

// The reporter's Apollo.io MCP tool shape (apollo_tasks_bulk_create) from issue #113130.
const apolloToolSchema = {
  type: "object",
  properties: {
    tasks_attributes: {
      type: "array",
      items: {
        type: "object",
        required: ["user_id", "type"],
        anyOf: [
          { required: ["contact_id"] },
          { required: ["account_id"] },
          { required: ["opportunity_id"] },
        ],
        properties: {
          user_id: { type: "string" },
          type: { type: "string" },
          contact_id: { type: "string" },
          account_id: { type: "string" },
          opportunity_id: { type: "string" },
        },
      },
    },
  },
};

function itemsOf(schema: unknown): Record<string, unknown> {
  const properties = (schema as { properties?: Record<string, { items?: unknown }> }).properties;
  return (properties?.tasks_attributes?.items ?? {}) as Record<string, unknown>;
}

describe("normalizeMoonshotSchema", () => {
  it("moves the parent type into nested anyOf branches", () => {
    const items = itemsOf(normalizeMoonshotSchema(apolloToolSchema));

    expect(items.type).toBeUndefined();
    expect(items.anyOf).toEqual([
      { type: "object", required: ["contact_id"] },
      { type: "object", required: ["account_id"] },
      { type: "object", required: ["opportunity_id"] },
    ]);
    // Sibling constraints stay on the parent node.
    expect(items.required).toEqual(["user_id", "type"]);
    expect(Object.keys(items.properties as Record<string, unknown>)).toHaveLength(5);
  });

  it("keeps a union that already types every branch", () => {
    const schema = {
      type: "object",
      anyOf: [
        { type: "object", required: ["a"] },
        { type: "object", required: ["b"] },
      ],
    };

    expect(normalizeMoonshotSchema(schema)).toEqual({
      anyOf: [
        { type: "object", required: ["a"] },
        { type: "object", required: ["b"] },
      ],
    });
  });

  it.each([
    {
      name: "a branch that is itself a union",
      node: { type: "object", anyOf: [{ anyOf: [{ required: ["a"] }] }, { required: ["b"] }] },
    },
    {
      name: "a branch declaring a wider type",
      node: { type: "object", anyOf: [{ required: ["a"] }, { type: "string" }] },
    },
    {
      name: "a $ref branch of unknown type",
      node: { type: "object", anyOf: [{ required: ["a"] }, { $ref: "#/$defs/other" }] },
    },
    {
      name: "a boolean branch",
      node: { type: "object", anyOf: [{ required: ["a"] }, true] },
    },
  ])("leaves the node as sent for $name", ({ node }) => {
    const schema = { type: "object", properties: { entry: node } };
    expect(normalizeMoonshotSchema(schema)).toEqual(schema);
  });

  it("keeps an own hostile __proto__ key an own key", () => {
    const schema = JSON.parse(
      `{"type":"object","properties":{"entry":{"type":"object","anyOf":[
        {"required":["a"],"__proto__":{"polluted":true}},{"required":["b"]}]}}}`,
    ) as Record<string, unknown>;

    const normalized = normalizeMoonshotSchema(schema) as {
      properties: { entry: { anyOf: Array<Record<string, unknown>> } };
    };
    const branch = normalized.properties.entry.anyOf[0] as Record<string, unknown>;

    expect(Object.getPrototypeOf(branch)).toBe(Object.prototype);
    expect(Object.hasOwn(branch, "__proto__")).toBe(true);
    expect(branch.type).toBe("object");
  });

  it("leaves oneOf alone because only anyOf is evidenced by the provider error", () => {
    const schema = {
      type: "object",
      properties: { entry: { type: "object", oneOf: [{ required: ["a"] }, { required: ["b"] }] } },
    };
    expect(normalizeMoonshotSchema(schema)).toEqual(schema);
  });
});

describe("normalizeMoonshotToolSchemas", () => {
  it("rewrites tool parameters and passes through parameterless tools", () => {
    const tools = [
      { name: "apollo_tasks_bulk_create", description: "", parameters: apolloToolSchema },
      { name: "no_params", description: "", parameters: undefined },
    ];

    const normalized = normalizeMoonshotToolSchemas({ tools } as never);

    expect(itemsOf(normalized[0]?.parameters).type).toBeUndefined();
    expect(normalized[1]).toBe(tools[1]);
    // The source schema is not mutated in place.
    expect(itemsOf(apolloToolSchema).type).toBe("object");
  });
});
