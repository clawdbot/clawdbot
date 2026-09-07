// Verifies OpenAI strict tool schema normalization and cache behavior.
import { deepStrictEqual } from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { buildOpenAICompletionsParams } from "../transports/openai-completions-params.js";
import { makeCompletionsModel } from "../transports/openai-completions.test-support.js";
import {
  normalizeToolParameterSchema,
  ToolSchemaDepthLimitError,
} from "./agent-tools-parameter-schema.js";
import { convertProjectedResponsesTools } from "./openai-responses-tools.js";
import { projectOpenAITools } from "./openai-tool-projection.js";
import { normalizeOpenAIStrictCompatSchema } from "./openai-tool-schema-compat.js";
import {
  findOpenAIStrictSchemaViolations,
  findOpenAIStrictToolProjectionDiagnostics,
  isStrictOpenAIJsonSchemaCompatible,
  normalizeOpenAIStrictToolParameters,
  normalizeStrictOpenAIJsonSchema,
  resolveOpenAIProjectedToolsStrictToolFlag,
} from "./openai-tool-schema.js";

describe("OpenAI strict tool schema normalization", () => {
  it.each([
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
    "dependencies",
  ])("preserves literal names when repairing the %s schema map", (mapKey) => {
    const schema = {
      type: "object",
      [mapKey]: { ["__proto__"]: { type: "string", description: null } },
    };

    const normalized = normalizeOpenAIStrictCompatSchema(schema);
    expect(Object.getOwnPropertyDescriptor(normalized, mapKey)?.value).toStrictEqual({
      ["__proto__"]: { type: "string" },
    });
    expect(schema[mapKey]).toStrictEqual({
      ["__proto__"]: { type: "string", description: null },
    });
  });

  it("infers the root type from schema fields instead of a literal prototype key", () => {
    const schema = {
      ["__proto__"]: { type: "array" },
      properties: { path: { type: "string" } },
      description: null,
    };

    expect(normalizeOpenAIStrictCompatSchema(schema)).toStrictEqual({
      ["__proto__"]: { type: "array" },
      properties: { path: { type: "string" } },
      type: "object",
    });
  });

  it("preserves literal property names when strict normalization repairs a nested object", () => {
    const schema = {
      type: "object",
      properties: { ["__proto__"]: { type: "object", properties: {} } },
      required: ["__proto__"],
      additionalProperties: false,
    };

    expect(normalizeStrictOpenAIJsonSchema(schema)).toStrictEqual({
      ...schema,
      properties: { ["__proto__"]: { type: "object", properties: {}, required: [] } },
    });
  });

  it.each(["anyOf", "oneOf"])(
    "preserves variant-only literal properties when flattening %s",
    (unionKey) => {
      const properties = {
        ["__proto__"]: { type: "string", minLength: 1 },
        constructor: { type: "integer" },
        toString: { type: "boolean" },
      };
      const required = ["__proto__", "constructor", "toString"];
      const schema = {
        [unionKey]: [
          { type: "object", properties, required },
          { type: "object", properties: { ["__proto__"]: { type: "string" } }, required },
        ],
        additionalProperties: false,
      };

      deepStrictEqual(normalizeStrictOpenAIJsonSchema(schema), {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      });
      expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
    },
  );

  it("preserves literal metadata when removing OpenAPI annotations", () => {
    const schema = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
      ["__proto__"]: { type: "array" },
    };

    expect(normalizeStrictOpenAIJsonSchema({ ...schema, nullable: false })).toStrictEqual(schema);
  });

  it("repairs top-level object schemas with missing or invalid properties", () => {
    const schemas = [
      { type: "object" },
      { type: "object", properties: undefined },
      { type: "object", properties: null },
      { type: "object", properties: [] },
      { type: "object", properties: "invalid" },
    ];

    for (const schema of schemas) {
      expect(normalizeStrictOpenAIJsonSchema(schema)).toEqual({
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      });
      expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
    }
  });

  it("does not close permissive nested object schemas implicitly", () => {
    // Nested permissive objects stay incompatible unless callers make them strict.
    const schema = {
      type: "object",
      properties: {
        metadata: {
          type: "object",
        },
      },
      required: ["metadata"],
    };

    const normalized = normalizeStrictOpenAIJsonSchema(schema) as {
      additionalProperties?: boolean;
      properties?: { metadata?: { additionalProperties?: boolean } };
    };

    expect(normalized.additionalProperties).toBe(false);
    expect(normalized.properties?.metadata).not.toHaveProperty("additionalProperties");
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(false);
    expect(
      resolveOpenAIProjectedToolsStrictToolFlag(
        projectOpenAITools([{ name: "write", parameters: schema }]),
        true,
      ),
    ).toBe(false);
  });

  it("walks named schema maps without treating definition names as keywords", () => {
    const schema = {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
      $defs: {
        anyOf: { type: "string" },
      },
      examples: [{ anyOf: [{ type: "string" }] }],
    };

    expect(
      findOpenAIStrictSchemaViolations(schema, "parameters", { requireObjectRoot: true }),
    ).toEqual([]);
  });

  it("walks legacy and content schema applicators", () => {
    const nestedObject = {
      type: "object",
      properties: { value: { type: "string" } },
    };
    const schema = {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
      dependencies: {
        mode: ["payload"],
        payload: nestedObject,
      },
      additionalItems: nestedObject,
      contentSchema: nestedObject,
    };

    expect(
      findOpenAIStrictSchemaViolations(schema, "parameters", { requireObjectRoot: true }),
    ).toEqual([
      "parameters.dependencies.payload.additionalProperties",
      "parameters.dependencies.payload.required",
      "parameters.additionalItems.additionalProperties",
      "parameters.additionalItems.required",
      "parameters.contentSchema.additionalProperties",
      "parameters.contentSchema.required",
    ]);
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(false);
  });

  it("normalizes truly empty MCP tool schema {} for strict mode", () => {
    const schema = {};
    const normalized = normalizeStrictOpenAIJsonSchema(schema) as Record<string, unknown>;
    expect(normalized.type).toBe("object");
    expect(normalized.properties).toStrictEqual({});
    expect(normalized.required).toStrictEqual([]);
    expect(normalized.additionalProperties).toBe(false);
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
  });

  it("reuses normalized strict schemas for stable tool schema objects", () => {
    // Cache keys include unsupported-keyword policy, not just object identity.
    const schema = {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    };

    const first = normalizeStrictOpenAIJsonSchema(schema);
    const second = normalizeStrictOpenAIJsonSchema(schema);
    const third = normalizeStrictOpenAIJsonSchema(schema, {
      unsupportedToolSchemaKeywords: ["minimum"],
    });

    expect(second).toBe(first);
    expect(third).not.toBe(first);
    expect(
      normalizeStrictOpenAIJsonSchema(schema, {
        unsupportedToolSchemaKeywords: ["minimum"],
      }),
    ).toBe(third);
  });

  it("reports unreadable nested tool schemas instead of throwing", () => {
    const unreadable = {
      name: "broken",
      parameters: {
        type: "object",
        get properties(): never {
          throw new Error("properties exploded");
        },
      },
    };

    const projection = projectOpenAITools([unreadable]);

    expect(findOpenAIStrictToolProjectionDiagnostics(projection)).toEqual([
      {
        toolIndex: 0,
        toolName: "broken",
        violations: ["broken.parameters is not JSON-serializable"],
      },
    ]);
  });

  it("keeps strict mode for emitted tools when unreadable tools are dropped", () => {
    const projection = projectOpenAITools([
      {
        name: "broken",
        parameters: {
          type: "object",
          get properties(): never {
            throw new Error("properties exploded");
          },
        },
      },
      {
        name: "lookup",
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ]);

    expect(resolveOpenAIProjectedToolsStrictToolFlag(projection, true)).toBe(true);
  });

  it("reuses projected schemas for strict checks and normalization", () => {
    let serializationCount = 0;
    const projection = projectOpenAITools([
      {
        name: "lookup",
        parameters: {
          toJSON() {
            serializationCount += 1;
            return {
              type: "object",
              properties: {},
              required: [],
              additionalProperties: false,
            };
          },
        },
      },
    ]);
    const tool = projection.tools[0];
    expect(tool).toBeDefined();

    expect(resolveOpenAIProjectedToolsStrictToolFlag(projection, true)).toBe(true);
    const normalized = normalizeOpenAIStrictToolParameters(tool?.parameters, true);
    expect(normalizeOpenAIStrictToolParameters(tool?.parameters, true)).toBe(normalized);
    expect(serializationCount).toBe(1);
  });
});

