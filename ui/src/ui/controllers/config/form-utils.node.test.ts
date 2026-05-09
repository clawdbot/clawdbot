// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { JsonSchema } from "../../views/config-form.shared.ts";
import { coerceFormValues } from "./form-coerce.ts";
import {
  cloneConfigObject,
  removePathValue,
  serializeConfigForm,
  setPathValue,
} from "./form-utils.ts";

/**
 * Minimal model provider schema matching the Zod-generated JSON Schema for
 * `models.providers` (see zod-schema.core.ts → ModelDefinitionSchema).
 */
const modelDefinitionSchema: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    reasoning: { type: "boolean" },
    contextWindow: { type: "number" },
    maxTokens: { type: "number" },
    cost: {
      type: "object",
      properties: {
        input: { type: "number" },
        output: { type: "number" },
        cacheRead: { type: "number" },
        cacheWrite: { type: "number" },
      },
    },
  },
};

const modelProviderSchema: JsonSchema = {
  type: "object",
  properties: {
    baseUrl: { type: "string" },
    apiKey: { type: "string" },
    models: {
      type: "array",
      items: modelDefinitionSchema,
    },
  },
};

const modelsConfigSchema: JsonSchema = {
  type: "object",
  properties: {
    providers: {
      type: "object",
      additionalProperties: modelProviderSchema,
    },
  },
};

const topLevelSchema: JsonSchema = {
  type: "object",
  properties: {
    gateway: {
      type: "object",
      properties: {
        auth: {
          type: "object",
          properties: {
            token: { type: "string" },
          },
        },
      },
    },
    models: modelsConfigSchema,
  },
};

function makeConfigWithProvider(): Record<string, unknown> {
  return {
    gateway: { auth: { token: "test-token" } },
    models: {
      providers: {
        xai: {
          baseUrl: "https://api.x.ai/v1",
          models: [
            {
              id: "grok-4",
              name: "Grok 4",
              contextWindow: 131072,
              maxTokens: 8192,
              cost: { input: 0.5, output: 1.0, cacheRead: 0.1, cacheWrite: 0.2 },
            },
          ],
        },
      },
    },
  };
}

function getFirstXaiModel(payload: Record<string, unknown>): Record<string, unknown> {
  const model = payload.models as Record<string, unknown>;
  const providers = model.providers as Record<string, unknown>;
  const xai = providers.xai as Record<string, unknown>;
  const models = xai.models as Array<Record<string, unknown>>;
  return models[0] ?? {};
}

function expectNumericModelCore(model: Record<string, unknown>) {
  expect(typeof model.maxTokens).toBe("number");
  expect(model.maxTokens).toBe(8192);
  expect(typeof model.contextWindow).toBe("number");
  expect(model.contextWindow).toBe(131072);
}

describe("form-utils preserves numeric types", () => {
  it("serializeConfigForm preserves numbers in JSON output", () => {
    const form = makeConfigWithProvider();
    const raw = serializeConfigForm(form);
    const parsed = JSON.parse(raw);
    const model = parsed.models.providers.xai.models[0] as Record<string, unknown>;
    const cost = model.cost as Record<string, unknown>;

    expectNumericModelCore(model);
    expect(typeof cost.input).toBe("number");
    expect(cost.input).toBe(0.5);
  });

  it("cloneConfigObject + setPathValue preserves unrelated numeric fields", () => {
    const form = makeConfigWithProvider();
    const cloned = cloneConfigObject(form);
    setPathValue(cloned, ["gateway", "auth", "token"], "new-token");
    const first = getFirstXaiModel(cloned);

    expectNumericModelCore(first);
    expect(typeof first.cost).toBe("object");
    expect(typeof (first.cost as Record<string, unknown>).input).toBe("number");
  });
});

