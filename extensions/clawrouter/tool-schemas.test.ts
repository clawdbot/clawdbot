import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { inspectPerplexityToolSchemas, normalizePerplexityToolSchemas } from "./tool-schemas.js";

function schemaContext(modelId: string, tools: unknown[]) {
  return {
    provider: "clawrouter",
    modelId,
    modelApi: "openai-responses",
    model: {
      provider: "clawrouter",
      api: "openai-responses",
      baseUrl: "https://clawrouter.openclaw.ai/v1",
      id: modelId,
    },
    tools,
  } as never;
}

describe("ClawRouter Perplexity tool schemas", () => {
  it("normalizes exec-like object maps", () => {
    const tools = [
      {
        name: "exec",
        description: "Run a command",
        parameters: {
          type: "object",
          properties: {
            env: {
              type: "object",
              patternProperties: { "^.*$": { type: "string" } },
              additionalProperties: { type: "string" },
            },
          },
          additionalProperties: false,
        },
      },
    ];

    const normalized = normalizePerplexityToolSchemas(schemaContext("perplexity/sonar-pro", tools));

    expect(normalized[0]?.parameters).toEqual({
      type: "object",
      properties: {
        env: { type: "object", properties: {} },
      },
    });
    expect(inspectPerplexityToolSchemas(schemaContext("perplexity/sonar-pro", tools))).toEqual([
      {
        toolName: "exec",
        toolIndex: 0,
        violations: [
          "exec.parameters.properties.env.patternProperties",
          "exec.parameters.properties.env.additionalProperties",
          "exec.parameters.additionalProperties",
          "exec.parameters.properties.env.properties",
        ],
      },
    ]);
  });

  it("normalizes nested unions, arrays, and definitions", () => {
    const tools = [
      {
        name: "nested",
        description: "Nested schemas",
        parameters: {
          type: "object",
          anyOf: [
            { type: "object", additionalProperties: true },
            {
              type: "array",
              items: {
                type: "object",
                properties: {
                  value: {
                    anyOf: [{ type: "object" }, { type: "string" }],
                  },
                },
              },
            },
          ],
          $defs: {
            metadata: { type: "object", patternProperties: { ".*": { type: "string" } } },
          },
        },
      },
    ];

    const normalized = normalizePerplexityToolSchemas(schemaContext("perplexity/sonar-pro", tools));

    expect(normalized[0]?.parameters).toEqual({
      type: "object",
      properties: {},
      anyOf: [
        { type: "object", properties: {} },
        {
          type: "array",
          items: {
            type: "object",
            properties: {
              value: {
                anyOf: [{ type: "object", properties: {} }, { type: "string" }],
              },
            },
          },
        },
      ],
      $defs: {
        metadata: { type: "object", properties: {} },
      },
    });
  });

  it("treats union types containing object as object schemas", () => {
    const tools = [
      {
        name: "union",
        description: "Union typed root",
        parameters: {
          type: "object",
          properties: {
            payload: { type: ["object", "null"], additionalProperties: { type: "string" } },
          },
        },
      },
    ];

    const normalized = normalizePerplexityToolSchemas(schemaContext("perplexity/sonar-pro", tools));

    expect(normalized[0]?.parameters).toEqual({
      type: "object",
      properties: {
        payload: { type: ["object", "null"], properties: {} },
      },
    });
    expect(inspectPerplexityToolSchemas(schemaContext("perplexity/sonar-pro", tools))).toEqual([
      {
        toolName: "union",
        toolIndex: 0,
        violations: [
          "union.parameters.properties.payload.additionalProperties",
          "union.parameters.properties.payload.properties",
        ],
      },
    ]);
  });

  it("traverses dependentSchemas and unevaluatedProperties containers", () => {
    const tools = [
      {
        name: "containers",
        description: "Less common schema containers",
        parameters: {
          type: "object",
          properties: {},
          dependentSchemas: {
            x: { type: "object", additionalProperties: false },
          },
          unevaluatedProperties: { type: "object" },
          additionalItems: { type: "object", additionalProperties: false },
        },
      },
    ];

    const normalized = normalizePerplexityToolSchemas(schemaContext("perplexity/sonar-pro", tools));

    expect(normalized[0]?.parameters).toEqual({
      type: "object",
      properties: {},
      dependentSchemas: {
        x: { type: "object", properties: {} },
      },
      unevaluatedProperties: { type: "object", properties: {} },
      additionalItems: { type: "object", properties: {} },
    });
  });

  it("routes only Perplexity models through the plugin-local normalizer", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const tools = [
      {
        name: "exec",
        description: "Run a command",
        parameters: { type: "object", patternProperties: { ".*": { type: "string" } } },
      },
    ];

    const perplexity = provider?.normalizeToolSchemas?.(
      schemaContext("PeRpLeXiTy/sonar-pro", tools),
    );
    const openai = provider?.normalizeToolSchemas?.(schemaContext("openai/gpt-5.5", tools));

    expect(perplexity?.[0]?.parameters).toEqual({ type: "object", properties: {} });
    expect(openai).toBe(tools);
  });
});
