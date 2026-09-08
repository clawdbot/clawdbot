import { describe, expect, it } from "vitest";
import { createMcpJsonSchemaValidator } from "./mcp-json-schema-validator.js";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

describe("createMcpJsonSchemaValidator patternProperties preflight", () => {
  it("rejects nested-repetition patternProperties before TypeBox Compile", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        patternProperties: {
          "(a+)+$": { type: "string" },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("rejects nested-repetition patternProperties under schema-valued dependencies", () => {
    const factory = createMcpJsonSchemaValidator();
    expect(() =>
      factory.getValidator({
        $schema: DRAFT,
        type: "object",
        properties: { mode: { type: "string" } },
        dependencies: {
          mode: {
            type: "object",
            patternProperties: {
              "(a+)+$": { type: "string" },
            },
          },
        },
      }),
    ).toThrow(/unsafe patternProperties pattern rejected/);
  });

  it("still compiles safe draft-2020-12 schemas", () => {
    const factory = createMcpJsonSchemaValidator();
    const validate = factory.getValidator<{ name: string }>({
      $schema: DRAFT,
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
    expect(validate({ name: "ok" }).valid).toBe(true);
    expect(validate({ name: 1 }).valid).toBe(false);
  });
});
