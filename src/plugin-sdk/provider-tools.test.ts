// Provider tool tests cover tool schema conversion and provider payload compatibility.
import { describe, expect, it } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";
import {
  buildProviderToolCompatFamilyHooks,
  inspectDeepSeekToolSchemas,
  findOpenAIStrictSchemaViolations,
  inspectGeminiToolSchemas,
  inspectLlamacppGbnfToolSchemas,
  inspectOpenAIToolSchemas,
  normalizeDeepSeekToolSchemas,
  normalizeGeminiToolSchemas,
  normalizeLlamacppGbnfToolSchemas,
  normalizeOpenAIToolSchemas,
} from "./provider-tools.js";

describe("buildProviderToolCompatFamilyHooks", () => {
  type ProviderContextOptions = {
    provider?: string;
    modelId?: string;
    modelApi?: string;
    baseUrl?: string | null;
  };

  function tool(parameters: unknown, name = "demo") {
    return { name, description: "", parameters } as never;
  }

  function objectSchema(properties: Record<string, unknown>, overrides = {}) {
    return { type: "object", properties, ...overrides };
  }

  function strictObject(overrides: Record<string, unknown> = {}) {
    return {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
      ...overrides,
    };
  }

  function providerContext(tools: never[], options: ProviderContextOptions = {}) {
    const provider = options.provider ?? "openai";
    const modelId = options.modelId ?? "gpt-5.4";
    const modelApi = options.modelApi ?? "openai-responses";
    const baseUrl = options.baseUrl === undefined ? "https://api.openai.com/v1" : options.baseUrl;
    return {
      provider,
      modelId,
      modelApi,
      model: {
        provider,
        api: modelApi,
        ...(baseUrl ? { baseUrl } : {}),
        id: modelId,
      } as never,
      tools,
    };
  }

  const openAIHooks = buildProviderToolCompatFamilyHooks("openai");

  function normalizeOpenAITools(tools: never[], options?: ProviderContextOptions) {
    return openAIHooks.normalizeToolSchemas(providerContext(tools, options));
  }

  function inspectOpenAITools(tools: never[], options?: ProviderContextOptions) {
    return openAIHooks.inspectToolSchemas(providerContext(tools, options));
  }

  function deepSeekContext(tools: never[]) {
    return providerContext(tools, {
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      modelApi: "openai-completions",
      baseUrl: null,
    });
  }

  function normalizeOpenAIParameters(parameters: unknown): unknown {
    return normalizeOpenAITools([tool(parameters)])[0]?.parameters;
  }

  it("keeps schema helpers outside eager AI transports", () => {
    expect(
      findSourceImportBackedges("src/plugin-sdk/provider-tools.ts", [
        "packages/ai/src/providers/azure-openai-responses.ts",
        "packages/ai/src/providers/openai-completions.ts",
        "packages/ai/src/providers/openai-responses.ts",
        "packages/ai/src/transports/openai-completions-transport.ts",
        "packages/ai/src/transports/openai-responses-transport.ts",
      ]),
    ).toEqual([]);
  });

  it("covers the tool compat family matrix", () => {
    const cases = [
      ["deepseek", normalizeDeepSeekToolSchemas, inspectDeepSeekToolSchemas],
      ["gemini", normalizeGeminiToolSchemas, inspectGeminiToolSchemas],
      ["llamacpp-gbnf", normalizeLlamacppGbnfToolSchemas, inspectLlamacppGbnfToolSchemas],
      ["openai", normalizeOpenAIToolSchemas, inspectOpenAIToolSchemas],
    ] as const;

    for (const [family, normalizeToolSchemas, inspectToolSchemas] of cases) {
      const hooks = buildProviderToolCompatFamilyHooks(family);

      expect(hooks.normalizeToolSchemas).toBe(normalizeToolSchemas);
      expect(hooks.inspectToolSchemas).toBe(inspectToolSchemas);
    }
  });

  it("removes llama.cpp GBNF-hostile constraints from nested tool schemas", () => {
    const hooks = buildProviderToolCompatFamilyHooks("llamacpp-gbnf");
    const tools = [
      tool(
        objectSchema({
          job: objectSchema({
            declarationKey: {
              type: "string",
              maxLength: 1999,
              pattern: "^\\S+$",
            },
            trigger: {
              anyOf: [
                objectSchema({
                  script: { type: "string", minLength: 1, maxLength: 65_536 },
                  boundary: { type: "string", maxLength: 2000 },
                }),
                { type: "null" },
              ],
            },
          }),
        }),
        "cron",
      ),
    ];

    const normalized = hooks.normalizeToolSchemas({
      provider: "ollama",
      modelId: "qwen3.5",
      tools,
    });

    expect(normalized[0]?.parameters).toEqual(
      objectSchema({
        job: objectSchema({
          declarationKey: { type: "string", maxLength: 1999 },
          trigger: {
            anyOf: [
              objectSchema({
                script: { type: "string", minLength: 1 },
                boundary: { type: "string" },
              }),
              { type: "null" },
            ],
          },
        }),
      }),
    );
    expect(hooks.inspectToolSchemas({ provider: "ollama", tools: normalized })).toEqual([]);
  });

  it.each([
    {
      title: "normalizes canonical OpenAI Codex Responses tool schemas",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    },
    {
      title: "applies ChatGPT Responses strict compat on first-party OpenAI API hosts",
      baseUrl: "https://api.openai.com/v1",
    },
  ])("$title", ({ baseUrl }) => {
    const normalized = normalizeOpenAITools([tool({})], {
      modelApi: "openai-chatgpt-responses",
      baseUrl,
    });
    expect(normalized[0]?.parameters).toEqual(strictObject());
  });

  it("leaves non-openai providers untouched by OpenAI strict compat", () => {
    const tools = [tool({ type: "string" })];
    const normalized = normalizeOpenAITools(tools, {
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      modelApi: "anthropic-messages",
      baseUrl: null,
    });
    expect(normalized).toBe(tools);
  });

  it("collapses anyOf and oneOf unions for the deepseek family", () => {
    const hooks = buildProviderToolCompatFamilyHooks("deepseek");
    const tools = [
      tool(
        objectSchema(
          {
            date: {
              description: "Balance sheet date",
              anyOf: [{ type: "string" }, { type: "integer" }],
            },
            ticker: {
              oneOf: [{ type: "string" }, { type: "null" }],
            },
          },
          { required: ["date"] },
        ),
        "unusual-whales__get_balance_sheet_screener",
      ),
    ];

    const normalized = hooks.normalizeToolSchemas(deepSeekContext(tools));

    expect(normalized[0]?.parameters).toEqual(
      objectSchema(
        {
          date: {
            description: "Balance sheet date",
            type: "string",
          },
          ticker: {
            type: "string",
            nullable: true,
          },
        },
        { required: ["date"] },
      ),
    );
    expect(hooks.inspectToolSchemas(deepSeekContext(normalized as never))).toStrictEqual([]);
  });

  it("preserves string-const unions as a flat enum for the deepseek family", () => {
    // Regression for https://github.com/openclaw/openclaw/issues/86468 —
    // Typebox `Type.Union([Type.Literal(...)])` collapses to anyOf of consts;
    // the previous normalizer kept only the first const, hiding every other
    // literal from the model.
    const hooks = buildProviderToolCompatFamilyHooks("deepseek");
    const tools = [
      tool(
        objectSchema(
          {
            mode: {
              description: "更新模式（必填）",
              anyOf: [
                { const: "overwrite", type: "string" },
                { const: "append", type: "string" },
                { const: "replace_range", type: "string" },
              ],
            },
            optional_mode: {
              anyOf: [
                { const: "a", type: "string" },
                { const: "b", type: "string" },
                { type: "null" },
              ],
            },
            single_const: {
              anyOf: [{ const: "only", type: "string" }],
            },
          },
          { required: ["mode"] },
        ),
        "feishu_update_doc",
      ),
    ];

    const normalized = hooks.normalizeToolSchemas(deepSeekContext(tools));

    expect(normalized[0]?.parameters).toEqual(
      objectSchema(
        {
          mode: {
            description: "更新模式（必填）",
            type: "string",
            enum: ["overwrite", "append", "replace_range"],
          },
          optional_mode: {
            type: "string",
            enum: ["a", "b"],
            nullable: true,
          },
          single_const: {
            const: "only",
            type: "string",
          },
        },
        { required: ["mode"] },
      ),
    );
    expect(hooks.inspectToolSchemas(deepSeekContext(normalized as never))).toStrictEqual([]);
  });

  it("normalizes parameter-free and typed-object schemas for the openai family", () => {
    const tools = [tool({}, "ping"), tool({ type: "object" }, "exec")];
    const normalized = normalizeOpenAITools(tools);

    expect(normalized.map((entry) => entry.parameters)).toEqual([strictObject(), strictObject()]);
    expect(inspectOpenAITools(tools)).toStrictEqual([]);
  });

  it.each([
    {
      title: "repairs null and inferred OpenAI tool schema types",
      input: {
        type: null,
        description: null,
        default: null,
        properties: {
          payload: {
            properties: { value: { type: "string", format: null } },
          },
          tags: {
            items: { type: "string" },
          },
        },
      },
      expected: {
        type: "object",
        properties: {
          payload: {
            type: "object",
            properties: { value: { type: "string" } },
          },
          tags: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    },
    {
      title: "keeps unrepairable null schema constraints for downstream quarantine",
      // Null constraint keywords must stay so projection quarantines the tool
      // instead of silently widening the accepted argument schema.
      input: {
        type: "object",
        properties: {
          payload: { type: null, description: "no shape hints" },
          config: { type: "object", properties: {}, additionalProperties: null },
        },
      },
      expected: {
        type: "object",
        properties: {
          payload: { type: null, description: "no shape hints" },
          config: { type: "object", properties: {}, required: [], additionalProperties: null },
        },
      },
    },
    {
      title: "preserves explicit empty properties maps when normalizing strict openai schemas",
      input: { type: "object", properties: {} },
      expected: strictObject(),
    },
  ])("$title", ({ input, expected }) => {
    expect(normalizeOpenAIParameters(input)).toEqual(expected);
  });

  it("preserves nested schemas and annotation objects while normalizing strict openai schemas", () => {
    const cases = [
      {
        name: "property schema",
        parameters: strictObject({
          properties: { payload: {} },
          required: ["payload"],
        }),
      },
      {
        name: "schema maps",
        parameters: strictObject({
          properties: { mode: { $defs: { nested: {} }, dependentSchemas: { flag: {} } } },
          required: ["mode"],
        }),
      },
      {
        name: "nested schema arrays",
        parameters: strictObject({
          properties: { mode: { anyOf: [{}], prefixItems: [{}] } },
          required: ["mode"],
        }),
      },
      {
        name: "annotation objects",
        parameters: strictObject({
          properties: { mode: { type: "string", default: {}, const: {}, examples: [{}] } },
          required: ["mode"],
        }),
      },
    ];

    for (const testCase of cases) {
      expect(normalizeOpenAIParameters(testCase.parameters), testCase.name).toEqual(
        testCase.parameters,
      );
    }
  });

  it("repairs legacy and content schema applicators without changing property dependencies", () => {
    expect(
      normalizeOpenAIParameters(
        strictObject({
          dependencies: {
            mode: ["payload"],
            payload: { type: "object" },
          },
          additionalItems: { type: "object" },
          contentSchema: { type: "object" },
        }),
      ),
    ).toEqual(
      strictObject({
        dependencies: {
          mode: ["payload"],
          payload: strictObject(),
        },
        additionalItems: strictObject(),
        contentSchema: strictObject(),
      }),
    );
  });

  it("does not tighten or warn for permissive object schemas that use strict:false", () => {
    const permissiveParameters = {
      type: "object",
      properties: {
        action: { type: "string" },
        schedule: { type: "string" },
      },
      required: ["action"],
      additionalProperties: true,
    };
    const permissiveTool = tool(permissiveParameters, "cron");
    const normalized = normalizeOpenAITools([permissiveTool]);

    expect(normalized[0]?.parameters).toEqual(permissiveParameters);
    const strictSchemaViolations = findOpenAIStrictSchemaViolations(
      permissiveParameters,
      "cron.parameters",
    );
    expect(strictSchemaViolations).toContain("cron.parameters.required.schedule");
    expect(strictSchemaViolations).toContain("cron.parameters.additionalProperties");
    expect(inspectOpenAITools([permissiveTool])).toStrictEqual([]);
  });

  it("skips openai strict-tool normalization on non-native routes", () => {
    const tools = [tool({}, "ping")];
    const route = {
      modelApi: "openai-completions",
      baseUrl: "https://example.com/v1",
    };

    expect(normalizeOpenAITools(tools, route)).toBe(tools);
    expect(inspectOpenAITools(tools, route)).toStrictEqual([]);
  });

  it("suppresses openai strict-schema diagnostics because transport falls back to strict false", () => {
    const diagnostics = inspectOpenAITools(
      [
        tool(
          {
            type: "object",
            properties: {
              mode: {
                anyOf: [{ type: "string" }, { type: "number" }],
              },
              cwd: { type: "string" },
            },
            required: ["mode"],
            additionalProperties: true,
          },
          "exec",
        ),
      ],
      {
        modelApi: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      },
    );

    expect(diagnostics).toStrictEqual([]);
  });
});
