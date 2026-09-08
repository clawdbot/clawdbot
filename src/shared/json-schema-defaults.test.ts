import {
  isJsonSchemaValueValid,
  jsonSchemaValuesEqual,
  normalizeJsonSchemaForTypeBox,
} from "@openclaw/normalization-core/json-schema";
import { afterEach, describe, expect, it } from "vitest";
import { applyJsonSchemaDefaults, findJsonSchemaShapeError } from "./json-schema-defaults.js";

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

  it.each(["#%", "#foo%zz", "#anchor%"])(
    "reports malformed percent-encoding in local ref anchor %s as unresolved instead of throwing",
    (ref) => {
      expect(findJsonSchemaShapeError({ $ref: ref })).toBe("<schema>.$ref: unresolved ref");
    },
  );

  it("preserves Control UI nullable value semantics", () => {
    const schema = {
      type: "string",
      enum: ["fixed"],
      nullable: true,
      enumIncludesNull: true,
    };

    expect(isJsonSchemaValueValid(schema, "fixed")).toBe(true);
    expect(isJsonSchemaValueValid(schema, null)).toBe(true);
    expect(isJsonSchemaValueValid(schema, "other")).toBe(false);
    expect(isJsonSchemaValueValid({ nullable: true }, null)).toBe(true);
    expect(isJsonSchemaValueValid({ type: "string", nullable: true, minLength: 2 }, null)).toBe(
      true,
    );
    expect(isJsonSchemaValueValid({ type: "string", nullable: true, const: "fixed" }, null)).toBe(
      false,
    );
    expect(isJsonSchemaValueValid({ nullable: true, enum: ["fixed"] }, null)).toBe(false);
    expect(isJsonSchemaValueValid({ enum: ["fixed"], enumIncludesNull: true }, null)).toBe(false);
  });

  it("keeps schema resources outside expanded type branches", () => {
    const schema = {
      $id: "https://example.test/config",
      $defs: {
        value: { type: "string" },
      },
      type: ["object", "null"],
      properties: {
        value: { $ref: "#/$defs/value" },
      },
      required: ["value"],
    };

    expect(normalizeJsonSchemaForTypeBox(schema)).toEqual({
      $id: "https://example.test/config",
      $defs: {
        value: { type: "string" },
      },
      anyOf: [
        {
          properties: {
            value: { $ref: "#/$defs/value" },
          },
          required: ["value"],
          type: "object",
        },
        {
          properties: {
            value: { $ref: "#/$defs/value" },
          },
          required: ["value"],
          type: "null",
        },
      ],
    });
    expect(isJsonSchemaValueValid(schema, { value: "ok" })).toBe(true);
    expect(isJsonSchemaValueValid(schema, { value: 1 })).toBe(false);
  });

  it("rejects cyclic values without recursing indefinitely", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(isJsonSchemaValueValid({ type: "object" }, cyclic)).toBe(false);
    expect(jsonSchemaValuesEqual(cyclic, cyclic)).toBe(false);
  });

  it("rejects values that JSON serialization would change or discard", () => {
    const arrayWithExtraProperty = Object.assign(["kept"], { discarded: true });
    const invalidValues = [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      () => "discarded",
      Symbol("discarded"),
      1n,
      { nested: undefined },
      [Number.NEGATIVE_INFINITY],
      Array(1),
      new Date(0),
      arrayWithExtraProperty,
    ];

    for (const value of invalidValues) {
      expect(isJsonSchemaValueValid({}, value)).toBe(false);
      expect(jsonSchemaValuesEqual(value, value)).toBe(false);
    }
    expect(isJsonSchemaValueValid({}, { nested: [null, true, 1, "ok"] })).toBe(true);
    expect(isJsonSchemaValueValid({}, Object.assign(Object.create(null), { value: "ok" }))).toBe(
      true,
    );
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

describe("JSON Schema child traversal", () => {
  it.each([
    ["$defs", "map"],
    ["definitions", "map"],
    ["dependentSchemas", "map"],
    ["patternProperties", "map"],
    ["properties", "map"],
    ["dependencies", "map"],
    ["additionalItems", "value"],
    ["additionalProperties", "value"],
    ["contains", "value"],
    ["else", "value"],
    ["if", "value"],
    ["items", "value"],
    ["not", "value"],
    ["propertyNames", "value"],
    ["then", "value"],
    ["unevaluatedItems", "value"],
    ["unevaluatedProperties", "value"],
    ["items", "array"],
    ["allOf", "array"],
    ["anyOf", "array"],
    ["oneOf", "array"],
    ["prefixItems", "array"],
  ])("resolves refs through %s (%s)", (keyword, shape) => {
    for (const [identifier, ref] of [
      ["$anchor", "#target"],
      ["$id", "target"],
    ] as const) {
      const target = { [identifier]: "target", default: "selected" };
      const child =
        shape === "map"
          ? { ignored: true, denied: false, target }
          : shape === "array"
            ? [true, false, target]
            : target;
      const schema = { $ref: ref, [keyword]: child };

      expect(findJsonSchemaShapeError(schema)).toBeUndefined();
      expect(applyJsonSchemaDefaults(schema, undefined)).toBe("selected");
    }
  });

  it.each([
    ["$anchor", "#target"],
    ["$id", "target"],
  ])("materializes map entries but stops after the first %s match", (identifier, ref) => {
    const reads: string[] = [];
    const schema = {
      $ref: ref,
      $defs: {
        get first() {
          reads.push("first");
          return { [identifier]: "target", default: "first" };
        },
        get second() {
          reads.push("second");
          return { [identifier]: "target", default: "second" };
        },
      },
      get definitions() {
        reads.push("later group");
        return { target: { [identifier]: "target", default: "later" } };
      },
    };

    expect(applyJsonSchemaDefaults(schema, undefined)).toBe("first");
    expect(reads).toEqual(["first", "second"]);
  });

  it.each(["", "nested"])("does not cross the nested resource boundary %j for anchors", ($id) => {
    const schema = {
      $ref: "#target",
      $defs: { nested: { $id, $anchor: "target", default: "not local" } },
    };

    expect(findJsonSchemaShapeError(schema)).toBe("<schema>.$ref: unresolved ref");
    expect(applyJsonSchemaDefaults(schema, undefined)).toBeUndefined();
  });

  it("ignores property dependencies while resolving a schema dependency", () => {
    const schema = {
      $ref: "#target",
      dependencies: {
        empty: [],
        property: ["required"],
        schema: { $anchor: "target", default: "selected" },
      },
    };

    expect(findJsonSchemaShapeError(schema)).toBeUndefined();
    expect(applyJsonSchemaDefaults(schema, undefined)).toBe("selected");
  });

  it("settles reverse-ordered dependent schemas beyond the root property count", () => {
    const schema = {
      properties: { a: { default: true } },
      dependentSchemas: Object.fromEntries(
        (
          [
            ["e", "f"],
            ["d", "e"],
            ["c", "d"],
            ["b", "c"],
            ["a", "b"],
          ] as const
        ).map(([trigger, added]) => [trigger, { properties: { [added]: { default: true } } }]),
      ),
    };

    expect(applyJsonSchemaDefaults(schema, {})).toEqual({
      a: true,
      b: true,
      c: true,
      d: true,
      e: true,
      f: true,
    });
  });
});

describe("applyJsonSchemaDefaults patternProperties safety", () => {
  it("skips nested-repetition patternProperties instead of compiling them", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "(a+)+$": {
          type: "object",
          properties: {
            mode: { type: "string", default: "applied" },
          },
        },
      },
    };
    const value = { aaaaaaaaaaaaaaaaaaaaX: {} };

    const started = Date.now();
    const result = applyJsonSchemaDefaults(schema, value) as {
      aaaaaaaaaaaaaaaaaaaaX: { mode?: string };
    };
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(250);
    expect(result.aaaaaaaaaaaaaaaaaaaaX.mode).toBeUndefined();
  });

  it("still applies defaults through safe patternProperties", () => {
    const schema = {
      type: "object",
      patternProperties: {
        "^x": {
          type: "object",
          properties: {
            mode: { type: "string", default: "auto" },
          },
        },
      },
    };

    const result = applyJsonSchemaDefaults(schema, { x1: {} }) as {
      x1: { mode?: string };
    };
    expect(result.x1.mode).toBe("auto");
  });
});