describe("tool schema depth guard", () => {
  function deepPropertiesChain(levels: number): unknown {
    let schema: unknown = { type: "object", properties: { leaf: { type: "string" } } };
    for (let i = 0; i < levels; i += 1) {
      schema = { type: "object", properties: { nested: schema } };
    }
    return schema;
  }

  function deepArrayChain(levels: number): unknown {
    let value: unknown = "leaf";
    for (let i = 0; i < levels; i += 1) {
      value = [value];
    }
    return value;
  }

  function allOfChain(levels: number): unknown {
    let schema: unknown = { type: "string" };
    for (let i = 0; i < levels; i += 1) {
      schema = { allOf: [schema] };
    }
    return schema;
  }

  it.each([
    ["deep properties chain", deepPropertiesChain(3000)],
    ["deep array chain", deepArrayChain(3000)],
  ])("rejects %s instead of overflowing the stack", (_name, schema) => {
    expect(() => normalizeStrictOpenAIJsonSchema(schema)).toThrow(ToolSchemaDepthLimitError);
  });

  it("normalizes a deeply nested but legitimate object schema without rejecting it", () => {
    expect(() => normalizeStrictOpenAIJsonSchema(deepPropertiesChain(80))).not.toThrow();
  });

  it("accepts/rejects exactly at the shared nesting budget across walkers", () => {
    // One convention everywhere: each child schema node costs one level, containers cost zero,
    // so the same document measures the same depth in every normalizer.
    expect(() => normalizeToolParameterSchema(deepPropertiesChain(255))).not.toThrow();
    expect(() => normalizeStrictOpenAIJsonSchema(deepPropertiesChain(255))).not.toThrow();
    expect(() => normalizeToolParameterSchema(deepPropertiesChain(300))).toThrow(
      ToolSchemaDepthLimitError,
    );
    expect(() => normalizeStrictOpenAIJsonSchema(deepPropertiesChain(300))).toThrow(
      ToolSchemaDepthLimitError,
    );
  });

  it("counts composition children once in every normalization path", () => {
    // 130 nested single-element allOf chains measure depth 130: the composition array is a
    // transparent container. Double-counting it would reject at 260 only in some paths.
    const schema = {
      type: "object",
      properties: { field: allOfChain(130) },
    };
    expect(() => normalizeToolParameterSchema(schema)).not.toThrow();
    expect(() =>
      normalizeToolParameterSchema(schema, { modelCompat: { omitEmptyArrayItems: true } }),
    ).not.toThrow();
    expect(() => normalizeStrictOpenAIJsonSchema(schema)).not.toThrow();

    const hostile = { type: "object", properties: { field: allOfChain(3000) } };
    expect(() => normalizeToolParameterSchema(hostile)).toThrow(ToolSchemaDepthLimitError);
    expect(() =>
      normalizeToolParameterSchema(hostile, { modelCompat: { omitEmptyArrayItems: true } }),
    ).toThrow(ToolSchemaDepthLimitError);
    expect(() => normalizeStrictOpenAIJsonSchema(hostile)).toThrow(ToolSchemaDepthLimitError);
  });

  it("bounds local $ref expansion depth, not only raw document depth", () => {
    // A flat $defs map is shallow as a document, but each entry links to the next, so expansion
    // recurses once per link — a pre-expansion document check cannot see this depth.
    const defs: Record<string, unknown> = {};
    for (let i = 0; i < 3000; i += 1) {
      defs[`s${i}`] = { $ref: `#/$defs/s${i + 1}` };
    }
    defs.s3000 = { type: "string" };
    const schema = { $defs: defs, $ref: "#/$defs/s0" };
    expect(() => normalizeToolParameterSchema(schema)).toThrow(ToolSchemaDepthLimitError);
  });

  it("keeps deeply nested opaque literal values without rejecting the schema", () => {
    // const/default/enum/examples are literal payloads, not schema edges: normalizers preserve
    // them without recursion, so their depth must not trip the guard.
    let literal: unknown = "leaf";
    for (let i = 0; i < 3000; i += 1) {
      literal = { nested: literal };
    }
    const schema = { type: "object", properties: { field: { type: "object", default: literal } } };
    const normalized = normalizeToolParameterSchema(schema) as {
      properties: { field: { default: unknown } };
    };
    expect(normalized.properties.field.default).toEqual(literal);
  });

  it("preserves deeply nested literal payloads in strict mode without rejecting", () => {
    let literal: unknown = "leaf";
    for (let i = 0; i < 300; i += 1) {
      literal = { nested: literal };
    }
    const schema = { type: "object", properties: { field: { type: "object", default: literal } } };
    const normalized = normalizeStrictOpenAIJsonSchema(schema) as {
      properties: { field: { default: unknown } };
    };
    expect(normalized.properties.field.default).toEqual(literal);
    expect(() => isStrictOpenAIJsonSchemaCompatible(schema)).not.toThrow();
  });

  it("bounds retained $defs subtrees reached only by downstream walkers", () => {
    // An unresolved $ref keeps $defs on the normalized result; those raw subtrees are traversed
    // by the post-inlining walkers, so the budget must hold there too.
    let deep: unknown = { type: "string" };
    for (let i = 0; i < 2000; i += 1) {
      deep = { type: "object", properties: { child: deep } };
    }
    const schema = {
      type: "object",
      properties: { broken: { $ref: "#/definitions/missing" } },
      $defs: { deep },
    };
    expect(() => normalizeToolParameterSchema(schema)).toThrow(ToolSchemaDepthLimitError);
  });

  it("describes the nesting limit and corrective action when rejecting", () => {
    let caught: unknown;
    try {
      normalizeToolParameterSchema(deepPropertiesChain(3000));
    } catch (error) {
      caught = error;
    }
    const error = caught as Error;
    expect(error.name).toBe("ToolSchemaDepthLimitError");
    expect(error.message).toContain("256");
    expect(error.message).toContain("nesting");
  });

  it.each(["default", "const", "enum", "examples"])(
    "repairs a keyword-named property (%s) during strict normalization",
    (name) => {
      // Inside a properties map these are user-chosen property names, not schema keywords:
      // the nested empty-object schema must still receive its required: [] repair, or the
      // strict compatibility check downgrades the whole tool inventory to strict: false.
      const schema = {
        type: "object",
        properties: { [name]: { type: "object", properties: {}, additionalProperties: false } },
        required: [name],
      };
      const normalized = normalizeStrictOpenAIJsonSchema(schema) as {
        properties: Record<string, { required?: unknown[] }>;
      };
      expect(normalized.properties[name]?.required).toEqual([]);
      expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
    },
  );
});

