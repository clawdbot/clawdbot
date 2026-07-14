// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  cloneConfigObject,
  removePathValue,
  sanitizeRedactedFormForSubmit,
  serializeConfigForm,
  setPathValue,
} from "./config-form-utils.ts";

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
              cost: { input: 0.5, output: 1, cacheRead: 0.1, cacheWrite: 0.2 },
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
describe("sanitizeRedactedFormForSubmit", () => {
  it("drops loaded redacted placeholders for paths missing from original raw config", () => {
    const form = {
      gateway: {
        mode: "remote",
        remote: {
          token: "__OPENCLAW_REDACTED__",
        },
      },
    };
    const originalForm = {
      gateway: {
        mode: "remote",
        remote: {
          token: "__OPENCLAW_REDACTED__",
        },
      },
    };

    expect(
      sanitizeRedactedFormForSubmit(
        form,
        originalForm,
        '{\n  gateway: {\n    mode: "remote"\n  }\n}\n',
      ),
    ).toEqual({
      gateway: {
        mode: "remote",
      },
    });
  });

  it("preserves loaded redacted placeholders that exist in original raw config", () => {
    const form = {
      gateway: {
        mode: "remote",
        remote: {
          token: "__OPENCLAW_REDACTED__",
        },
      },
    };
    const originalForm = cloneConfigObject(form);

    expect(
      sanitizeRedactedFormForSubmit(
        form,
        originalForm,
        '{\n  gateway: {\n    mode: "remote",\n    remote: {\n      token: "__OPENCLAW_REDACTED__"\n    }\n  }\n}\n',
      ),
    ).toEqual(form);
  });

  it("keeps newly entered sentinel literals so gateway validation rejects them", () => {
    const form = {
      gateway: {
        remote: {
          token: "__OPENCLAW_REDACTED__",
        },
      },
    };
    const originalForm = {
      gateway: {
        remote: {},
      },
    };

    expect(
      sanitizeRedactedFormForSubmit(
        form,
        originalForm,
        "{\n  gateway: {\n    remote: {}\n  }\n}\n",
      ),
    ).toEqual(form);
  });

  it("prunes empty object parents when they are absent from original raw config", () => {
    const form = {
      gateway: {
        remote: {
          nested: {
            token: "__OPENCLAW_REDACTED__",
          },
        },
      },
      ui: { theme: "dark" },
    };
    const originalForm = cloneConfigObject(form);

    expect(
      sanitizeRedactedFormForSubmit(form, originalForm, '{\n  ui: { theme: "dark" }\n}\n'),
    ).toEqual({
      ui: { theme: "dark" },
    });
  });

  it("does not reindex arrays when a loaded scalar array sentinel is unrestorable", () => {
    const form = {
      channels: {
        slack: {
          tokens: ["__OPENCLAW_REDACTED__", "second-token"],
        },
      },
    };
    const originalForm = cloneConfigObject(form);

    expect(
      sanitizeRedactedFormForSubmit(
        form,
        originalForm,
        '{\n  channels: { slack: { tokens: ["second-token"] } }\n}\n',
      ),
    ).toEqual(form);
  });

  it("leaves the form unchanged when original raw config cannot be parsed", () => {
    const form = {
      gateway: {
        remote: {
          token: "__OPENCLAW_REDACTED__",
        },
      },
    };
    const originalForm = cloneConfigObject(form);

    expect(sanitizeRedactedFormForSubmit(form, originalForm, "{")).toEqual(form);
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
