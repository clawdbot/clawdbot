import { Format } from "typebox/format";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "./schema-validator.js";

const jsonSchemaThenKeyword = ["the", "n"].join("");

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

function expectValidationIssue(
  result: Extract<ReturnType<typeof validateJsonSchemaValue>, { ok: false }>,
  path: string,
) {
  const issue = result.errors.find((entry) => entry.path === path);
  if (!issue) {
    expect(result.errors.map((entry) => entry.path)).toContain(path);
    throw new Error(`expected validation issue at ${path}`);
  }
  return issue;
}

function expectIssueMessageIncludes(
  issue: ReturnType<typeof expectValidationIssue>,
  fragments: readonly string[],
) {
  expect(issue.message).toContain(fragments[0] ?? "");
  fragments.slice(1).forEach((fragment) => {
    expect(issue.message).toContain(fragment);
  });
}

function expectSuccessfulValidationValue(params: {
  input: Parameters<typeof validateJsonSchemaValue>[0];
  expectedValue: unknown;
}) {
  const result = validateJsonSchemaValue(params.input);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value).toEqual(params.expectedValue);
  }
}

function expectValidationSuccess(params: Parameters<typeof validateJsonSchemaValue>[0]) {
  const result = validateJsonSchemaValue(params);
  expect(result.ok).toBe(true);
}

function expectUriValidationCase(params: {
  input: Parameters<typeof validateJsonSchemaValue>[0];
  ok: boolean;
  expectedPath?: string;
  expectedMessage?: string;
}) {
  if (params.ok) {
    expectValidationSuccess(params.input);
    return;
  }

  const result = expectValidationFailure(params.input);
  const issue = expectValidationIssue(result, params.expectedPath ?? "");
  expect(issue.message).toContain(params.expectedMessage ?? "");
}