describe("draft-07 dependencies in strict normalization", () => {
  it.each(["default", "const", "enum", "examples"])(
    "normalizes a keyword-named dependency subschema (%s) instead of exempting it as a literal",
    (name) => {
      // Dependency names are user-chosen: dependencies.default is a subschema, not the literal
      // "default" keyword. Missing the repair emits a strict payload OpenAI rejects.
      const schema = {
        type: "object",
        properties: { mode: { type: "string" } },
        required: ["mode"],
        additionalProperties: false,
        dependencies: {
          [name]: { type: "object", properties: {}, additionalProperties: false },
        },
      };
      const normalized = normalizeStrictOpenAIJsonSchema(schema) as {
        dependencies: Record<string, { required?: unknown[] }>;
      };
      expect(normalized.dependencies[name]?.required).toEqual([]);
      expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
    },
  );

  it("marks a permissive dependency subschema as not strict-compatible", () => {
    // The compatibility verdict must reach inside dependencies: a permissive nested object
    // cannot ride along in a strict: true payload.
    const schema = {
      type: "object",
      properties: { mode: { type: "string" } },
      required: ["mode"],
      additionalProperties: false,
      dependencies: { default: { type: "object", properties: {} } },
    };
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(false);
  });

  it("preserves property-dependency name arrays byte-identical", () => {
    const nameList = ["other", "third"];
    const schema = {
      type: "object",
      properties: { field: { type: "string" }, other: { type: "string" } },
      required: ["field", "other"],
      additionalProperties: false,
      dependencies: { field: nameList },
    };
    const normalized = normalizeStrictOpenAIJsonSchema(schema) as {
      dependencies: { field: unknown };
    };
    expect(normalized.dependencies.field).toBe(nameList);
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
  });

  it.each(["default", "const", "enum", "examples"])(
    "emits repaired dependency subschemas (%s) through both payload builders",
    (name) => {
      const parameters = {
        type: "object",
        properties: { mode: { type: "string" } },
        required: ["mode"],
        additionalProperties: false,
        dependencies: {
          [name]: { type: "object", properties: {}, additionalProperties: false },
        },
      };
      const expectedDependency = {
        type: "object",
        properties: {},
        additionalProperties: false,
        required: [],
      };

      const completionsParams = buildOpenAICompletionsParams(
        makeCompletionsModel({ id: "gpt-5", name: "GPT-5" }),
        {
          systemPrompt: "system",
          messages: [],
          tools: [{ name: "lookup", description: "Look up", parameters }],
        } as never,
        undefined,
      ) as {
        tools?: Array<{ function?: { parameters?: unknown; strict?: boolean } }>;
      };
      const completionsTool = completionsParams.tools?.[0]?.function;
      expect(completionsTool?.strict).toBe(true);
      const completionsParameters = completionsTool?.parameters;
      expect(completionsParameters).toBeDefined();
      expect(
        (completionsParameters as { dependencies: Record<string, unknown> }).dependencies[name],
      ).toEqual(expectedDependency);

      const projection = projectOpenAITools([
        { name: "lookup", description: "Look up", parameters },
      ]);
      const responsesTools = convertProjectedResponsesTools(projection, true);
      expect(responsesTools[0]?.strict).toBe(true);
      const responsesParameters = responsesTools[0]?.parameters;
      expect(responsesParameters).toBeDefined();
      expect(
        (responsesParameters as { dependencies: Record<string, unknown> }).dependencies[name],
      ).toEqual(expectedDependency);
    },
  );
});
