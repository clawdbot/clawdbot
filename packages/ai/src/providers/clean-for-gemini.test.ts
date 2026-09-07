// Gemini schema cleaner tests cover OpenAPI-compatible tool schema cleanup for
// Gemini-backed providers before schemas are sent upstream.
import { describe, expect, it } from "vitest";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";

describe("cleanSchemaForGemini", () => {
  it("coerces null properties to an empty object", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: null,
    }) as { type?: unknown; properties?: unknown };

    expect(cleaned.type).toBe("object");
    expect(cleaned.properties).toStrictEqual({});
  });

  it("coerces non-object properties to an empty object", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: "invalid",
    }) as { properties?: unknown };

    expect(cleaned.properties).toStrictEqual({});
  });

  it("coerces array properties to an empty object", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: [],
    }) as { properties?: unknown };

    expect(cleaned.properties).toStrictEqual({});
  });

  it("filters required fields that are not in properties", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        action: { type: "string" },
        amount: { type: "number" },
      },
      required: ["action", "amount", "token"],
    }) as { required?: string[] };

    expect(cleaned.required).toEqual(["action", "amount"]);
  });

  it("preserves required when all fields exist in properties", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        action: { type: "string" },
        amount: { type: "number" },
      },
      required: ["action", "amount"],
    }) as { required?: string[] };

    expect(cleaned.required).toEqual(["action", "amount"]);
  });

  it("removes required entirely when no fields match properties", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        action: { type: "string" },
      },
      required: ["missing_a", "missing_b"],
    }) as { required?: string[] };

    expect(cleaned.required).toBeUndefined();
  });

  it("removes required from object schemas when properties is absent", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      required: ["a", "b"],
    }) as { required?: string[] };

    expect(cleaned.required).toBeUndefined();
  });

  it("leaves required as-is for non-object schemas when properties is absent", () => {
    const cleaned = cleanSchemaForGemini({
      type: "array",
      required: ["a", "b"],
    }) as { required?: string[] };

    expect(cleaned.required).toEqual(["a", "b"]);
  });

  it("filters required in nested object properties", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name", "ghost"],
        },
      },
    }) as { properties?: { config?: { required?: string[] } } };

    expect(cleaned.properties?.config?.required).toEqual(["name"]);
  });

  it("does not treat inherited keys as declared properties", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["toString", "name"],
    }) as { required?: string[] };

    expect(cleaned.required).toEqual(["name"]);
  });

  it("coerces nested null properties while preserving valid siblings", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        bad: {
          type: "object",
          properties: null,
        },
        good: {
          type: "string",
        },
      },
    }) as {
      properties?: {
        bad?: { properties?: unknown };
        good?: { type?: unknown };
      };
    };

    expect(cleaned.properties?.bad?.properties).toStrictEqual({});
    expect(cleaned.properties?.good?.type).toBe("string");
  });

  it("strips empty required arrays", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: [],
    }) as Record<string, unknown>;

    expect(cleaned).not.toHaveProperty("required");
    expect(cleaned.type).toBe("object");
  });

  it("preserves non-empty required arrays", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    }) as Record<string, unknown>;

    expect(cleaned.required).toEqual(["name"]);
  });

  it("strips empty required arrays in nested schemas", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: {
            optional: { type: "string" },
          },
          required: [],
        },
      },
      required: ["nested"],
    }) as { properties?: { nested?: Record<string, unknown> }; required?: string[] };

    expect(cleaned.required).toEqual(["nested"]);
    expect(cleaned.properties?.nested).not.toHaveProperty("required");
  });

  it("strips the not keyword from schemas", () => {
    // `not` is outside the OpenAPI 3.0 subset accepted by Gemini-backed
    // providers and triggers upstream HTTP 400s if left in tool schemas.
    const cleaned = cleanSchemaForGemini({
      type: "object",
      not: { const: true },
      properties: {
        name: { type: "string" },
      },
    }) as Record<string, unknown>;

    expect(cleaned).not.toHaveProperty("not");
    expect(cleaned.type).toBe("object");
    expect(cleaned.properties).toEqual({ name: { type: "string" } });
  });

  it("collapses type arrays by stripping null entries", () => {
    // Type arrays like ["string", "null"] must collapse to a scalar OpenAPI
    // type for Gemini compatibility.
    const cleaned = cleanSchemaForGemini({
      type: ["string", "null"],
      description: "nullable field",
    }) as Record<string, unknown>;

    expect(cleaned.type).toBe("string");
    expect(cleaned.description).toBe("nullable field");
  });

  it("collapses type arrays in nested property schemas", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        agentId: {
          type: ["string", "null"],
          description: "Agent id",
        },
      },
    }) as { properties?: { agentId?: Record<string, unknown> } };

    expect(cleaned.properties?.agentId?.type).toBe("string");
  });

  it.each([
    {
      name: "integer enum",
      schema: { type: "integer", enum: [1, 2, 3] },
      expected: { type: "integer", enum: ["1", "2", "3"] },
    },
    {
      name: "integer enum before type",
      schema: { enum: [1, 2, 3], type: "integer" },
      expected: { enum: ["1", "2", "3"], type: "integer" },
    },
    {
      name: "boolean enum",
      schema: { type: "boolean", enum: [true, false] },
      expected: { type: "boolean", enum: ["true", "false"] },
    },
    {
      name: "string enum",
      schema: { type: "string", enum: ["a", "b", "c"] },
      expected: { type: "string", enum: ["a", "b", "c"] },
    },
    {
      name: "integer const before type",
      schema: { const: 42, type: "integer" },
      expected: { enum: ["42"], type: "integer" },
    },
  ])("stringifies $name values without changing the schema type", ({ schema, expected }) => {
    expect(cleanSchemaForGemini(schema)).toStrictEqual(expected);
  });

  it("drops null/undefined enum entries and de-duplicates", () => {
    const cleaned = cleanSchemaForGemini({
      type: "integer",
      enum: [1, 2, 2, null, undefined, 3],
    }) as { enum?: unknown };

    expect(cleaned.enum).toStrictEqual(["1", "2", "3"]);
  });

  it("stringifies nested numeric enums while preserving their number type", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        outer: {
          type: "array",
          items: {
            type: "object",
            properties: {
              score: { type: "number", enum: [1, 2, 3, 4, 5] },
            },
          },
        },
      },
    }) as {
      properties?: {
        outer?: { items?: { properties?: { score?: { type?: unknown; enum?: unknown } } } };
      };
    };

    const score = cleaned.properties?.outer?.items?.properties?.score;
    expect(score?.type).toBe("number");
    expect(score?.enum).toStrictEqual(["1", "2", "3", "4", "5"]);
  });

  it("returns no enum key when array becomes empty after coercion", () => {
    const cleaned = cleanSchemaForGemini({
      type: "integer",
      enum: [null, undefined, {}],
    }) as { enum?: unknown };

    expect(cleaned.enum).toBeUndefined();
  });

  it("flattens a nested single-branch allOf literal", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        settings: {
          description: "Selected settings mode",
          allOf: [{ const: "x", type: "string" }],
        },
      },
    }) as { properties?: { settings?: Record<string, unknown> } };

    expect(cleaned.properties?.settings).toEqual({
      description: "Selected settings mode",
      enum: ["x"],
      type: "string",
    });
    expect(JSON.stringify(cleaned)).not.toContain("allOf");
  });

  it("flattens a nested single-branch allOf enum", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        settings: {
          description: "Selected settings mode",
          allOf: [{ enum: ["x"], type: "string" }],
        },
      },
    }) as { properties?: { settings?: Record<string, unknown> } };

    expect(cleaned.properties?.settings).toEqual({
      description: "Selected settings mode",
      enum: ["x"],
      type: "string",
    });
    expect(JSON.stringify(cleaned)).not.toContain("allOf");
  });

  it("merges multiple compatible object intersections", () => {
    const cleaned = cleanSchemaForGemini({
      description: "Combined settings",
      allOf: [
        {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          required: ["enabled", "notDeclared"],
        },
        {
          type: "object",
          properties: { mode: { type: "string", enum: ["safe", "fast"] } },
          required: ["mode"],
        },
      ],
    });

    expect(cleaned).toEqual({
      description: "Combined settings",
      type: "object",
      properties: {
        name: { type: "string" },
        enabled: { type: "boolean" },
        mode: { type: "string", enum: ["safe", "fast"] },
      },
      required: ["name", "enabled", "mode"],
    });
    expect(JSON.stringify(cleaned)).not.toContain("allOf");
  });

  it("widens conflicting intersections without retaining allOf", () => {
    const cleaned = cleanSchemaForGemini({
      description: "Conflicting mode",
      allOf: [
        { type: "string", enum: ["x"] },
        { type: "string", enum: ["y"] },
      ],
    });

    expect(cleaned).toEqual({
      type: "string",
      description: "Conflicting mode",
    });
    expect(JSON.stringify(cleaned)).not.toContain("allOf");
  });
});