describe("prototype pollution prevention", () => {
  it("setPathValue rejects __proto__ in path", () => {
    const obj: Record<string, unknown> = {};
    setPathValue(obj, ["__proto__", "polluted"], true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(obj)).toBe(Object.prototype);
  });

  it("setPathValue rejects constructor in path", () => {
    const obj: Record<string, unknown> = {};
    setPathValue(obj, ["constructor", "prototype", "polluted"], true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("setPathValue rejects prototype in path", () => {
    const obj: Record<string, unknown> = {};
    setPathValue(obj, ["prototype", "bad"], true);
    expect(obj).toStrictEqual({});
  });

  it("removePathValue rejects __proto__ in path", () => {
    const obj = { safe: 1 } as Record<string, unknown>;
    removePathValue(obj, ["__proto__", "toString"]);
    expect("toString" in {}).toBe(true);
  });

  it("setPathValue allows normal keys", () => {
    const obj: Record<string, unknown> = {};
    setPathValue(obj, ["a", "b"], 42);
    expect((obj.a as Record<string, unknown>).b).toBe(42);
  });
});

describe("coerceFormValues", () => {
  it("coerces string numbers to numbers based on schema", () => {
    const form = {
      models: {
        providers: {
          xai: {
            baseUrl: "https://api.x.ai/v1",
            models: [
              {
                id: "grok-4",
                name: "Grok 4",
                contextWindow: "131072",
                maxTokens: "8192",
                cost: { input: "0.5", output: "1.0", cacheRead: "0.1", cacheWrite: "0.2" },
              },
            ],
          },
        },
      },
    };

    const coerced = coerceFormValues(form, topLevelSchema) as Record<string, unknown>;
    const first = getFirstXaiModel(coerced);

    expectNumericModelCore(first);
    expect(typeof first.cost).toBe("object");
    const cost = first.cost as Record<string, number>;
    expect(typeof cost.input).toBe("number");
    expect(cost.input).toBe(0.5);
    expect(typeof cost.output).toBe("number");
    expect(cost.output).toBe(1);
    expect(typeof cost.cacheRead).toBe("number");
    expect(cost.cacheRead).toBe(0.1);
    expect(typeof cost.cacheWrite).toBe("number");
    expect(cost.cacheWrite).toBe(0.2);
  });

  it("preserves already-correct numeric values", () => {
    const form = makeConfigWithProvider();
    const coerced = coerceFormValues(form, topLevelSchema) as Record<string, unknown>;
    const first = getFirstXaiModel(coerced);
    expect(typeof first.maxTokens).toBe("number");
    expect(first.maxTokens).toBe(8192);
  });

  it("does not coerce non-numeric strings to numbers", () => {
    const form = {
      models: {
        providers: {
          xai: {
            baseUrl: "https://api.x.ai/v1",
            models: [
              {
                id: "grok-4",
                name: "Grok 4",
                maxTokens: "not-a-number",
              },
            ],
          },
        },
      },
    };

    const coerced = coerceFormValues(form, topLevelSchema) as Record<string, unknown>;
    const first = getFirstXaiModel(coerced);

    expect(first.maxTokens).toBe("not-a-number");
  });

  it("coerces string booleans to booleans based on schema", () => {
    const form = {
      models: {
        providers: {
          xai: {
            baseUrl: "https://api.x.ai/v1",
            models: [
              {
                id: "grok-4",
                name: "Grok 4",
                reasoning: "true",
              },
            ],
          },
        },
      },
    };

    const coerced = coerceFormValues(form, topLevelSchema) as Record<string, unknown>;
    const first = getFirstXaiModel(coerced);
    expect(first.reasoning).toBe(true);
  });

  it("handles empty string for number fields as undefined", () => {
    const form = {
      models: {
        providers: {
          xai: {
            baseUrl: "https://api.x.ai/v1",
            models: [
              {
                id: "grok-4",
                name: "Grok 4",
                maxTokens: "",
              },
            ],
          },
        },
      },
    };

    const coerced = coerceFormValues(form, topLevelSchema) as Record<string, unknown>;
    const first = getFirstXaiModel(coerced);
    expect(first.maxTokens).toBeUndefined();
  });

  it("passes through null and undefined values untouched", () => {
    expect(coerceFormValues(null, topLevelSchema)).toBeNull();
    expect(coerceFormValues(undefined, topLevelSchema)).toBeUndefined();
  });

  it("handles anyOf schemas with number variant", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        timeout: {
          anyOf: [{ type: "number" }, { type: "string" }],
        },
      },
    };
    const form = { timeout: "30" };
    const coerced = coerceFormValues(form, schema) as Record<string, unknown>;
    expect(typeof coerced.timeout).toBe("number");
    expect(coerced.timeout).toBe(30);
  });

  it("handles integer schema type", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        count: { type: "integer" },
      },
    };
    const form = { count: "42" };
    const coerced = coerceFormValues(form, schema) as Record<string, unknown>;
    expect(typeof coerced.count).toBe("number");
    expect(coerced.count).toBe(42);
  });

  it("rejects non-integer string for integer schema type", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        count: { type: "integer" },
      },
    };
    const form = { count: "1.5" };
    const coerced = coerceFormValues(form, schema) as Record<string, unknown>;
    expect(coerced.count).toBe("1.5");
  });

  it("does not coerce non-finite numeric strings", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        timeout: { type: "number" },
      },
    };
    const form = { timeout: "Infinity" };
    const coerced = coerceFormValues(form, schema) as Record<string, unknown>;
    expect(coerced.timeout).toBe("Infinity");
  });

  it("supports allOf schema composition", () => {
    const schema: JsonSchema = {
      allOf: [
        {
          type: "object",
          properties: {
            port: { type: "number" },
          },
        },
        {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
          },
        },
      ],
    };
    const form = { port: "8080", enabled: "true" };
    const coerced = coerceFormValues(form, schema) as Record<string, unknown>;
    expect(coerced.port).toBe(8080);
    expect(coerced.enabled).toBe(true);
  });

  it("recurses into object inside anyOf (nullable pattern)", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        settings: {
          anyOf: [
            {
              type: "object",
              properties: {
                port: { type: "number" },
                enabled: { type: "boolean" },
              },
            },
            { type: "null" },
          ],
        },
      },
    };
    const form = { settings: { port: "8080", enabled: "true" } };
    const coerced = coerceFormValues(form, schema) as Record<string, unknown>;
    const settings = coerced.settings as Record<string, unknown>;
    expect(typeof settings.port).toBe("number");
    expect(settings.port).toBe(8080);
    expect(settings.enabled).toBe(true);
  });

  it("recurses into array inside anyOf", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        items: {
          anyOf: [
            {
              type: "array",
              items: { type: "object", properties: { count: { type: "number" } } },
            },
            { type: "null" },
          ],
        },
      },
    };
    const form = { items: [{ count: "5" }] };
    const coerced = coerceFormValues(form, schema) as Record<string, unknown>;
    const items = coerced.items as Array<Record<string, unknown>>;
    expect(typeof items[0].count).toBe("number");
    expect(items[0].count).toBe(5);
  });

  it("handles tuple array schemas by index", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        pair: {
          type: "array",
          items: [{ type: "string" }, { type: "number" }],
        },
      },
    };
    const form = { pair: ["hello", "42"] };
    const coerced = coerceFormValues(form, schema) as Record<string, unknown>;
    const pair = coerced.pair as unknown[];
    expect(pair[0]).toBe("hello");
    expect(typeof pair[1]).toBe("number");
    expect(pair[1]).toBe(42);
  });

  it("preserves tuple indexes when a value is cleared", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        tuple: {
          type: "array",
          items: [{ type: "string" }, { type: "number" }, { type: "string" }],
        },
      },
    };
    const form = { tuple: ["left", "", "right"] };
    const coerced = coerceFormValues(form, schema) as Record<string, unknown>;
    const tuple = coerced.tuple as unknown[];
    expect(tuple).toHaveLength(3);
    expect(tuple[0]).toBe("left");
    expect(tuple[1]).toBeUndefined();
    expect(tuple[2]).toBe("right");
  });

  it("omits cleared number field from object output", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        name: { type: "string" },
        port: { type: "number" },
      },
    };
    const form = { name: "test", port: "" };
    const coerced = coerceFormValues(form, schema) as Record<string, unknown>;
    expect(coerced.name).toBe("test");
    expect("port" in coerced).toBe(false);
  });

  it("filters undefined from array when number item is cleared", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        values: {
          type: "array",
          items: { type: "number" },
        },
      },
    };
    const form = { values: ["1", "", "3"] };
    const coerced = coerceFormValues(form, schema) as Record<string, unknown>;
    const values = coerced.values as number[];
    expect(values).toEqual([1, 3]);
  });

  it("coerces boolean in anyOf union", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        flag: {
          anyOf: [{ type: "boolean" }, { type: "string" }],
        },
      },
    };
    const form = { flag: "true" };
    const coerced = coerceFormValues(form, schema) as Record<string, unknown>;
    expect(coerced.flag).toBe(true);
  });
});
