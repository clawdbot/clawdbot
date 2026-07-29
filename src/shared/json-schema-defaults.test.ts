import { afterEach, describe, expect, it } from "vitest";
import {
  applyJsonSchemaDefaults,
  findJsonSchemaShapeError,
  normalizeJsonSchemaForTypeBox,
} from "./json-schema-defaults.js";

describe("normalizeJsonSchemaForTypeBox", () => {
  it("combines pattern properties that collide after unicode repair", () => {
    const normalized = normalizeJsonSchemaForTypeBox({
      type: "object",
      patternProperties: {
        "^https:": { minLength: 1 },
        "^https\\:": { maxLength: 10 },
      },
    });

    expect(normalized).toMatchObject({
      patternProperties: {
        "^https:": {
          allOf: [{ minLength: 1 }, { maxLength: 10 }],
        },
      },
    });
  });

  it.each(["constructor", "toString", "__proto__"])(
    "preserves pattern property key %s",
    (pattern) => {
      const normalized = normalizeJsonSchemaForTypeBox({
        type: "object",
        patternProperties: Object.fromEntries([[pattern, { type: "string" }]]),
      });

      expect(normalized).toMatchObject({
        patternProperties: Object.fromEntries([[pattern, { type: "string" }]]),
      });
    },
  );

  it("resolves local refs to array entries beyond config path index limits", () => {
    const prefixItems: (boolean | { type: string })[] = Array.from({ length: 100_002 }, () => true);
    prefixItems[100_001] = { type: "string" };

    expect(
      findJsonSchemaShapeError({
        type: "array",
        prefixItems,
        items: { $ref: "#/prefixItems/100001" },
      }),
    ).toBeUndefined();
  });
});

describe("applyJsonSchemaDefaults prototype safety", () => {
  const readPollution = () => (Object.prototype as Record<string, unknown>).polluted;

  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).polluted;
  });

  it("does not pollute Object.prototype through a __proto__ property schema", () => {
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"object","properties":{"polluted":{"default":"yes"}}}}}',
    );

    const result = applyJsonSchemaDefaults(schema, {});

    expect(readPollution()).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(result, "polluted")).toBe(false);
  });

  it("does not pollute Object.prototype through a __proto__ pattern property schema", () => {
    const schema = JSON.parse(
      '{"type":"object","patternProperties":{".*":{"type":"object","properties":{"polluted":{"default":"yes"}}}}}',
    );
    const value = JSON.parse('{"__proto__":{}}');

    applyJsonSchemaDefaults(schema, value);

    expect(readPollution()).toBeUndefined();
  });

  it("does not pollute Object.prototype through a __proto__ additional property schema", () => {
    const schema = JSON.parse(
      '{"type":"object","additionalProperties":{"type":"object","properties":{"polluted":{"default":"yes"}}}}',
    );
    const value = JSON.parse('{"__proto__":{}}');

    applyJsonSchemaDefaults(schema, value);

    expect(readPollution()).toBeUndefined();
  });
});
