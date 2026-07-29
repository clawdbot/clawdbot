import { describe, expect, it } from "vitest";
import { validatePluginConfig } from "./loader-shared.js";

const emptyObjectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

function withSchemaKeyword(key: "if" | "then" | "else", value: unknown) {
  return { [key]: value };
}

describe("validatePluginConfig empty schema classification", () => {
  it("validates pattern properties instead of requiring empty config", () => {
    const schema = {
      ...emptyObjectSchema,
      patternProperties: { "^S_": { type: "string" } },
    };

    expect(validatePluginConfig({ schema, value: { S_SETTING: "configured" } })).toEqual({
      ok: true,
      value: { S_SETTING: "configured" },
    });
    expect(validatePluginConfig({ schema, value: { S_SETTING: 42 } })).toMatchObject({
      ok: false,
    });
  });

  it("validates dependent schemas instead of using the empty-config shortcut", () => {
    const result = validatePluginConfig({
      schema: {
        ...emptyObjectSchema,
        dependentSchemas: { mode: { required: ["token"] } },
      },
      value: { mode: true },
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.error.join(" ")).not.toContain("config must be empty");
    }
  });

  it.each([
    {
      branch: "then",
      schema: {
        ...withSchemaKeyword("if", true),
        ...withSchemaKeyword("then", { minProperties: 1 }),
      },
    },
    {
      branch: "else",
      schema: {
        ...withSchemaKeyword("if", false),
        ...withSchemaKeyword("else", { minProperties: 1 }),
      },
    },
  ])("applies an active $branch conditional", ({ schema }) => {
    expect(
      validatePluginConfig({ schema: { ...emptyObjectSchema, ...schema }, value: {} }),
    ).toMatchObject({ ok: false });
  });

  it.each([
    withSchemaKeyword("if", true),
    withSchemaKeyword("then", { minProperties: 1 }),
    withSchemaKeyword("else", { minProperties: 1 }),
  ])("keeps standalone conditional keywords on the empty-config path: %o", (keyword) => {
    expect(
      validatePluginConfig({
        schema: { ...emptyObjectSchema, ...keyword },
        value: { unexpected: true },
      }),
    ).toEqual({ ok: false, error: ["<root>: config must be empty"] });
  });
});