describe("schema validator", () => {
  it("can apply JSON Schema defaults while validating", () => {
    const value = {};
    const result = validateJsonSchemaValue({
      cacheKey: "schema-validator.test.defaults.clone",
      schema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            default: "auto",
          },
        },
        additionalProperties: false,
      },
      value,
      applyDefaults: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ mode: "auto" });
      expect(result.value).not.toBe(value);
    }
    expect(value).toStrictEqual({});

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults",
        schema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              default: "auto",
            },
          },
          additionalProperties: false,
        },
        value: {},
        applyDefaults: true,
      },
      expectedValue: { mode: "auto" },
    });
  });

  it("applies JSON Schema defaults through local refs and map entries", () => {
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.refs",
        schema: {
          type: "object",
          properties: {
            settings: {
              $ref: "#/definitions/Settings",
            },
          },
          additionalProperties: {
            $ref: "#/definitions/Settings",
          },
          definitions: {
            Settings: {
              type: "object",
              properties: {
                mode: {
                  type: "string",
                  default: "auto",
                },
              },
              additionalProperties: false,
            },
          },
        },
        value: {
          settings: {},
          accountA: {},
        },
        applyDefaults: true,
      },
      expectedValue: {
        settings: { mode: "auto" },
        accountA: { mode: "auto" },
      },
    });
  });

  it("does not apply defaults from non-matching union branches", () => {
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.union",
        schema: {
          oneOf: [
            {
              type: "object",
              properties: {
                type: { const: "a" },
                aDefault: { type: "string", default: "a" },
              },
              required: ["type"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: {
                type: { const: "b" },
                bDefault: { type: "string", default: "b" },
              },
              required: ["type"],
              additionalProperties: false,
            },
          ],
        },
        value: { type: "a" },
        applyDefaults: true,
      },
      expectedValue: { type: "a" },
    });
  });

  it("accepts nullable JSON Schema type arrays", () => {
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.nullable-array",
        schema: {
          type: ["array", "null"],
          items: { type: "string" },
        },
        value: null,
      },
      expectedValue: null,
    });
  });

  it("accepts AJV-style nullable typed schemas", () => {
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.nullable-keyword",
        schema: {
          type: "string",
          nullable: true,
        },
        value: null,
      },
      expectedValue: null,
    });
  });

  it("keeps non-type constraints on nullable JSON Schema type arrays", () => {
    const result = expectValidationFailure({
      cacheKey: "schema-validator.test.nullable-enum",
      schema: {
        type: ["string", "null"],
        enum: ["on"],
      },
      value: null,
    });

    expectValidationIssue(result, "<root>");
  });

  it("rejects invalid JSON Schema type declarations", () => {
    expect(() =>
      validateJsonSchemaValue({
        cacheKey: "schema-validator.test.invalid-schema-type",
        schema: {
          type: "not-a-json-schema-type",
        },
        value: "anything",
      }),
    ).toThrow("invalid schema");
  });

  it("rejects invalid JSON Schema constraint keyword values", () => {
    for (const [cacheKey, schema] of [
      [
        "schema-validator.test.invalid-required",
        {
          type: "object",
          properties: { url: { type: "string" } },
          required: "url",
        },
      ],
      [
        "schema-validator.test.invalid-min-length",
        {
          type: "string",
          minLength: "1",
        },
      ],
      [
        "schema-validator.test.invalid-additional-properties",
        {
          type: "object",
          additionalProperties: [],
        },
      ],
      [
        "schema-validator.test.invalid-empty-allof",
        {
          allOf: [],
        },
      ],
      [
        "schema-validator.test.invalid-empty-anyof",
        {
          anyOf: [],
        },
      ],
      [
        "schema-validator.test.invalid-empty-oneof",
        {
          oneOf: [],
        },
      ],
      [
        "schema-validator.test.invalid-empty-enum",
        {
          enum: [],
        },
      ],
      [
        "schema-validator.test.invalid-duplicate-enum",
        {
          enum: ["api", "api"],
        },
      ],
      [
        "schema-validator.test.invalid-duplicate-required",
        {
          type: "object",
          required: ["mode", "mode"],
        },
      ],
      [
        "schema-validator.test.invalid-duplicate-type-array",
        {
          type: ["string", "string"],
        },
      ],
      [
        "schema-validator.test.invalid-ref",
        {
          $ref: "#/$defs/Missing",
        },
      ],
      [
        "schema-validator.test.invalid-array-ref-leading-zero",
        {
          anyOf: [{ type: "number" }, { type: "string" }],
          $ref: "#/anyOf/01",
        },
      ],
      [
        "schema-validator.test.invalid-dynamic-ref-type",
        {
          $dynamicRef: 123,
        },
      ],
      [
        "schema-validator.test.invalid-dynamic-ref",
        {
          $dynamicRef: "#/$defs/Missing",
        },
      ],
      [
        "schema-validator.test.invalid-nullable-type",
        {
          type: "string",
          nullable: "yes",
        },
      ],
      [
        "schema-validator.test.invalid-nullable-without-type",
        {
          nullable: true,
        },
      ],
      [
        "schema-validator.test.invalid-anchor-ref",
        {
          $defs: {
            Other: {
              $id: "other",
              $anchor: "value",
              type: "string",
            },
          },
          $ref: "#value",
        },
      ],
      [
        "schema-validator.test.invalid-external-ref",
        {
          $ref: "https://example.com/missing",
        },
      ],
      [
        "schema-validator.test.invalid-dependencies-value",
        {
          type: "object",
          dependencies: {
            mode: 123,
          },
        },
      ],
      [
        "schema-validator.test.invalid-dependencies-array",
        {
          type: "object",
          dependencies: {
            mode: [1],
          },
        },
      ],
    ] as const) {
      expect(() =>
        validateJsonSchemaValue({
          cacheKey,
          schema,
          value: "anything",
        }),
      ).toThrow("invalid schema");
    }
  });

  it("accepts valid local refs to boolean schemas and anchors", () => {
    const denied = expectValidationFailure({
      cacheKey: "schema-validator.test.false-ref",
      schema: {
        $defs: {
          Never: false,
        },
        $ref: "#/$defs/Never",
      },
      value: "anything",
    });
    expectValidationIssue(denied, "<root>");

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.anchor-ref",
        schema: {
          $defs: {
            Value: {
              $anchor: "value",
              type: "string",
            },
          },
          $ref: "#value",
        },
        value: "ok",
      },
      expectedValue: "ok",
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.nested-resource-anchor-ref",
        schema: {
          $defs: {
            Other: {
              $id: "other",
              $defs: {
                Value: {
                  $anchor: "value",
                  type: "string",
                },
              },
              $ref: "#value",
            },
          },
          $ref: "#/$defs/Other",
        },
        value: "ok",
      },
      expectedValue: "ok",
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.absolute-same-document-ref",
        schema: {
          $id: "https://example.com/schema",
          $defs: {
            Value: {
              type: "string",
            },
          },
          $ref: "https://example.com/schema#/$defs/Value",
        },
        value: "ok",
      },
      expectedValue: "ok",
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.embedded-absolute-id-ref",
        schema: {
          $defs: {
            Value: {
              $id: "https://example.com/value",
              type: "string",
            },
          },
          $ref: "https://example.com/value",
        },
        value: "ok",
      },
      expectedValue: "ok",
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.embedded-relative-id-ref",
        schema: {
          $defs: {
            Value: {
              $id: "value",
              type: "string",
            },
          },
          $ref: "value",
        },
        value: "ok",
      },
      expectedValue: "ok",
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.resolved-relative-id-ref",
        schema: {
          $id: "https://example.com/root/",
          $defs: {
            Value: {
              $id: "value",
              type: "string",
            },
          },
          $ref: "https://example.com/root/value",
        },
        value: "ok",
      },
      expectedValue: "ok",
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.empty-id-local-ref",
        schema: {
          $id: "",
          $defs: {
            Value: {
              type: "string",
            },
          },
          $ref: "#/$defs/Value",
        },
        value: "ok",
      },
      expectedValue: "ok",
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.dynamic-ref",
        schema: {
          $defs: {
            Value: {
              $dynamicAnchor: "value",
              type: "string",
            },
          },
          $dynamicRef: "#value",
        },
        value: "ok",
      },
      expectedValue: "ok",
    });

    expectValidationFailure({
      cacheKey: "schema-validator.test.dynamic-ref",
      schema: {
        $defs: {
          Value: {
            $dynamicAnchor: "value",
            type: "string",
          },
        },
        $dynamicRef: "#value",
      },
      value: 1,
    });
  });

  it("accepts local refs into schema arrays", () => {
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.array-ref",
        schema: {
          anyOf: [{ type: "string" }],
          $ref: "#/anyOf/0",
        },
        value: "ok",
      },
      expectedValue: "ok",
    });
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.tuple-ref",
        schema: {
          items: [{ type: "string" }],
          $ref: "#/items/0",
        },
        value: "ok",
      },
      expectedValue: "ok",
    });
  });

  it("accepts percent-encoded local ref pointer segments", () => {
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.percent-encoded-ref",
        schema: {
          $defs: {
            "foo bar": {
              type: "string",
            },
          },
          $ref: "#/$defs/foo%20bar",
        },
        value: "ok",
      },
      expectedValue: "ok",
    });
  });

  it("accepts local refs to anchors inside dependency schemas", () => {
    const schema = {
      type: "object",
      dependencies: {
        a: {
          $defs: {
            Target: {
              $anchor: "target",
              type: "object",
            },
          },
        },
        b: {
          properties: {
            b: {
              $ref: "#target",
            },
          },
          required: ["b"],
        },
      },
    } as const;
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.dependencies-anchor-ref",
        schema,
        value: {
          a: {},
          b: {},
        },
      },
      expectedValue: {
        a: {},
        b: {},
      },
    });
    expectValidationFailure({
      cacheKey: "schema-validator.test.dependencies-anchor-ref",
      schema,
      value: {
        a: {},
        b: 1,
      },
    });
  });

  it("applies defaults through refs that target embedded schema resources", () => {
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.embedded-resource-default-ref",
        schema: {
          $defs: {
            Other: {
              $id: "other",
              $defs: {
                Defaulted: {
                  type: "object",
                  properties: {
                    mode: {
                      type: "string",
                      default: "auto",
                    },
                  },
                },
              },
              properties: {
                settings: {
                  $ref: "#/$defs/Defaulted",
                },
              },
            },
          },
          $ref: "#/$defs/Other/properties/settings",
        },
        value: {},
        applyDefaults: true,
      },
      expectedValue: { mode: "auto" },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.same-ref-text-nested-resource-default",
        schema: {
          $defs: {
            Settings: {
              $id: "settings",
              type: "object",
              $defs: {
                Settings: {
                  type: "object",
                  properties: {
                    mode: {
                      type: "string",
                      default: "nested",
                    },
                  },
                },
              },
              properties: {
                child: {
                  $ref: "#/$defs/Settings",
                },
              },
            },
          },
          $ref: "#/$defs/Settings",
        },
        value: {
          child: {},
        },
        applyDefaults: true,
      },
      expectedValue: {
        child: {
          mode: "nested",
        },
      },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.absolute-id-default-ref",
        schema: {
          $defs: {
            Settings: {
              $id: "https://example.com/settings",
              type: "object",
              properties: {
                mode: {
                  type: "string",
                  default: "auto",
                },
              },
            },
          },
          $ref: "https://example.com/settings",
        },
        value: {},
        applyDefaults: true,
      },
      expectedValue: { mode: "auto" },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.relative-id-default-ref",
        schema: {
          $defs: {
            Settings: {
              $id: "settings",
              type: "object",
              properties: {
                mode: {
                  type: "string",
                  default: "auto",
                },
              },
            },
          },
          $ref: "settings",
        },
        value: {},
        applyDefaults: true,
      },
      expectedValue: { mode: "auto" },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.resolved-relative-id-default-ref",
        schema: {
          $id: "https://example.com/root/",
          $defs: {
            Settings: {
              $id: "settings",
              type: "object",
              properties: {
                mode: {
                  type: "string",
                  default: "auto",
                },
              },
            },
          },
          $ref: "https://example.com/root/settings",
        },
        value: {},
        applyDefaults: true,
      },
      expectedValue: { mode: "auto" },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.relative-resource-ref",
        schema: {
          $id: "https://example.com/root/",
          type: "object",
          properties: {
            settings: {
              $ref: "./settings",
            },
          },
          required: ["settings"],
          additionalProperties: false,
          $defs: {
            Settings: {
              $id: "settings",
              type: "object",
              properties: {
                mode: {
                  type: "string",
                  default: "auto",
                },
              },
              required: ["mode"],
              additionalProperties: false,
            },
          },
        },
        value: {
          settings: {},
        },
        applyDefaults: true,
      },
      expectedValue: {
        settings: {
          mode: "auto",
        },
      },
    });
  });

  it("accepts draft-07 tuple item schemas", () => {
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.tuple-items",
        schema: {
          type: "array",
          items: [{ type: "string" }, { type: "number" }],
          additionalItems: false,
        },
        value: ["mode", 1],
      },
      expectedValue: ["mode", 1],
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.tuple-items",
        schema: {
          type: "array",
          items: [
            { type: "string", default: "mode" },
            { type: "number", default: 1 },
          ],
          minItems: 2,
          additionalItems: false,
        },
        value: [],
        applyDefaults: true,
      },
      expectedValue: ["mode", 1],
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.prefix-items",
        schema: {
          type: "array",
          prefixItems: [
            { type: "string", default: "mode" },
            { type: "number", default: 1 },
          ],
          minItems: 2,
        },
        value: [],
        applyDefaults: true,
      },
      expectedValue: ["mode", 1],
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.tuple-item-nested-default",
        schema: {
          type: "array",
          items: [
            {
              type: "object",
              default: {},
              properties: {
                mode: {
                  type: "string",
                  default: "auto",
                },
              },
              required: ["mode"],
            },
          ],
          minItems: 1,
        },
        value: [],
        applyDefaults: true,
      },
      expectedValue: [{ mode: "auto" }],
    });
  });

  it("applies defaults for untyped object schemas", () => {
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.untyped-object",
        schema: {
          properties: {
            mode: {
              type: "string",
              default: "auto",
            },
          },
          additionalProperties: false,
        },
        value: {},
        applyDefaults: true,
      },
      expectedValue: { mode: "auto" },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.untyped-pattern-properties",
        schema: {
          patternProperties: {
            "^x": {
              type: "object",
              properties: {
                mode: {
                  type: "string",
                  default: "auto",
                },
              },
            },
          },
        },
        value: { x1: {} },
        applyDefaults: true,
      },
      expectedValue: { x1: { mode: "auto" } },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.untyped-additional-properties",
        schema: {
          additionalProperties: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                default: "manual",
              },
            },
          },
        },
        value: { other: {} },
        applyDefaults: true,
      },
      expectedValue: { other: { mode: "manual" } },
    });
  });

  it("applies defaults through active dependency and conditional schemas", () => {
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.dependencies",
        schema: {
          type: "object",
          properties: {
            flag: {
              type: "boolean",
            },
          },
          dependencies: {
            flag: {
              properties: {
                mode: {
                  type: "string",
                  default: "auto",
                },
              },
              required: ["mode"],
            },
          },
        },
        value: { flag: true },
        applyDefaults: true,
      },
      expectedValue: { flag: true, mode: "auto" },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.conditional",
        schema: {
          type: "object",
          properties: {
            kind: {
              const: "api",
            },
          },
          if: {
            properties: {
              kind: {
                const: "api",
              },
            },
            required: ["kind"],
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              endpoint: {
                type: "string",
                default: "https://example.com",
              },
            },
            required: ["endpoint"],
          },
        },
        value: { kind: "api" },
        applyDefaults: true,
      },
      expectedValue: { kind: "api", endpoint: "https://example.com" },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.conditional-ref",
        schema: {
          type: "object",
          $defs: {
            ApiKind: {
              properties: {
                kind: {
                  const: "api",
                },
              },
              required: ["kind"],
            },
          },
          if: {
            $ref: "#/$defs/ApiKind",
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              endpoint: {
                type: "string",
                default: "https://example.com",
              },
            },
            required: ["endpoint"],
          },
        },
        value: { kind: "api" },
        applyDefaults: true,
      },
      expectedValue: { kind: "api", endpoint: "https://example.com" },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.conditional-format-annotation",
        schema: {
          type: "object",
          properties: {
            contact: {
              type: "string",
            },
          },
          if: {
            properties: {
              contact: {
                type: "string",
                format: "email",
              },
            },
            required: ["contact"],
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              mode: {
                type: "string",
                default: "auto",
              },
            },
            required: ["mode"],
          },
        },
        value: { contact: "not an email" },
        applyDefaults: true,
      },
      expectedValue: { contact: "not an email", mode: "auto" },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.conditional-ref-resource-property-object",
        schema: {
          type: "object",
          properties: {
            kind: {
              properties: {
                value: {
                  const: "api",
                },
              },
              required: ["value"],
            },
          },
          if: {
            $ref: "#/properties/kind",
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              endpoint: {
                type: "string",
                default: "https://example.com",
              },
            },
            required: ["endpoint"],
          },
        },
        value: { value: "api" },
        applyDefaults: true,
      },
      expectedValue: { value: "api", endpoint: "https://example.com" },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.conditional-nested-ref-resource-property",
        schema: {
          type: "object",
          properties: {
            kind: {
              properties: {
                value: {
                  const: "api",
                },
              },
              required: ["value"],
            },
          },
          if: {
            properties: {
              kind: {
                $ref: "#/properties/kind",
              },
            },
            required: ["kind"],
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              endpoint: {
                type: "string",
                default: "https://example.com",
              },
            },
            required: ["endpoint"],
          },
        },
        value: { kind: { value: "api" } },
        applyDefaults: true,
      },
      expectedValue: { kind: { value: "api" }, endpoint: "https://example.com" },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.conditional-ref-with-local-defs",
        schema: {
          type: "object",
          $defs: {
            ApiKind: {
              properties: {
                kind: {
                  const: "api",
                },
              },
              required: ["kind"],
            },
          },
          if: {
            $defs: {
              Local: {
                type: "string",
              },
            },
            $ref: "#/$defs/ApiKind",
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              endpoint: {
                type: "string",
                default: "https://example.com",
              },
            },
            required: ["endpoint"],
          },
        },
        value: { kind: "api" },
        applyDefaults: true,
      },
      expectedValue: { kind: "api", endpoint: "https://example.com" },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.conditional-ref-root-defs-win",
        schema: {
          type: "object",
          $defs: {
            MatchKind: {
              properties: {
                kind: {
                  const: "api",
                },
              },
              required: ["kind"],
            },
          },
          if: {
            $defs: {
              MatchKind: {
                properties: {
                  kind: {
                    const: "other",
                  },
                },
                required: ["kind"],
              },
            },
            $ref: "#/$defs/MatchKind",
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              endpoint: {
                type: "string",
                default: "https://example.com",
              },
            },
          },
        },
        value: { kind: "api" },
        applyDefaults: true,
      },
      expectedValue: { kind: "api", endpoint: "https://example.com" },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.conditional-activated-by-default",
        schema: {
          type: "object",
          properties: {
            kind: {
              const: "api",
              default: "api",
            },
          },
          if: {
            properties: {
              kind: {
                const: "api",
              },
            },
            required: ["kind"],
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              endpoint: {
                type: "string",
                default: "https://example.com",
              },
            },
            required: ["endpoint"],
          },
        },
        value: {},
        applyDefaults: true,
      },
      expectedValue: { kind: "api", endpoint: "https://example.com" },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.conditional-default-selects-one-branch",
        schema: {
          type: "object",
          properties: {
            kind: {
              const: "api",
              default: "api",
            },
          },
          if: {
            properties: {
              kind: {
                const: "api",
              },
            },
            required: ["kind"],
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              endpoint: {
                type: "string",
                default: "https://example.com",
              },
            },
          },
          else: {
            properties: {
              path: {
                type: "string",
                default: "/tmp",
              },
            },
          },
        },
        value: {},
        applyDefaults: true,
      },
      expectedValue: { kind: "api", endpoint: "https://example.com" },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.conditional-default-branch-flip",
        schema: {
          type: "object",
          if: {
            not: {
              required: ["mode"],
            },
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              mode: {
                type: "string",
                default: "auto",
              },
            },
          },
          else: {
            properties: {
              explicit: {
                type: "boolean",
                default: true,
              },
            },
            required: ["explicit"],
          },
        },
        value: {},
        applyDefaults: true,
      },
      expectedValue: { mode: "auto" },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.conditional-defaulted-condition-remains-valid",
        schema: {
          type: "object",
          properties: {
            flag: {
              type: "boolean",
              default: true,
            },
          },
          if: {
            properties: {
              flag: { const: true },
            },
            required: ["flag"],
          },
          [jsonSchemaThenKeyword]: {
            required: ["secret"],
          },
        },
        value: {},
        applyDefaults: true,
      },
      expectedValue: { flag: true },
    });

    const explicitConditionResult = expectValidationFailure({
      cacheKey: "schema-validator.test.defaults.conditional-explicit-condition-still-fails",
      schema: {
        type: "object",
        properties: {
          flag: {
            type: "boolean",
            default: true,
          },
        },
        if: {
          properties: {
            flag: { const: true },
          },
          required: ["flag"],
        },
        [jsonSchemaThenKeyword]: {
          required: ["secret"],
        },
      },
      value: { flag: true },
      applyDefaults: true,
    });
    expectValidationIssue(explicitConditionResult, "<root>");

    expectValidationFailure({
      cacheKey: "schema-validator.test.defaults.conditional-invalid-default",
      schema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
          },
        },
        if: {
          not: {
            required: ["mode"],
          },
        },
        [jsonSchemaThenKeyword]: {
          properties: {
            mode: {
              type: "number",
              default: 1,
            },
          },
        },
        else: {
          properties: {
            explicit: {
              type: "boolean",
            },
          },
          required: ["explicit"],
        },
      },
      value: {},
      applyDefaults: true,
    });

    expectValidationFailure({
      cacheKey: "schema-validator.test.defaults.conditional-invalid-branch-default",
      schema: {
        type: "object",
        properties: {
          flag: {
            type: "boolean",
            default: true,
          },
        },
        if: {
          properties: {
            flag: { const: true },
          },
          required: ["flag"],
        },
        [jsonSchemaThenKeyword]: {
          properties: {
            mode: {
              type: "number",
              default: "bad",
            },
          },
        },
      },
      value: {},
      applyDefaults: true,
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.conditional-hydrates-parent-property",
        schema: {
          type: "object",
          properties: {
            kind: {
              const: "api",
            },
            settings: {
              type: "object",
              properties: {
                mode: {
                  type: "string",
                  default: "auto",
                },
              },
              required: ["mode"],
            },
          },
          if: {
            properties: {
              kind: {
                const: "api",
              },
            },
            required: ["kind"],
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              settings: {
                type: "object",
                default: {},
              },
            },
            required: ["settings"],
          },
        },
        value: { kind: "api" },
        applyDefaults: true,
      },
      expectedValue: { kind: "api", settings: { mode: "auto" } },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.dependency-activated-by-default",
        schema: {
          type: "object",
          properties: {
            flag: {
              type: "boolean",
              default: true,
            },
          },
          dependencies: {
            flag: {
              properties: {
                mode: {
                  type: "string",
                  default: "auto",
                },
              },
              required: ["mode"],
            },
          },
        },
        value: {},
        applyDefaults: true,
      },
      expectedValue: { flag: true, mode: "auto" },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.conditional-activates-dependency",
        schema: {
          type: "object",
          properties: {
            kind: {
              const: "api",
            },
          },
          dependencies: {
            flag: {
              properties: {
                mode: {
                  type: "string",
                  default: "auto",
                },
              },
              required: ["mode"],
            },
          },
          if: {
            properties: {
              kind: {
                const: "api",
              },
            },
            required: ["kind"],
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              flag: {
                type: "boolean",
                default: true,
              },
            },
            required: ["flag"],
          },
        },
        value: { kind: "api" },
        applyDefaults: true,
      },
      expectedValue: { kind: "api", flag: true, mode: "auto" },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.reverse-dependency-chain",
        schema: {
          type: "object",
          properties: {
            a: {
              type: "boolean",
              default: true,
            },
          },
          dependencies: {
            e: {
              properties: {
                f: {
                  type: "boolean",
                  default: true,
                },
              },
              required: ["f"],
            },
            d: {
              properties: {
                e: {
                  type: "boolean",
                  default: true,
                },
              },
              required: ["e"],
            },
            c: {
              properties: {
                d: {
                  type: "boolean",
                  default: true,
                },
              },
              required: ["d"],
            },
            b: {
              properties: {
                c: {
                  type: "boolean",
                  default: true,
                },
              },
              required: ["c"],
            },
            a: {
              properties: {
                b: {
                  type: "boolean",
                  default: true,
                },
              },
              required: ["b"],
            },
          },
        },
        value: {},
        applyDefaults: true,
      },
      expectedValue: { a: true, b: true, c: true, d: true, e: true, f: true },
    });

    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.dependency-activates-conditional",
        schema: {
          type: "object",
          properties: {
            a: {
              type: "boolean",
              default: true,
            },
          },
          dependencies: {
            b: {
              properties: {
                kind: {
                  const: "api",
                  default: "api",
                },
              },
              required: ["kind"],
            },
            a: {
              properties: {
                b: {
                  type: "boolean",
                  default: true,
                },
              },
              required: ["b"],
            },
          },
          if: {
            properties: {
              kind: {
                const: "api",
              },
            },
            required: ["kind"],
          },
          [jsonSchemaThenKeyword]: {
            properties: {
              endpoint: {
                type: "string",
                default: "https://example.com",
              },
            },
            required: ["endpoint"],
          },
        },
        value: {},
        applyDefaults: true,
      },
      expectedValue: { a: true, b: true, kind: "api", endpoint: "https://example.com" },
    });
  });

  it("applies defaults through patternProperties before additionalProperties", () => {
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.defaults.pattern-properties",
        schema: {
          type: "object",
          patternProperties: {
            "^x": {
              type: "object",
              properties: {
                mode: {
                  type: "string",
                  default: "auto",
                },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                default: "manual",
              },
            },
            additionalProperties: false,
          },
        },
        value: {
          other: {},
          x1: {},
        },
        applyDefaults: true,
      },
      expectedValue: {
        other: { mode: "manual" },
        x1: { mode: "auto" },
      },
    });
  });

  it("does not clone values when default application has no defaults to inject", () => {
    const value = { mode: "manual" };
    const result = validateJsonSchemaValue({
      cacheKey: "schema-validator.test.defaults.no-clone",
      schema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
          },
        },
        additionalProperties: false,
      },
      value,
      applyDefaults: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(value);
    }
  });

  it("recompiles when a stable cache key receives a different schema shape", () => {
    const cacheKey = "schema-validator.test.cache-key-drift";
    expectValidationSuccess({
      cacheKey,
      schema: { type: "string" },
      value: "ok",
    });

    const result = expectValidationFailure({
      cacheKey,
      schema: { type: "number" },
      value: "not-a-number",
    });
    expectValidationIssue(result, "<root>");
  });

  it("can isolate caller schemas that reuse the same $id with different shapes", () => {
    const first = validateJsonSchemaValue({
      cacheKey: "schema-validator.test.same-id.uncached",
      schema: {
        $id: "https://example.test/shared-schema",
        type: "object",
        properties: { foo: { type: "string" } },
        required: ["foo"],
        additionalProperties: false,
      },
      value: { foo: "ok" },
      cache: false,
    });
    expect(first.ok).toBe(true);

    const second = validateJsonSchemaValue({
      cacheKey: "schema-validator.test.same-id.uncached",
      schema: {
        $id: "https://example.test/shared-schema",
        type: "object",
        properties: { bar: { type: "number" } },
        required: ["bar"],
        additionalProperties: false,
      },
      value: { bar: 1 },
      cache: false,
    });
    expect(second.ok).toBe(true);
  });

  it.each([
    {
      title: "includes allowed values in enum validation errors",
      params: {
        cacheKey: "schema-validator.test.enum",
        schema: {
          type: "object",
          properties: {
            fileFormat: {
              type: "string",
              enum: ["markdown", "html", "json"],
            },
          },
          required: ["fileFormat"],
        },
        value: { fileFormat: "txt" },
      },
      path: "fileFormat",
      messageIncludes: ["(allowed:"],
      allowedValues: ["markdown", "html", "json"],
      hiddenCount: 0,
    },
    {
      title: "includes allowed value in const validation errors",
      params: {
        cacheKey: "schema-validator.test.const",
        schema: {
          type: "object",
          properties: {
            mode: {
              const: "strict",
            },
          },
          required: ["mode"],
        },
        value: { mode: "relaxed" },
      },
      path: "mode",
      messageIncludes: ["(allowed:"],
      allowedValues: ["strict"],
      hiddenCount: 0,
    },
    {
      title: "truncates long allowed-value hints",
      params: {
        cacheKey: "schema-validator.test.enum.truncate",
        schema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: [
                "v1",
                "v2",
                "v3",
                "v4",
                "v5",
                "v6",
                "v7",
                "v8",
                "v9",
                "v10",
                "v11",
                "v12",
                "v13",
              ],
            },
          },
          required: ["mode"],
        },
        value: { mode: "not-listed" },
      },
      path: "mode",
      messageIncludes: ["(allowed:", "... (+1 more)"],
      allowedValues: ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11", "v12"],
      hiddenCount: 1,
    },
    {
      title: "truncates oversized allowed value entries",
      params: {
        cacheKey: "schema-validator.test.enum.long-value",
        schema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["a".repeat(300)],
            },
          },
          required: ["mode"],
        },
        value: { mode: "not-listed" },
      },
      path: "mode",
      messageIncludes: ["(allowed:", "... (+"],
    },
  ])("$title", ({ params, path, messageIncludes, allowedValues, hiddenCount }) => {
    const result = expectValidationFailure(params);
    const issue = expectValidationIssue(result, path);

    expectIssueMessageIncludes(issue, messageIncludes);
    if (allowedValues) {
      expect(issue?.allowedValues).toEqual(allowedValues);
      expect(issue?.allowedValuesHiddenCount).toBe(hiddenCount);
    }
  });

  it.each([
    {
      title: "appends missing required property to the structured path",
      params: {
        cacheKey: "schema-validator.test.required.path",
        schema: {
          type: "object",
          properties: {
            settings: {
              type: "object",
              properties: {
                mode: { type: "string" },
              },
              required: ["mode"],
            },
          },
          required: ["settings"],
        },
        value: { settings: {} },
      },
      expectedPath: "settings.mode",
    },
    {
      title: "appends missing dependency property to the structured path",
      params: {
        cacheKey: "schema-validator.test.dependencies.path",
        schema: {
          type: "object",
          properties: {
            settings: {
              type: "object",
              dependencies: {
                mode: ["format"],
              },
            },
          },
        },
        value: { settings: { mode: "strict" } },
      },
      expectedPath: "settings.format",
    },
  ])("$title", ({ params, expectedPath }) => {
    const result = expectValidationFailure(params);
    const issue = expectValidationIssue(result, expectedPath);

    expect(issue?.allowedValues).toBeUndefined();
  });

  it("sanitizes terminal text while preserving structured fields", () => {
    const maliciousProperty = "evil\nkey\t\x1b[31mred\x1b[0m";
    const result = expectValidationFailure({
      cacheKey: "schema-validator.test.terminal-sanitize",
      schema: {
        type: "object",
        properties: {},
        required: [maliciousProperty],
      },
      value: {},
    });

    const issue = result.errors[0];
    if (!issue) {
      throw new Error("expected terminal sanitization validation issue");
    }
    expect(issue.path).toContain("\n");
    expect(issue.message).toContain("\n");
    expect(issue.text).toContain("\\n");
    expect(issue.text).toContain("\\t");
    expect(issue.text).not.toContain("\n");
    expect(issue.text).not.toContain("\t");
    expect(issue.text).not.toContain("\x1b");
  });

  it.each([
    {
      title: "accepts uri-formatted string schemas for valid urls",
      params: {
        cacheKey: "schema-validator.test.uri.valid",
        schema: {
          type: "object",
          properties: {
            apiRoot: {
              type: "string",
              format: "uri",
            },
          },
          required: ["apiRoot"],
        },
        value: { apiRoot: "https://api.telegram.org" },
      },
      ok: true,
    },
    {
      title: "rejects uri-formatted string schemas for invalid urls",
      params: {
        cacheKey: "schema-validator.test.uri.invalid",
        schema: {
          type: "object",
          properties: {
            apiRoot: {
              type: "string",
              format: "uri",
            },
          },
          required: ["apiRoot"],
        },
        value: { apiRoot: "not a uri" },
      },
      ok: false,
      expectedPath: "apiRoot",
      expectedMessage: "must match format",
    },
    {
      title: "rejects uri-formatted string schemas for invalid absolute urls",
      params: {
        cacheKey: "schema-validator.test.uri.invalid-absolute",
        schema: {
          type: "object",
          properties: {
            apiRoot: {
              type: "string",
              format: "uri",
            },
          },
          required: ["apiRoot"],
        },
        value: { apiRoot: "https://" },
      },
      ok: false,
      expectedPath: "apiRoot",
      expectedMessage: "must match format",
    },
  ])(
    "supports uri-formatted string schemas: $title",
    ({ params, ok, expectedPath, expectedMessage }) => {
      expectUriValidationCase({
        input: params,
        ok,
        expectedPath,
        expectedMessage,
      });
    },
  );

  it("treats non-uri string formats as annotations", () => {
    expectSuccessfulValidationValue({
      input: {
        cacheKey: "schema-validator.test.format.email.annotation",
        schema: {
          type: "object",
          properties: {
            contact: {
              type: "string",
              format: "email",
            },
            token: {
              type: "string",
              format: "uuid",
            },
          },
          required: ["contact", "token"],
        },
        value: {
          contact: "not an email",
          token: "not a uuid",
        },
      },
      expectedValue: {
        contact: "not an email",
        token: "not a uuid",
      },
    });
  });

  it("does not weaken the global TypeBox format registry", () => {
    expect(Format.Get("email")?.("not an email")).toBe(false);
    expect(Format.Get("uuid")?.("not a uuid")).toBe(false);
  });
});
