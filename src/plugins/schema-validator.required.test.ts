import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "./schema-validator.js";

function expectValidationFailure(
  params: Parameters<typeof validateJsonSchemaValue>[0],
): Extract<ReturnType<typeof validateJsonSchemaValue>, { ok: false }> {
  const result = validateJsonSchemaValue(params);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected validation failure");
  }
  return result;
}

describe("schema validator", () => {
  it.each([
    {
      title: "multiple root fields",
      schema: { type: "object", required: ["endpoint", "token"] },
      value: {},
      expectedErrors: [
        {
          path: "endpoint",
          message: "must have required property 'endpoint'",
          text: "endpoint: must have required property 'endpoint'",
        },
        {
          path: "token",
          message: "must have required property 'token'",
          text: "token: must have required property 'token'",
        },
      ],
    },
    {
      title: "multiple nested fields",
      schema: {
        type: "object",
        properties: { settings: { type: "object", required: ["endpoint", "token"] } },
      },
      value: { settings: {} },
      expectedErrors: [
        {
          path: "settings.endpoint",
          message: "must have required property 'endpoint'",
          text: "settings.endpoint: must have required property 'endpoint'",
        },
        {
          path: "settings.token",
          message: "must have required property 'token'",
          text: "settings.token: must have required property 'token'",
        },
      ],
    },
    {
      title: "literal quoted, slash, and tilde names",
      schema: { type: "object", required: ["owner's-token", "path/one", "tilde~name"] },
      value: {},
      expectedErrors: [
        {
          path: "owner's-token",
          message: "must have required property 'owner's-token'",
          text: "owner's-token: must have required property 'owner's-token'",
        },
        {
          path: "path/one",
          message: "must have required property 'path/one'",
          text: "path/one: must have required property 'path/one'",
        },
        {
          path: "tilde~name",
          message: "must have required property 'tilde~name'",
          text: "tilde~name: must have required property 'tilde~name'",
        },
      ],
    },
    {
      title: "terminal controls in a later field",
      schema: { type: "object", required: ["endpoint", "evil\nkey\t\x1b[31mred\x1b[0m"] },
      value: {},
      expectedErrors: [
        {
          path: "endpoint",
          message: "must have required property 'endpoint'",
          text: "endpoint: must have required property 'endpoint'",
        },
        {
          path: "evil\nkey\t\x1b[31mred\x1b[0m",
          message: "must have required property 'evil\nkey\t\x1b[31mred\x1b[0m'",
          text: "evil\\nkey\\tred: must have required property 'evil\\nkey\\tred'",
        },
      ],
    },
    {
      title: "only the remaining field after partial input",
      schema: { type: "object", required: ["endpoint", "token"] },
      value: { endpoint: "fixture" },
      expectedErrors: [
        {
          path: "token",
          message: "must have required property 'token'",
          text: "token: must have required property 'token'",
        },
      ],
    },
  ])(
    "reports complete required diagnostics for $title",
    ({ title, schema, value, expectedErrors }) => {
      const result = expectValidationFailure({
        cacheKey: `schema-validator.test.required.complete.${title}`,
        schema,
        value,
      });

      expect(result.errors).toEqual(expectedErrors);
    },
  );

  describe.each(["dependentRequired", "dependencies"] as const)("%s diagnostics", (keyword) => {
    it.each([
      {
        title: "all dependencies missing in one condition",
        schema: { type: "object", [keyword]: { a: ["b", "c"] } },
        value: { a: true },
        expectedErrors: [
          {
            path: "<root>",
            message: "must have properties b, c when property a is present",
            text: "<root>: must have properties b, c when property a is present",
          },
        ],
      },
      {
        title: "root with the first dependency already present",
        schema: { type: "object", [keyword]: { a: ["b", "c"] } },
        value: { a: true, b: "present" },
        expectedErrors: [
          {
            path: "<root>",
            message: "must have properties b, c when property a is present",
            text: "<root>: must have properties b, c when property a is present",
          },
        ],
      },
      {
        title: "nested object with the first dependency already present",
        schema: {
          type: "object",
          properties: { settings: { type: "object", [keyword]: { a: ["b", "c"] } } },
        },
        value: { settings: { a: true, b: "present" } },
        expectedErrors: [
          {
            path: "settings",
            message: "must have properties b, c when property a is present",
            text: "settings: must have properties b, c when property a is present",
          },
        ],
      },
      {
        title: "literal and nested containers with distinct conditions",
        schema: {
          type: "object",
          properties: {
            "room/one": { type: "object", [keyword]: { literal: ["left", "right"] } },
            room: {
              type: "object",
              properties: {
                one: { type: "object", [keyword]: { nested: ["left", "right"] } },
              },
            },
          },
        },
        value: {
          "room/one": { literal: true, left: "present" },
          room: { one: { nested: true, right: "present" } },
        },
        expectedErrors: [
          {
            path: "room.one",
            message: "must have properties left, right when property literal is present",
            text: "room.one: must have properties left, right when property literal is present",
          },
          {
            path: "room.one",
            message: "must have properties left, right when property nested is present",
            text: "room.one: must have properties left, right when property nested is present",
          },
        ],
      },
    ])(
      "preserves the dependency condition at $title",
      ({ title, schema, value, expectedErrors }) => {
        const result = expectValidationFailure({
          cacheKey: `schema-validator.test.${keyword}.condition.${title}`,
          schema,
          value,
        });

        expect(result.errors).toEqual(expectedErrors);
      },
    );

    it("accepts all required and dependent fields without changing their values", () => {
      const value = { a: true, b: "first", c: "second" };
      const result = validateJsonSchemaValue({
        cacheKey: `schema-validator.test.${keyword}.condition.complete`,
        schema: { type: "object", required: ["a", "b", "c"], [keyword]: { a: ["b", "c"] } },
        value,
      });

      expect(result).toEqual({ ok: true, value });
      if (result.ok) {
        expect(result.value).toBe(value);
      }
    });
  });
});
