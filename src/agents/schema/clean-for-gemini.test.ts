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

  // Regression: #61206 — `not` keyword is not part of the OpenAPI 3.0 subset
  // and must be stripped to avoid HTTP 400 from Gemini-backed providers.
  it("strips the not keyword from schemas", () => {
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

  // Regression: #61206 — type arrays like ["string", "null"] must be
  // collapsed to a single scalar type for OpenAPI 3.0 compatibility.
  it("collapses type arrays by stripping null entries", () => {
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
});
