import { runAgentLoop, type AgentEvent, type StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, validateToolArguments } from "openclaw/plugin-sdk/llm";
import { Type, type TSchema } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import {
  cleanToolSchemaForGemini,
  normalizeToolParameterSchema,
  normalizeToolParameters,
} from "./agent-tools.schema.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

const TEST_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("normalizeToolParameterSchema", () => {
  it("reuses normalized schemas for the same schema object and provider options", () => {
    const schema = {
      type: "object",
      properties: {
        names: { type: "array" },
      },
    };

    const first = normalizeToolParameterSchema(schema);
    const second = normalizeToolParameterSchema(schema);
    const providerSpecific = normalizeToolParameterSchema(schema, { modelProvider: "gemini" });

    expect(second).toBe(first);
    expect(providerSpecific).not.toBe(first);
    expect(providerSpecific).toEqual(first);
  });

  it("normalizes truly empty schemas to type:object with properties:{}", () => {
    expect(normalizeToolParameterSchema({})).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("leaves top-level allOf schemas unchanged", () => {
    const schema = {
      allOf: [{ type: "object", properties: { id: { type: "string" } } }],
    };

    expect(normalizeToolParameterSchema(schema)).toEqual(schema);
  });

  it("adds missing top-level type for raw object-ish schemas", () => {
    expect(
      normalizeToolParameterSchema({
        properties: { q: { type: "string" } },
        required: ["q"],
      }),
    ).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    });
  });

  it("normalizes typed object schemas with missing or invalid properties", () => {
    const schemas = [
      { type: "object" },
      { type: "object", properties: undefined },
      { type: "object", properties: null },
      { type: "object", properties: [] },
      { type: "object", properties: "invalid" },
    ];

    for (const schema of schemas) {
      expect(normalizeToolParameterSchema(schema)).toEqual({
        type: "object",
        properties: {},
      });
    }
  });

  it("leaves non-object typed schemas without properties unchanged", () => {
    const schema = { type: "array", items: { type: "string" } };

    expect(normalizeToolParameterSchema(schema)).toEqual(schema);
  });

  it("adds permissive items schemas to arrays missing items", () => {
    expect(
      normalizeToolParameterSchema({
        type: "object",
        properties: {
          entity_hints: { type: "array", description: "Optional entity hints" },
          nested: {
            type: "object",
            properties: {
              ids: { type: "array" },
            },
          },
          alternatives: {
            anyOf: [{ type: "array" }, { type: "string" }],
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        entity_hints: {
          type: "array",
          description: "Optional entity hints",
          items: {},
        },
        nested: {
          type: "object",
          properties: {
            ids: { type: "array", items: {} },
          },
        },
        alternatives: {
          anyOf: [{ type: "array", items: {} }, { type: "string" }],
        },
      },
    });
  });

  it("inlines local $ref before removing unsupported keywords", () => {
    const cleaned = cleanToolSchemaForGemini({
      type: "object",
      properties: {
        foo: { $ref: "#/$defs/Foo" },
      },
      $defs: {
        Foo: { type: "string", enum: ["a", "b"] },
      },
    }) as {
      $defs?: unknown;
      properties?: Record<string, unknown>;
    };

    expect(cleaned.$defs).toBeUndefined();
    expect(cleaned.properties).toEqual({
      foo: {
        type: "string",
        enum: ["a", "b"],
      },
    });
    expect(cleaned.properties?.foo).toEqual({
      type: "string",
      enum: ["a", "b"],
    });
  });

  it("inlines nested local $ref schemas for provider-neutral tools", () => {
    expect(
      normalizeToolParameterSchema({
        type: "object",
        required: ["parent"],
        properties: {
          parent: {
            $ref: "#/$defs/Parent",
            description: "Notion parent",
          },
        },
        $defs: {
          Parent: {
            oneOf: [
              {
                type: "object",
                required: ["page_id"],
                properties: { page_id: { type: "string" } },
              },
              {
                type: "object",
                required: ["database_id"],
                properties: { database_id: { type: "string" } },
              },
            ],
          },
        },
      }),
    ).toEqual({
      type: "object",
      required: ["parent"],
      properties: {
        parent: {
          description: "Notion parent",
          oneOf: [
            {
              type: "object",
              required: ["page_id"],
              properties: { page_id: { type: "string" } },
            },
            {
              type: "object",
              required: ["database_id"],
              properties: { database_id: { type: "string" } },
            },
          ],
        },
      },
    });
  });

  it("inlines local $ref schemas that target nested JSON Pointer paths", () => {
    expect(
      normalizeToolParameterSchema({
        type: "object",
        properties: {
          pageId: { $ref: "#/$defs/Parent/properties/page_id" },
          legacyDatabaseId: { $ref: "#/definitions/Parent/properties/database_id" },
        },
        $defs: {
          Parent: {
            type: "object",
            properties: {
              page_id: { type: "string", description: "Page id" },
            },
          },
        },
        definitions: {
          Parent: {
            type: "object",
            properties: {
              database_id: { type: "string", description: "Database id" },
            },
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        pageId: { type: "string", description: "Page id" },
        legacyDatabaseId: { type: "string", description: "Database id" },
      },
    });
  });

  it("inlines local refs in tuple array items", () => {
    expect(
      normalizeToolParameterSchema({
        type: "array",
        items: [{ $ref: "#/$defs/Foo" }, { $ref: "#/definitions/Bar" }],
        $defs: {
          Foo: { type: "string" },
        },
        definitions: {
          Bar: { type: "integer" },
        },
      }),
    ).toEqual({
      type: "array",
      items: [{ type: "string" }, { type: "integer" }],
    });
  });

  it("keeps Swagger 2 definition refs supported", () => {
    expect(
      normalizeToolParameterSchema({
        type: "object",
        properties: {
          pet: { $ref: "#/definitions/Pet" },
        },
        definitions: {
          Pet: {
            type: "object",
            properties: {
              id: { type: "integer" },
            },
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        pet: {
          type: "object",
          properties: {
            id: { type: "integer" },
          },
        },
      },
    });
  });

  it("inlines OpenAPI 3 component schema refs", () => {
    expect(
      normalizeToolParameterSchema({
        type: "object",
        required: ["pet"],
        properties: {
          pet: {
            $ref: "#/components/schemas/Pet",
            description: "Pet payload",
          },
        },
        components: {
          schemas: {
            Pet: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
                tag: { type: "string", nullable: true },
              },
            },
          },
        },
      }),
    ).toEqual({
      type: "object",
      required: ["pet"],
      properties: {
        pet: {
          description: "Pet payload",
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            tag: { type: ["string", "null"] },
          },
        },
      },
    });
  });

  it("preserves OpenAPI nullable on direct component refs", () => {
    expect(
      normalizeToolParameterSchema({
        type: "object",
        properties: {
          pet: {
            $ref: "#/components/schemas/Pet",
            nullable: true,
          },
        },
        components: {
          schemas: {
            Pet: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        pet: {
          type: ["object", "null"],
          properties: {
            name: { type: "string" },
          },
        },
      },
    });
  });

  it("inlines OpenAPI component refs that target nested JSON Pointer paths", () => {
    expect(
      normalizeToolParameterSchema({
        type: "object",
        properties: {
          petName: { $ref: "#/components/schemas/Pet/properties/name" },
        },
        components: {
          schemas: {
            Pet: {
              type: "object",
              properties: {
                name: { type: "string", description: "Pet name" },
              },
            },
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        petName: { type: "string", description: "Pet name" },
      },
    });
  });

  it("preserves OpenAPI components when a local component ref cannot be resolved", () => {
    expect(
      normalizeToolParameterSchema({
        type: "object",
        properties: {
          missing: { $ref: "#/components/schemas/Missing" },
        },
        components: {
          schemas: {
            Present: {
              type: "string",
            },
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        missing: { $ref: "#/components/schemas/Missing" },
      },
      components: {
        schemas: {
          Present: {
            type: "string",
          },
        },
      },
    });
  });

  it("normalizes OpenAPI nullable and schema-only annotations", () => {
    expect(
      normalizeToolParameterSchema({
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["available"],
            nullable: true,
            readOnly: true,
            example: "available",
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        status: {
          type: ["string", "null"],
          enum: ["available", null],
        },
      },
    });
  });

  it("preserves schema properties named like OpenAPI annotations", () => {
    expect(
      normalizeToolParameterSchema({
        type: "object",
        properties: {
          components: { type: "number" },
          example: { type: "string", nullable: true },
          xml: { type: "boolean" },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        components: { type: "number" },
        example: { type: ["string", "null"] },
        xml: { type: "boolean" },
      },
    });
  });

  it("does not treat object-valued schema literals as OpenAPI schema objects", () => {
    expect(
      normalizeToolParameterSchema({
        type: "object",
        properties: {
          payload: {
            type: "object",
            default: {
              example: "kept",
              nullable: true,
              readOnly: true,
              $ref: "#/components/schemas/NotASchema",
              xml: { name: "payload" },
            },
            const: {
              example: "constant",
            },
            enum: [
              {
                example: "enum-value",
                xml: "kept",
              },
            ],
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        payload: {
          type: "object",
          default: {
            example: "kept",
            nullable: true,
            readOnly: true,
            $ref: "#/components/schemas/NotASchema",
            xml: { name: "payload" },
          },
          const: {
            example: "constant",
          },
          enum: [
            {
              example: "enum-value",
              xml: "kept",
            },
          ],
        },
      },
    });
  });

  it("preserves nullable OpenAPI composed schemas", () => {
    expect(
      normalizeToolParameterSchema({
        type: "object",
        properties: {
          pet: {
            nullable: true,
            allOf: [{ $ref: "#/components/schemas/Pet" }],
          },
        },
        components: {
          schemas: {
            Pet: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string" },
              },
            },
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        pet: {
          anyOf: [
            {
              allOf: [
                {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string" },
                  },
                },
              ],
            },
            { type: "null" },
          ],
        },
      },
    });
  });

  it("preserves local definitions when a local $ref cannot be resolved", () => {
    expect(
      normalizeToolParameterSchema({
        type: "object",
        properties: {
          missing: { $ref: "#/$defs/Missing/properties/id" },
        },
        $defs: {
          Present: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        missing: { $ref: "#/$defs/Missing/properties/id" },
      },
      $defs: {
        Present: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
      },
    });
  });

  it("cleans tuple items schemas", () => {
    const cleaned = cleanToolSchemaForGemini({
      type: "object",
      properties: {
        tuples: {
          type: "array",
          items: [
            { type: "string", format: "uuid" },
            { type: "number", minimum: 1 },
          ],
        },
      },
    }) as {
      properties?: Record<string, unknown>;
    };

    const tuples = cleaned.properties?.tuples as { items?: unknown } | undefined;
    const items = Array.isArray(tuples?.items) ? tuples?.items : [];
    const first = items[0] as { format?: unknown } | undefined;
    const second = items[1] as { minimum?: unknown } | undefined;

    expect(first?.format).toBeUndefined();
    expect(second?.minimum).toBeUndefined();
  });

  it("drops null-only union variants without flattening other unions", () => {
    const cleaned = cleanToolSchemaForGemini({
      type: "object",
      properties: {
        parentId: { anyOf: [{ type: "string" }, { type: "null" }] },
        count: { oneOf: [{ type: "string" }, { type: "number" }] },
      },
    }) as {
      properties?: Record<string, unknown>;
    };

    const parentId = cleaned.properties?.parentId as
      | { type?: unknown; anyOf?: unknown; oneOf?: unknown }
      | undefined;
    const count = cleaned.properties?.count as
      | { type?: unknown; anyOf?: unknown; oneOf?: unknown }
      | undefined;

    expect(parentId?.type).toBe("string");
    expect(parentId?.anyOf).toBeUndefined();
    expect(count?.oneOf).toBeUndefined();
  });
});

function makeTool(parameters: TSchema): AnyAgentTool {
  return {
    name: "test_tool",
    label: "Test Tool",
    description: "test",
    parameters,
    execute: vi.fn(),
  };
}

describe("normalizeToolParameters", () => {
  it("normalizes truly empty schemas to type:object with properties:{} (MCP parameter-free tools)", () => {
    const tool: AnyAgentTool = {
      name: "get_flux_instance",
      label: "get_flux_instance",
      description: "Get current Flux instance status",
      parameters: {},
      execute: vi.fn(),
    };

    const normalized = normalizeToolParameters(tool);

    const parameters = normalized.parameters as Record<string, unknown>;
    expect(parameters.type).toBe("object");
    expect(parameters.properties).toStrictEqual({});
  });

  it("does not rewrite non-empty schemas that still lack type/properties", () => {
    const tool: AnyAgentTool = {
      name: "conditional",
      label: "conditional",
      description: "Conditional schema stays untouched",
      parameters: { allOf: [] },
      execute: vi.fn(),
    };

    const normalized = normalizeToolParameters(tool);

    expect(normalized.parameters).toEqual({ allOf: [] });
  });

  it("injects properties:{} for type:object schemas missing properties (MCP no-param tools)", () => {
    const tool: AnyAgentTool = {
      name: "list_regions",
      label: "list_regions",
      description: "List all AWS regions",
      parameters: { type: "object" },
      execute: vi.fn(),
    };

    const normalized = normalizeToolParameters(tool);

    const parameters = normalized.parameters as Record<string, unknown>;
    expect(parameters.type).toBe("object");
    expect(parameters.properties).toStrictEqual({});
  });

  it("injects properties:{} when properties key exists but is undefined (MCP SDK edge case #75362)", () => {
    const tool: AnyAgentTool = {
      name: "get_flux_instance",
      label: "get_flux_instance",
      description: "Get flux instance",
      parameters: { type: "object", properties: undefined } as unknown as Record<string, unknown>,
      execute: vi.fn(),
    };

    const normalized = normalizeToolParameters(tool);

    const parameters = normalized.parameters as Record<string, unknown>;
    expect(parameters.type).toBe("object");
    expect(parameters.properties).toStrictEqual({});
  });

  it("injects properties:{} when properties key is null (MCP SDK edge case #75362)", () => {
    const tool: AnyAgentTool = {
      name: "get_flux_instance",
      label: "get_flux_instance",
      description: "Get flux instance",
      parameters: { type: "object", properties: null } as unknown as Record<string, unknown>,
      execute: vi.fn(),
    };

    const normalized = normalizeToolParameters(tool);

    const parameters = normalized.parameters as Record<string, unknown>;
    expect(parameters.type).toBe("object");
    expect(parameters.properties).toStrictEqual({});
  });

  it("preserves existing properties on type:object schemas", () => {
    const tool: AnyAgentTool = {
      name: "query",
      label: "query",
      description: "Run a query",
      parameters: { type: "object", properties: { q: { type: "string" } } },
      execute: vi.fn(),
    };

    const normalized = normalizeToolParameters(tool);

    const parameters = normalized.parameters as Record<string, unknown>;
    expect(parameters.type).toBe("object");
    expect(parameters.properties).toEqual({ q: { type: "string" } });
  });

  it("injects properties:{} for type:object with only additionalProperties", () => {
    const tool: AnyAgentTool = {
      name: "passthrough",
      label: "passthrough",
      description: "Accept any input",
      parameters: { type: "object", additionalProperties: true },
      execute: vi.fn(),
    };

    const normalized = normalizeToolParameters(tool);

    const parameters = normalized.parameters as Record<string, unknown>;
    expect(parameters.type).toBe("object");
    expect(parameters.properties).toStrictEqual({});
    expect(parameters.additionalProperties).toBe(true);
  });

  it("prepares null arguments as empty objects for object schemas without required params", () => {
    const tool: AnyAgentTool = {
      name: "wiki_lint",
      label: "wiki_lint",
      description: "Lint wiki vault",
      parameters: { type: "object", properties: {}, required: [] },
      execute: vi.fn(),
    };

    const normalized = normalizeToolParameters(tool);
    const prepared = normalized.prepareArguments?.(null) as Record<string, never>;

    expect(prepared).toStrictEqual({});
    expect(
      validateToolArguments(normalized, {
        type: "toolCall",
        id: "call-1",
        name: "wiki_lint",
        arguments: prepared,
      }),
    ).toStrictEqual({});
  });

  it("leaves null arguments invalid when the object schema has required params", () => {
    const tool: AnyAgentTool = {
      name: "query",
      label: "query",
      description: "Run query",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      execute: vi.fn(),
    };

    const normalized = normalizeToolParameters(tool);

    expect(normalized.prepareArguments).toBeUndefined();
    expect(() =>
      validateToolArguments(normalized, {
        type: "toolCall",
        id: "call-1",
        name: "query",
        arguments: null as never,
      }),
    ).toThrow('Validation failed for tool "query"');
  });

  it("leaves null arguments invalid when required params are nested in composite schemas", () => {
    const tool: AnyAgentTool = {
      name: "query",
      label: "query",
      description: "Run query",
      parameters: {
        type: "object",
        allOf: [
          {
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        ],
      },
      execute: vi.fn(),
    };

    const normalized = normalizeToolParameters(tool);

    expect(normalized.prepareArguments).toBeUndefined();
    expect(() =>
      validateToolArguments(normalized, {
        type: "toolCall",
        id: "call-1",
        name: "query",
        arguments: null as never,
      }),
    ).toThrow('Validation failed for tool "query"');
  });

  it("runs null arguments for parameterless tools through the agent loop without validation failure", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "wiki ok" }],
      details: { ok: true },
    });
    const normalized = normalizeToolParameters({
      name: "wiki_lint",
      label: "wiki_lint",
      description: "Lint wiki vault",
      parameters: { type: "object", properties: {}, required: [] },
      execute,
    });
    const tool = wrapToolWithBeforeToolCallHook(normalized, {
      agentId: "main",
      sessionKey: "e2e-null-args",
      loopDetection: { enabled: true },
    });
    const events: AgentEvent[] = [];
    let streamCalls = 0;
    const streamFn: StreamFn = () => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        streamCalls += 1;
        const message =
          streamCalls === 1
            ? {
                role: "assistant" as const,
                content: [
                  {
                    type: "toolCall" as const,
                    id: "call-null-args",
                    name: "wiki_lint",
                    arguments: null as never,
                  },
                ],
                api: "faux",
                provider: "faux",
                model: "faux-1",
                usage: TEST_USAGE,
                stopReason: "toolUse" as const,
                timestamp: Date.now(),
              }
            : {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "done" }],
                api: "faux",
                provider: "faux",
                model: "faux-1",
                usage: TEST_USAGE,
                stopReason: "stop" as const,
                timestamp: Date.now(),
              };
        stream.push({ type: "done", reason: message.stopReason, message });
      });
      return stream;
    };

    const messages = await runAgentLoop(
      [{ role: "user", content: "lint the wiki", timestamp: Date.now() }],
      { systemPrompt: "test", messages: [], tools: [tool] },
      {
        model: {
          id: "faux-1",
          name: "Faux",
          provider: "faux",
          api: "faux",
          baseUrl: "http://localhost:0",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 1024,
        },
        convertToLlm: (agentMessages) => agentMessages as never,
      },
      (event) => {
        events.push(event);
      },
      undefined,
      streamFn,
    );

    expect(streamCalls).toBe(2);
    const executeCall = execute.mock.calls[0];
    expect(executeCall?.[0]).toBe("call-null-args");
    expect(executeCall?.[1]).toEqual({});
    expect(executeCall?.[2]).toBeUndefined();
    expect(typeof executeCall?.[3]).toBe("function");
    const toolResult = messages.find((message) => message.role === "toolResult");
    const toolResultRecord = toolResult as
      | {
          role?: string;
          toolCallId?: string;
          toolName?: string;
          isError?: boolean;
          content?: unknown;
        }
      | undefined;
    expect(toolResultRecord?.role).toBe("toolResult");
    expect(toolResultRecord?.toolCallId).toBe("call-null-args");
    expect(toolResultRecord?.toolName).toBe("wiki_lint");
    expect(toolResultRecord?.isError).toBe(false);
    expect(toolResultRecord?.content).toEqual([{ type: "text", text: "wiki ok" }]);
    const endedToolCall = events.find((event) => event.type === "tool_execution_end");
    expect(endedToolCall?.type).toBe("tool_execution_end");
    expect(endedToolCall?.toolCallId).toBe("call-null-args");
    expect(endedToolCall?.toolName).toBe("wiki_lint");
    expect(endedToolCall?.isError).toBe(false);
    expect(JSON.stringify(messages)).not.toContain("Validation failed for tool");
  });

  it("strips compat-declared unsupported schema keywords without provider-specific branching", () => {
    const tool: AnyAgentTool = {
      name: "demo",
      label: "demo",
      description: "demo",
      parameters: Type.Object({
        count: Type.Integer({ minimum: 1, maximum: 5 }),
        query: Type.Optional(Type.String({ minLength: 2 })),
      }),
      execute: vi.fn(),
    };

    const normalized = normalizeToolParameters(tool, {
      modelCompat: {
        unsupportedToolSchemaKeywords: ["minimum", "maximum", "minLength"],
      },
    });

    const parameters = normalized.parameters as {
      required?: string[];
      properties?: Record<string, Record<string, unknown>>;
    };

    expect(parameters.required).toEqual(["count"]);
    expect(parameters.properties?.count.minimum).toBeUndefined();
    expect(parameters.properties?.count.maximum).toBeUndefined();
    expect(parameters.properties?.count.type).toBe("integer");
    expect(parameters.properties?.query.minLength).toBeUndefined();
    expect(parameters.properties?.query.type).toBe("string");
  });

  it("omits empty array items when model compat requires it", () => {
    const tool: AnyAgentTool = {
      name: "demo",
      label: "demo",
      description: "demo",
      parameters: {
        type: "object",
        properties: Object.fromEntries([
          ["__proto__", { type: "array", items: {} }],
          ["emptyItems", { type: "array" }],
          ["typedItems", { type: "array", items: { type: "string" } }],
          ["falseItems", { type: "array", items: false }],
          ["nullItems", { type: "array", items: null }],
          ["literalDefault", { type: "string", default: { type: "array", items: {} } }],
          ["literalEnum", { type: "string", enum: [{ type: "array", items: {} }] }],
        ]),
      },
      execute: vi.fn(),
    };

    const normalized = normalizeToolParameters(tool, {
      modelCompat: { omitEmptyArrayItems: true } as never,
    });

    expect(normalized.parameters).toEqual({
      type: "object",
      properties: Object.fromEntries([
        ["__proto__", { type: "array" }],
        ["emptyItems", { type: "array" }],
        ["typedItems", { type: "array", items: { type: "string" } }],
        ["falseItems", { type: "array", items: false }],
        ["nullItems", { type: "array", items: null }],
        ["literalDefault", { type: "string", default: { type: "array", items: {} } }],
        ["literalEnum", { type: "string", enum: [{ type: "array", items: {} }] }],
      ]),
    });
    const properties = (normalized.parameters as { properties?: Record<string, unknown> })
      .properties;
    expect(properties).toBeDefined();
    expect(Object.hasOwn(properties ?? {}, "__proto__")).toBe(true);
  });

  it("filters required to match properties when flattening anyOf for Gemini", () => {
    const tool = makeTool({
      type: "object",
      required: ["action", "amount", "token"],
      anyOf: [
        {
          type: "object",
          properties: {
            action: { type: "string", enum: ["buy"] },
            amount: { type: "number" },
          },
        },
        {
          type: "object",
          properties: {
            action: { type: "string", enum: ["sell"] },
            price: { type: "number" },
          },
        },
      ],
    });

    const result = normalizeToolParameters(tool, {
      modelProvider: "google",
    });

    const params = result.parameters as {
      required?: string[];
      properties?: Record<string, unknown>;
    };

    expect(params.required).not.toContain("token");
    expect(params.required).toContain("action");
    expect(params.properties).toHaveProperty("action");
    expect(params.properties).toHaveProperty("amount");
    expect(params.properties).toHaveProperty("price");
  });

  it("preserves extra required fields for non-Gemini providers", () => {
    const tool = makeTool({
      type: "object",
      required: ["action", "token"],
      anyOf: [
        {
          type: "object",
          properties: {
            action: { type: "string" },
          },
        },
      ],
    });

    const result = normalizeToolParameters(tool);
    const params = result.parameters as { required?: string[] };

    expect(params.required).toEqual(["action", "token"]);
  });

  it("keeps all required fields when they exist in merged properties", () => {
    const tool = makeTool({
      type: "object",
      required: ["action", "amount"],
      anyOf: [
        {
          type: "object",
          properties: {
            action: { type: "string" },
            amount: { type: "number" },
          },
        },
      ],
    });

    const result = normalizeToolParameters(tool, {
      modelProvider: "google",
    });

    const params = result.parameters as { required?: string[] };
    expect(params.required).toContain("action");
    expect(params.required).toContain("amount");
  });

  it("removes required entirely when no fields match merged properties", () => {
    const tool = makeTool({
      type: "object",
      required: ["ghost_a", "ghost_b"],
      anyOf: [
        {
          type: "object",
          properties: {
            real: { type: "string" },
          },
        },
      ],
    });

    const result = normalizeToolParameters(tool, {
      modelProvider: "google",
    });

    const params = result.parameters as { required?: string[] };
    expect(params.required).toBeUndefined();
  });

  it("drops inherited names like toString for Gemini", () => {
    const tool = makeTool({
      type: "object",
      required: ["toString", "name"],
      anyOf: [
        {
          type: "object",
          properties: {
            name: { type: "string" },
          },
        },
      ],
    });

    const result = normalizeToolParameters(tool, {
      modelProvider: "google",
    });

    const params = result.parameters as { required?: string[] };
    expect(params.required).toEqual(["name"]);
  });
});
