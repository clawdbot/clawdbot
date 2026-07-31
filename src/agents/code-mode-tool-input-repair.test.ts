import { describe, expect, it } from "vitest";
import { repairCodeModeToolInput } from "./code-mode-tool-input-repair.js";

describe("repairCodeModeToolInput", () => {
  it.each([
    [["string", "number"], "42"],
    [["string", "boolean"], "false"],
    [["string", "array"], "[1]"],
    [["string", "object"], '{"value":1}'],
  ])("preserves strings already allowed by the type union %j", (type, value) => {
    expect(repairCodeModeToolInput({ type }, value)).toBe(value);
  });

  it("still repairs a string when the schema does not allow strings", () => {
    expect(repairCodeModeToolInput({ type: ["number", "null"] }, "42")).toBe(42);
    expect(repairCodeModeToolInput({ type: ["number", "integer"] }, "1.5")).toBe(1.5);
  });

  it("rejects coercions that still violate the full schema", () => {
    expect(repairCodeModeToolInput({ type: "integer", minimum: 100 }, "42")).toBe("42");
    expect(
      repairCodeModeToolInput(
        {
          type: "object",
          properties: { requiredValue: { type: "string" } },
          required: ["requiredValue"],
          additionalProperties: false,
        },
        "{}",
      ),
    ).toBe("{}");
  });

  it.each([
    [{ anyOf: [{ type: "number" }, { type: "null" }] }, "42", 42],
    [{ oneOf: [{ type: "boolean" }, { type: "null" }] }, "false", false],
    [
      {
        anyOf: [{ type: "array", items: { type: "integer" } }, { type: "null" }],
      },
      '["1","2"]',
      [1, 2],
    ],
  ])("repairs values through composed schema branches", (schema, value, expected) => {
    expect(repairCodeModeToolInput(schema, value)).toEqual(expected);
  });

  it("repairs composed schemas nested in object properties", () => {
    expect(
      repairCodeModeToolInput(
        {
          type: "object",
          properties: {
            limit: { anyOf: [{ type: "integer" }, { type: "null" }] },
          },
        },
        { limit: "5" },
      ),
    ).toEqual({ limit: 5 });
  });

  it("lifts a shared required parent field out of stringified array items", () => {
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string" },
              newText: { type: "string" },
            },
            required: ["oldText", "newText"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    };

    expect(
      repairCodeModeToolInput(schema, {
        edits: '[{"path":"editable.txt","oldText":"status=pending","newText":"status=verified"}]',
      }),
    ).toEqual({
      path: "editable.txt",
      edits: [{ oldText: "status=pending", newText: "status=verified" }],
    });
  });

  it("does not lift ambiguous or conflicting array item fields", () => {
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string" },
              newText: { type: "string" },
            },
            required: ["oldText", "newText"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "edits"],
      additionalProperties: false,
    };
    const value = {
      edits: [
        { path: "a.txt", oldText: "one", newText: "two" },
        { path: "b.txt", oldText: "three", newText: "four" },
      ],
    };

    expect(repairCodeModeToolInput(schema, value)).toBe(value);
  });

  it.each([
    { const: null },
    { enum: [null, "auto"] },
    { allOf: [{ type: "null" }, { const: null }] },
  ])("preserves optional nulls accepted by the full property schema", (nullableProperty) => {
    expect(
      repairCodeModeToolInput(
        {
          type: "object",
          properties: {
            limit: { type: "integer" },
            marker: nullableProperty,
          },
        },
        { limit: "5", marker: null },
      ),
    ).toEqual({ limit: 5, marker: null });
  });

  it("preserves already valid and ambiguous composed values", () => {
    expect(repairCodeModeToolInput({ anyOf: [{ type: "string" }, { type: "number" }] }, "42")).toBe(
      "42",
    );
    expect(
      repairCodeModeToolInput({ oneOf: [{ type: "number" }, { type: "integer" }] }, "42"),
    ).toBe("42");
    expect(
      repairCodeModeToolInput(
        { anyOf: [{ type: "number", minimum: 100 }, { type: "null" }] },
        "42",
      ),
    ).toBe("42");
  });
});
