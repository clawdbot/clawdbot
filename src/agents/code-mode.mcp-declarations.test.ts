import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { expectDefined } from "@openclaw/normalization-core";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  resetCodeModeTestState,
  mcpTool,
  createCodeModeHarness,
  runUntilCompleted,
} from "./code-mode.test-support.js";
import { projectMcpCallToolResult } from "./mcp-content.js";

describe("Code Mode MCP declarations", () => {
  afterEach(resetCodeModeTestState);
  it("advertises dictionary and nullable inputs accepted through the MCP namespace", async () => {
    const mixedSchema = {
      type: "object",
      properties: {
        value: { properties: { nested: { type: "boolean" } }, enum: ["keep", { nested: true }] },
      },
      required: ["value"],
    };
    const defaultedSchema = {
      type: "object",
      properties: {
        limit: { type: "number", default: 0 },
        enabled: { type: "boolean", default: false },
        value: { type: ["string", "null"], default: null },
      },
      required: ["limit", "enabled", "value"],
    };
    const fixtures: {
      name: string;
      schema: JsonSchemaType & {
        properties?: Record<string, JsonSchemaType & { nullable?: boolean }>;
      };
      input?: Record<string, unknown>;
      expected?: Record<string, unknown>;
    }[] = [
      {
        name: "defaulted",
        schema: defaultedSchema,
        input: {},
        expected: { limit: 0, enabled: false, value: null },
      },
      {
        name: "defaultedOmitted",
        schema: defaultedSchema,
        input: undefined,
        expected: { limit: 0, enabled: false, value: null },
      },
      {
        name: "dictionary",
        schema: { type: "object", additionalProperties: { type: "string" } },
        input: { topic: "synthetic" },
      },
      { name: "open", schema: { type: "object" }, input: { topic: null } },
      {
        name: "closed",
        schema: { type: "object", patternProperties: {}, additionalProperties: false },
        input: {},
      },
      {
        name: "pattern",
        schema: {
          type: "object",
          patternProperties: { "^x": { type: "string" } },
          additionalProperties: false,
        },
        input: { xLabel: "synthetic" },
      },
      {
        name: "nullable",
        schema: {
          type: "object",
          properties: { value: { enum: ["keep", null] } },
          required: ["value"],
          additionalProperties: false,
        },
        input: { value: null },
      },
      {
        name: "nullableKeyword",
        schema: {
          type: "object",
          properties: {
            scalar: { type: "string", nullable: true },
            union: { type: ["number", "boolean"], nullable: true },
            dictionary: {
              type: "object",
              additionalProperties: { type: "string" },
              nullable: true,
            },
            restricted: { type: "string", nullable: true, enum: ["keep"] },
            constrained: { type: "string", enum: ["keep", null] },
            integer: { type: "integer", enum: [1, 1.5, { nested: true }] },
            impossible: { type: "string", enum: [false, { nested: true }] },
            options: {
              type: "object",
              properties: { limit: { type: "number", default: 10 } },
              required: ["limit"],
            },
            mixed: { type: "string", nullable: true, enum: ["keep", { nested: true }] },
            oversized: {
              type: "string",
              nullable: true,
              enum: Array.from({ length: 17 }, (_, i) => `choice${i}`),
            },
          },
          required: ["scalar", "union", "dictionary", "restricted"],
        },
        input: {
          scalar: null,
          union: null,
          dictionary: null,
          restricted: "keep",
          constrained: "keep",
          integer: 1,
          options: { limit: 5 },
          mixed: "keep",
          oversized: "choice0",
        },
      },
      { name: "mixed", schema: mixedSchema, input: { value: { nested: true } } },
      { name: "mixedPrimitive", schema: mixedSchema, input: { value: "keep" } },
      {
        name: "named",
        schema: {
          type: "object",
          properties: { id: { type: "number" }, label: { type: "string" } },
          required: ["id"],
          additionalProperties: { type: "boolean" },
        },
        input: { id: 1, extra: true },
      },
      {
        name: "nested",
        schema: {
          type: "object",
          properties: {
            values: {
              type: "array",
              items: { type: "object", additionalProperties: { enum: ["keep", null] } },
            },
          },
          required: ["values"],
        },
        input: { values: [{ topic: null }] },
      },
    ];
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const validator = new AjvJsonSchemaValidator();
    const targets = fixtures.map(({ name, schema }) => {
      const validate = validator.getValidator(structuredClone(schema));
      return mcpTool({
        name: `fixture__${name}`,
        serverName: "fixture",
        toolName: name,
        parameters: schema,
        execute: vi.fn(async (_toolCallId, input) => {
          expect(validate(input).valid).toBe(true);
          return projectMcpCallToolResult({
            content: [{ type: "text", text: JSON.stringify(input) }],
          });
        }),
      });
    });
    applyCodeModeCatalog({
      tools: [...codeModeTools, ...targets],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });
    const calls = fixtures.map(
      ({ name, input }) =>
        `MCP.fixture.${name}(${input === undefined ? "" : JSON.stringify(input)})`,
    );
    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "Code Mode exec test invariant"),
      waitTool: expectDefined(codeModeTools[1], "Code Mode wait test invariant"),
      code: `return { file: await API.read("mcp/fixture.d.ts"), api: await MCP.fixture.$api(), results: await Promise.all([${calls.join(",")}]) };`,
    });
    expect(details.status).toBe("completed");
    const value = details.value as {
      file: { content: string; bytes: number };
      api: { header: string };
      results: CallToolResult[];
    };
    expect(
      value.results.map((result) => JSON.parse((result.content[0] as { text: string }).text)),
    ).toEqual(fixtures.map(({ input, expected }) => expected ?? input));
    expect(targets.every((target) => vi.mocked(target.execute).mock.calls.length === 1)).toBe(true);
    expect(value.file.content).toBe(value.api.header);
    expect(value.file.bytes).toBe(Buffer.byteLength(value.file.content));
    // Compile real accepted calls against the advertised header, not a parallel expected renderer.
    const fileName = "/mcp-declaration-consumer.ts";
    const source = ts.createSourceFile(
      fileName,
      `${value.file.content}\n${calls.join(";\n")};
// @ts-expect-error Dictionary values are strings.
MCP.fixture.dictionary({ topic: 42 });
// @ts-expect-error Closed objects have no extra properties.
MCP.fixture.closed({ topic: "synthetic" });
// @ts-expect-error Nullable enums still reject other literals.
MCP.fixture.nullable({ value: "discard" });
// @ts-expect-error Required fields remain required.
MCP.fixture.nullable({});
const nullableFields = { scalar: null, union: null, dictionary: null, restricted: "keep", constrained: "keep", mixed: "keep", oversized: "choice0" } as const;
// @ts-expect-error Ajv nullable does not widen an enum that excludes null.
MCP.fixture.nullableKeyword({ ...nullableFields, restricted: null });
// @ts-expect-error A non-null type constrains even an enum containing null.
MCP.fixture.nullableKeyword({ ...nullableFields, constrained: null });
// @ts-expect-error A mixed enum still excludes null.
MCP.fixture.nullableKeyword({ ...nullableFields, mixed: null });
// @ts-expect-error A type-incompatible object enum member cannot widen valid strings.
MCP.fixture.nullableKeyword({ ...nullableFields, mixed: "discard" });
// @ts-expect-error Integer enum candidates must be integers.
MCP.fixture.nullableKeyword({ ...nullableFields, integer: 1.5 });
// @ts-expect-error An enum with no type-compatible values is never.
MCP.fixture.nullableKeyword({ ...nullableFields, impossible: "discard" });
// @ts-expect-error Defaults are only injected at the top level.
MCP.fixture.nullableKeyword({ ...nullableFields, options: {} });
// @ts-expect-error Non-defaulted required fields still require an argument.
MCP.fixture.nullable();
// @ts-expect-error An enum beyond the literal-rendering cap still excludes null.
MCP.fixture.nullableKeyword({ ...nullableFields, oversized: null });
// @ts-expect-error Nested dictionary values retain their enum type.
MCP.fixture.nested({ values: [{ topic: 42 }] });`,
      ts.ScriptTarget.ESNext,
      true,
    );
    const options = { noEmit: true, strict: true, types: [], target: ts.ScriptTarget.ESNext };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, ...args) =>
      name === fileName ? source : getSourceFile(name, ...args);
    const program = ts.createProgram([fileName], options, host);
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    ).toEqual([]);
  });
});
