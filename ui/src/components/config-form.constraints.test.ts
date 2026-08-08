// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  arrayInputConstraints,
  canApplyArrayCandidate,
  configValuesEqual,
  defaultValue,
  isSupportedConfigValueValid,
  NO_SAFE_DEFAULT,
  normalizeNumericValue,
  numericInputConstraints,
  objectPropertyKeys,
  objectPropertySchema,
  requiredPropertyKeys,
} from "./config-form.constraints.ts";
import { coerceConfigFormNumberString } from "./config-form.numeric.ts";
import type { JsonSchema } from "./config-form.shared.ts";

describe("config form schema constraints", () => {
  it("coerces only decimal and scientific config number spellings", () => {
    expect(coerceConfigFormNumberString("42.5", false)).toBe(42.5);
    expect(coerceConfigFormNumberString(".5e2", false)).toBe(50);
    expect(coerceConfigFormNumberString("-2.5E-3", false)).toBe(-0.0025);
    expect(coerceConfigFormNumberString("1e5", true)).toBe(100_000);
    expect(coerceConfigFormNumberString("", false)).toBeUndefined();

    for (const spelling of [
      "0x10",
      "0b1010",
      "0o17",
      "+5",
      "1_000",
      "Infinity",
      "NaN",
      "1e",
      "e5",
    ]) {
      expect(coerceConfigFormNumberString(spelling, false)).toBe(spelling);
    }
    expect(coerceConfigFormNumberString("42.5", true)).toBe("42.5");
  });

  it("rejects non-finite decimal rationals and schema multiples", () => {
    expect(numericInputConstraints({ type: "number", multipleOf: Number.NaN }).step).toBe("any");
    expect(
      numericInputConstraints({ type: "integer", multipleOf: Number.POSITIVE_INFINITY }).step,
    ).toBe(1);
  });

  it("aligns native numeric bounds to JSON Schema multiples", () => {
    const schema = {
      type: "integer",
      minimum: 1,
      maximum: 9,
      multipleOf: 2,
    };
    expect(numericInputConstraints(schema)).toMatchObject({ min: 2, max: 8, step: 2 });
    expect(normalizeNumericValue(9, schema)).toBe(8);
    expect(defaultValue(schema)).toBe(2);
  });

  it("does not let large-number tolerance cross a whole step", () => {
    const schema = {
      type: "number",
      minimum: 10_000_000_000_000_000,
      multipleOf: 3,
    };
    expect(numericInputConstraints(schema).min).toBe(10_000_000_000_000_002);
    expect(defaultValue(schema)).toBe(10_000_000_000_000_002);
    expect(
      isSupportedConfigValueValid({ type: "number", multipleOf: 3 }, 10_000_000_000_000_000),
    ).toBe(false);
    expect(
      isSupportedConfigValueValid({ type: "number", multipleOf: 3 }, 10_000_000_000_000_002),
    ).toBe(true);

    const decimalSchema = {
      type: "number",
      minimum: 10_000_000_000_000_002,
      multipleOf: 10,
    };
    expect(numericInputConstraints(decimalSchema).min).toBe(10_000_000_000_000_010);
    expect(defaultValue(decimalSchema)).toBe(10_000_000_000_000_010);
    expect(
      isSupportedConfigValueValid({ type: "number", multipleOf: 10 }, 10_000_000_000_000_002),
    ).toBe(false);
    expect(isSupportedConfigValueValid({ type: "number", multipleOf: 0.1 }, 0.3)).toBe(true);
    expect(isSupportedConfigValueValid({ type: "number", multipleOf: 0.1 }, 0.2 + 0.1)).toBe(true);
    expect(
      numericInputConstraints({ type: "number", minimum: -10, maximum: -10, multipleOf: 3 }),
    ).toMatchObject({ min: -9, max: -12 });
    expect(defaultValue({ type: "number", minimum: -10, maximum: -10, multipleOf: 3 })).toBe(
      NO_SAFE_DEFAULT,
    );
  });

  it("converts exclusive integer bounds into reachable native bounds", () => {
    const schema = {
      type: "integer",
      exclusiveMinimum: 2,
      exclusiveMaximum: 8,
    };
    expect(numericInputConstraints(schema)).toMatchObject({
      min: 3,
      max: 7,
      exclusiveMin: 2,
      exclusiveMax: 8,
      step: 1,
    });
  });

  it("preserves decimal step precision", () => {
    const schema = {
      type: "number",
      minimum: 0.1,
      maximum: 0.3,
      multipleOf: 0.1,
    };
    expect(normalizeNumericValue(0.2 + 0.1, schema)).toBe(0.3);
    expect(
      normalizeNumericValue(3 * 1.5e-7, {
        type: "number",
        maximum: 6e-7,
        multipleOf: 1.5e-7,
      }),
    ).toBe(4.5e-7);
  });

  it("derives integer-compatible steps from fractional multiples", () => {
    expect(numericInputConstraints({ type: "integer", multipleOf: 0.5 }).step).toBe(1);
    expect(numericInputConstraints({ type: "integer", multipleOf: 2.5 }).step).toBe(5);
    expect(normalizeNumericValue(3, { type: "integer", multipleOf: 2.5 })).toBe(5);
  });

  it("derives valid defaults for exclusive unconstrained bounds", () => {
    const schema = {
      type: "number",
      exclusiveMinimum: 0,
    };
    expect(numericInputConstraints(schema)).toMatchObject({
      min: 0,
      exclusiveMin: 0,
      step: "any",
    });
    expect(defaultValue(schema)).toBe(1);
  });

  it("normalizes one-sided exclusive bounds without jumping across the range", () => {
    const belowMaximum = normalizeNumericValue(10, {
      type: "number",
      exclusiveMaximum: 10,
    });
    const aboveMinimum = normalizeNumericValue(10, {
      type: "number",
      exclusiveMinimum: 10,
    });

    expect(belowMaximum).toBeLessThan(10);
    expect(belowMaximum).toBeGreaterThan(9);
    expect(aboveMinimum).toBeGreaterThan(10);
    expect(aboveMinimum).toBeLessThan(11);
  });

  it("derives numeric controls from intersected allOf constraints", () => {
    const schema = {
      type: "integer",
      minimum: 1,
      allOf: [{ maximum: 13 }, { multipleOf: 2 }, { multipleOf: 3 }],
    };
    expect(numericInputConstraints(schema)).toMatchObject({ min: 6, max: 12, step: 6 });
    expect(normalizeNumericValue(7, schema)).toBe(6);
    expect(
      numericInputConstraints({
        type: "number",
        allOf: [{ type: ["integer", "number"] }],
      }).step,
    ).toBe("any");
    expect(
      normalizeNumericValue(1.5, {
        type: "number",
        allOf: [{ type: ["integer", "number"] }],
      }),
    ).toBe(1.5);
  });

  it("derives array controls from intersected allOf constraints", () => {
    expect(
      arrayInputConstraints({
        type: "array",
        allOf: [
          { minItems: 1, maxItems: 4 },
          { minItems: 2, maxItems: 3, uniqueItems: true },
        ],
      }),
    ).toEqual({ minItems: 2, maxItems: 3, uniqueItems: true });
    expect(
      arrayInputConstraints({
        type: "array",
        items: [{ type: "string" }, { type: "number" }],
        additionalItems: false,
      }),
    ).toEqual({ minItems: 0, maxItems: 2, uniqueItems: false });

    let deeplyNested: JsonSchema = { maxItems: 0 };
    for (let depth = 0; depth < 40; depth += 1) {
      deeplyNested = { allOf: [deeplyNested] };
    }
    expect(
      arrayInputConstraints({
        type: "array",
        allOf: [deeplyNested],
      }).maxItems,
    ).toBe(0);
  });

  it("allows removals that move arrays toward whole-array constraints", () => {
    const schema = {
      type: "array",
      items: { type: "string" },
      const: ["a"],
    } satisfies JsonSchema;

    expect(canApplyArrayCandidate(schema, ["a", "x", "y"], ["a", "x"], false, false)).toBe(true);
    expect(canApplyArrayCandidate(schema, ["a", "x"], ["a"], false, false)).toBe(true);
    expect(canApplyArrayCandidate(schema, ["a", "x", "y"], ["x", "y"], false, false)).toBe(false);
  });

  it("validates and compares deeply nested config values without depth cutoffs", () => {
    let deeplyComposed: JsonSchema = { type: "string", minLength: 2 };
    for (let depth = 0; depth < 40; depth += 1) {
      deeplyComposed = { allOf: [deeplyComposed] };
    }
    expect(isSupportedConfigValueValid(deeplyComposed, "ok")).toBe(true);
    expect(isSupportedConfigValueValid(deeplyComposed, "x")).toBe(false);
    expect(isSupportedConfigValueValid({ type: "string", nullable: true }, null)).toBe(true);
    expect(
      isSupportedConfigValueValid({ type: "string", nullable: true, const: "fixed" }, null),
    ).toBe(false);
    expect(
      isSupportedConfigValueValid(
        { nullable: true, allOf: [{ type: "string", const: "fixed" }] },
        null,
      ),
    ).toBe(false);
    expect(isSupportedConfigValueValid({ nullable: true, enum: ["fixed"] }, null)).toBe(false);
    expect(
      isSupportedConfigValueValid(
        { nullable: true, enum: ["fixed"], enumIncludesNull: true },
        null,
      ),
    ).toBe(true);
    expect(defaultValue({ type: "string", nullable: true, default: null })).toBeNull();

    let deeplyNested: Record<string, unknown> = { value: "same" };
    for (let depth = 0; depth < 40; depth += 1) {
      deeplyNested = { child: deeplyNested };
    }
    const duplicate = structuredClone(deeplyNested);
    expect(configValuesEqual(deeplyNested, duplicate)).toBe(true);
    expect(
      isSupportedConfigValueValid(
        {
          type: "array",
          uniqueItems: true,
        },
        [deeplyNested, duplicate],
      ),
    ).toBe(false);

    const selfCycle: Record<string, unknown> = {};
    selfCycle.next = selfCycle;
    const first: Record<string, unknown> = {};
    const second: Record<string, unknown> = {};
    first.next = second;
    second.next = first;
    expect(configValuesEqual(selfCycle, selfCycle)).toBe(false);
    expect(configValuesEqual(selfCycle, first)).toBe(false);
  });

  it("collects required object properties from nested allOf schemas", () => {
    const schema = {
      type: "object",
      required: ["direct"],
      properties: { count: { type: "integer" } },
      allOf: [
        {
          required: ["composed"],
          properties: { count: { minimum: 2 } },
          allOf: [{ required: ["nested"] }],
        },
      ],
    };
    expect(requiredPropertyKeys(schema)).toEqual(new Set(["direct", "composed", "nested"]));
    const countSchema = objectPropertySchema(schema, "count");
    expect(countSchema).toBeDefined();
    expect(countSchema && isSupportedConfigValueValid(countSchema, 1)).toBe(false);
    expect(countSchema && isSupportedConfigValueValid(countSchema, 2)).toBe(true);
  });

  it("respects branch-local additional-properties scopes for composed properties", () => {
    const forbidden = {
      type: "object",
      additionalProperties: false,
      allOf: [{ properties: { mode: { type: "string" } } }],
    } satisfies JsonSchema;
    expect(objectPropertyKeys(forbidden)).toEqual([]);
    expect(objectPropertySchema(forbidden, "mode")).toBeUndefined();

    const declared = {
      type: "object",
      properties: { mode: { type: "string" } },
      additionalProperties: false,
      allOf: [{ properties: { mode: { minLength: 2 } } }],
    } satisfies JsonSchema;
    expect(objectPropertyKeys(declared)).toEqual(["mode"]);
    expect(objectPropertySchema(declared, "mode")).toMatchObject({
      type: "string",
      allOf: [{ minLength: 2 }],
    });
  });

  it("derives only defaults that the schema can prove", () => {
    expect(
      defaultValue({
        type: "object",
        required: ["mode", "weights"],
        properties: {
          mode: { type: "string", enum: ["safe", "fast"] },
          weights: {
            type: "array",
            minItems: 2,
            items: { type: "integer", minimum: 2 },
          },
        },
      }),
    ).toEqual({ mode: "safe", weights: [2, 2] });
    expect(defaultValue({ type: "string", minLength: 3 })).toBe("xxx");
    expect(defaultValue({ type: "string", minLength: 3, pattern: "^[0-9]+$" })).toBe(
      NO_SAFE_DEFAULT,
    );
    expect(defaultValue({ type: "string", enum: ["x", ""], pattern: "^$" })).toBe("");
    expect(defaultValue({ type: "integer", enum: [1, 4], minimum: 2, multipleOf: 2 })).toBe(4);
    expect(defaultValue({ type: "string", enum: ["x"], pattern: "^$" })).toBe(NO_SAFE_DEFAULT);
    expect(defaultValue({ type: "null" })).toBeNull();
    expect(defaultValue({ type: "string", allOf: [{ minLength: 3 }] })).toBe(NO_SAFE_DEFAULT);
    expect(
      defaultValue({
        type: "array",
        items: { type: "string" },
        allOf: [{ const: ["a", "b"] }],
      }),
    ).toEqual(["a", "b"]);
    expect(defaultValue({ type: "integer", default: 3, multipleOf: 2 })).toBe(NO_SAFE_DEFAULT);
    expect(defaultValue({ type: "string", minLength: 1_000_000_000 })).toBe(NO_SAFE_DEFAULT);
    expect(
      defaultValue({
        type: "array",
        minItems: 3,
        items: [{ type: "string" }, { type: "integer", minimum: 2 }],
        additionalItems: { type: "boolean" },
      }),
    ).toEqual(["", 2, false]);
    expect(
      defaultValue({
        type: "array",
        minItems: 3,
        items: [{ type: "string" }, { type: "integer" }],
        additionalItems: false,
      }),
    ).toBe(NO_SAFE_DEFAULT);
    expect(
      defaultValue({
        type: "array",
        minItems: 2,
        uniqueItems: true,
        items: { type: "string" },
      }),
    ).toBe(NO_SAFE_DEFAULT);
    expect(
      defaultValue({
        type: "array",
        minItems: 101,
        items: { type: "string" },
      }),
    ).toBe(NO_SAFE_DEFAULT);
    expect(
      defaultValue({
        type: "array",
        minItems: 101,
        items: [{ type: "string" }],
        additionalItems: { type: "string" },
      }),
    ).toBe(NO_SAFE_DEFAULT);
    expect(
      isSupportedConfigValueValid(
        {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        { constructor: "inherited-name" },
      ),
    ).toBe(false);
    expect(
      defaultValue({
        type: "object",
        required: ["constructor"],
        properties: {},
        additionalProperties: false,
      }),
    ).toBe(NO_SAFE_DEFAULT);
  });

  it("clones mutable schema defaults and repeated derived defaults", () => {
    const expectIndependentCandidates = (
      schema: JsonSchema,
      source: { nested: { enabled: boolean } },
    ) => {
      const first = defaultValue(schema) as typeof source;
      const second = defaultValue(schema) as typeof source;

      expect(first).not.toBe(source);
      expect(second).not.toBe(first);
      first.nested.enabled = false;
      expect(second.nested.enabled).toBe(true);
      expect(source.nested.enabled).toBe(true);
    };
    const explicitDefault = { nested: { enabled: true } };
    expectIndependentCandidates({ type: "object", default: explicitDefault }, explicitDefault);
    const constant = { nested: { enabled: true } };
    expectIndependentCandidates({ type: "object", const: constant }, constant);
    const enumerated = { nested: { enabled: true } };
    expectIndependentCandidates({ type: "object", enum: [enumerated] }, enumerated);

    const repeated = defaultValue({
      type: "array",
      minItems: 2,
      items: {
        type: "object",
        required: ["tags"],
        properties: {
          tags: { type: "array", default: ["primary"] },
        },
      },
    }) as Array<{ tags: string[] }>;

    expect(repeated).toHaveLength(2);
    expect(repeated[0]).not.toBe(repeated[1]);
    expect(repeated[0]?.tags).not.toBe(repeated[1]?.tags);
    repeated[0]?.tags.push("changed");
    expect(repeated[1]?.tags).toEqual(["primary"]);
  });
});
