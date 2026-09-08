// Moonshot tests cover the "moonshot flavored json schema" tool normalization.
import { describe, expect, it } from "vitest";
import { normalizeMoonshotToolSchemas } from "./tool-schemas.js";

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

// Drives one schema through the exported provider hook that `index.ts` wires
// into, so these cases exercise the real registration path, not the internal
// walker behind it.
function normalizeSchema(parameters: unknown): unknown {
  return normalizeMoonshotToolSchemas({
    tools: [{ name: "probe", description: "", parameters }],
  } as never)[0]?.parameters;
}

describe("moonshot schema normalization", () => {
  it("moves the parent type into nested anyOf branches", () => {
    const items = itemsOf(normalizeSchema(apolloToolSchema));

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

    expect(normalizeSchema(schema)).toEqual({
      anyOf: [
        { type: "object", required: ["a"] },
        { type: "object", required: ["b"] },
      ],
    });
  });

  // JSON Schema treats `integer` as a subtype of `number`, so a branch already typed
  // `integer` must not block the rewrite under a `number` parent the way a genuinely
  // wider type (e.g. `string`) does.
  it("keeps a union already typed with a number-compatible integer subtype", () => {
    const schema = {
      type: "number",
      anyOf: [{ type: "integer", minimum: 0 }, { type: "number" }],
    };

    expect(normalizeSchema(schema)).toEqual({
      anyOf: [{ type: "integer", minimum: 0 }, { type: "number" }],
    });
  });

  it("pushes the parent type into an untyped branch alongside a compatible typed integer branch", () => {
    const schema = {
      type: "number",
      anyOf: [{ minimum: 0 }, { type: "integer" }],
    };

    expect(normalizeSchema(schema)).toEqual({
      anyOf: [{ type: "number", minimum: 0 }, { type: "integer" }],
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
    expect(normalizeSchema(schema)).toEqual(schema);
  });

  it("keeps an own hostile __proto__ key an own key", () => {
    const schema = JSON.parse(
      `{"type":"object","properties":{"entry":{"type":"object","anyOf":[
        {"required":["a"],"__proto__":{"polluted":true}},{"required":["b"]}]}}}`,
    ) as Record<string, unknown>;

    const normalized = normalizeSchema(schema) as {
      properties: { entry: { anyOf: Array<Record<string, unknown>> } };
    };
    const branch = normalized.properties.entry.anyOf[0] as Record<string, unknown>;

    expect(Object.getPrototypeOf(branch)).toBe(Object.prototype);
    expect(Object.hasOwn(branch, "__proto__")).toBe(true);
    expect(branch.type).toBe("object");
  });

  // Draft-07 `dependencies` maps a property name to either a schema or a list of
  // required property names. The schema form nests a real subschema, so a walker that
  // skips the keyword copies the rejected parent-type/untyped-anyOf shape through.
  it("normalizes schemas nested under legacy dependencies", () => {
    const normalized = normalizeSchema({
      type: "object",
      properties: { billing: { type: "string" } },
      dependencies: {
        billing: {
          type: "object",
          anyOf: [{ required: ["card"] }, { required: ["invoice"] }],
        },
      },
    }) as { dependencies: Record<string, Record<string, unknown>> };

    const nested = normalized.dependencies.billing ?? {};
    expect(nested.type).toBeUndefined();
    expect(nested.anyOf).toEqual([
      { type: "object", required: ["card"] },
      { type: "object", required: ["invoice"] },
    ]);
  });

  it("leaves the property-name-list form of dependencies untouched", () => {
    const normalized = normalizeSchema({
      type: "object",
      properties: { billing: { type: "string" } },
      dependencies: { billing: ["card", "invoice"] },
    }) as { dependencies: Record<string, unknown> };

    expect(normalized.dependencies.billing).toEqual(["card", "invoice"]);
  });

  it("leaves oneOf alone because only anyOf is evidenced by the provider error", () => {
    const schema = {
      type: "object",
      properties: { entry: { type: "object", oneOf: [{ required: ["a"] }, { required: ["b"] }] } },
    };
    expect(normalizeSchema(schema)).toEqual(schema);
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
