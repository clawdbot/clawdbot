// Verifies Moonshot flavored JSON schema normalization for tool parameters.
import { describe, expect, it } from "vitest";
import { normalizeToolParameterSchema } from "./agent-tools-parameter-schema.js";
import { cleanSchemaForMoonshot } from "./clean-for-moonshot.js";

describe("cleanSchemaForMoonshot", () => {
  it("pushes parent type into anyOf branches and drops the parent type", () => {
    const schema = {
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
      },
    };

    expect(cleanSchemaForMoonshot(schema)).toEqual({
      anyOf: [
        { required: ["contact_id"], type: "object" },
        { required: ["account_id"], type: "object" },
        { required: ["opportunity_id"], type: "object" },
      ],
      required: ["user_id", "type"],
      properties: {
        user_id: { type: "string" },
        type: { type: "string" },
      },
    });
  });

  it("recurses into nested anyOf (properties.tasks_attributes.items)", () => {
    const schema = {
      type: "object",
      properties: {
        tasks_attributes: {
          type: "array",
          items: {
            type: "object",
            required: ["user_id", "type"],
            anyOf: [{ required: ["contact_id"] }, { required: ["account_id"] }],
            properties: {
              user_id: { type: "string" },
            },
          },
        },
      },
    };

    const cleaned = cleanSchemaForMoonshot(schema) as {
      properties: {
        tasks_attributes: {
          items: { anyOf: Array<Record<string, unknown>>; type?: string };
        };
      };
    };

    expect(cleaned.properties?.tasks_attributes.items).not.toHaveProperty("type");
    expect(cleaned.properties?.tasks_attributes.items.anyOf).toEqual([
      { required: ["contact_id"], type: "object" },
      { required: ["account_id"], type: "object" },
    ]);
  });

  it("preserves branches that already declare their own type", () => {
    const schema = {
      type: "object",
      anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { required: ["b"] }],
    };

    expect(cleanSchemaForMoonshot(schema)).toEqual({
      anyOf: [
        { type: "object", properties: { a: { type: "string" } } },
        { required: ["b"], type: "object" },
      ],
    });
  });

  it("handles oneOf and allOf the same way", () => {
    const oneOfSchema = {
      type: "object",
      oneOf: [{ required: ["a"] }],
    };
    const allOfSchema = {
      type: "object",
      allOf: [{ required: ["a"] }],
    };

    expect(cleanSchemaForMoonshot(oneOfSchema)).toEqual({
      oneOf: [{ required: ["a"], type: "object" }],
    });
    expect(cleanSchemaForMoonshot(allOfSchema)).toEqual({
      allOf: [{ required: ["a"], type: "object" }],
    });
  });

  it("leaves schemas without a parent type unchanged", () => {
    const schema = {
      anyOf: [{ required: ["a"] }, { required: ["b"] }],
    };

    expect(cleanSchemaForMoonshot(schema)).toEqual(schema);
  });

  it("returns the same reference when nothing changed", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
    };

    expect(cleanSchemaForMoonshot(schema)).toBe(schema);
  });
});

describe("normalizeToolParameterSchema moonshot profile", () => {
  it("rewrites nested anyOf only for moonshot/kimi providers", () => {
    const schema = {
      type: "object",
      properties: {
        tasks_attributes: {
          type: "array",
          items: {
            type: "object",
            required: ["user_id", "type"],
            anyOf: [{ required: ["contact_id"] }, { required: ["account_id"] }],
            properties: {
              user_id: { type: "string" },
            },
          },
        },
      },
    };

    const moonshot = normalizeToolParameterSchema(schema, {
      modelProvider: "moonshot",
    }) as {
      properties: {
        tasks_attributes: {
          items: { anyOf: Array<Record<string, unknown>>; type?: string };
        };
      };
    };
    expect(moonshot.properties?.tasks_attributes.items).not.toHaveProperty("type");
    expect(moonshot.properties?.tasks_attributes.items.anyOf).toEqual([
      { required: ["contact_id"], type: "object" },
      { required: ["account_id"], type: "object" },
    ]);

    const openai = normalizeToolParameterSchema(schema, {
      modelProvider: "openai",
    }) as {
      properties: {
        tasks_attributes: {
          items: { anyOf: Array<Record<string, unknown>>; type?: string };
        };
      };
    };
    expect(openai.properties?.tasks_attributes.items).toHaveProperty("type", "object");
    expect(openai.properties?.tasks_attributes.items.anyOf).toEqual([
      { required: ["contact_id"] },
      { required: ["account_id"] },
    ]);
  });
});
