import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildJsonPluginConfigSchema,
  buildPluginConfigSchema,
  emptyPluginConfigSchema,
} from "./config-schema.js";

function expectSafeParseCases(
  safeParse: ((value: unknown) => unknown) | undefined,
  cases: ReadonlyArray<readonly [unknown, unknown]>,
) {
  expect(safeParse).toBeDefined();
  expect(cases.map(([value]) => safeParse?.(value))).toEqual(cases.map(([, expected]) => expected));
}

function expectJsonSchema(
  result: ReturnType<typeof buildPluginConfigSchema>,
  expected: Record<string, unknown>,
) {
  expect(result.jsonSchema).toMatchObject(expected);
}

describe("buildPluginConfigSchema", () => {
  it("builds json schema when toJSONSchema is available", () => {
    const schema = z.strictObject({ enabled: z.boolean().default(true) });
    const result = buildPluginConfigSchema(schema);
    expectJsonSchema(result, {
      type: "object",
      additionalProperties: false,
      properties: { enabled: { type: "boolean", default: true } },
    });
  });

  it("uses input mode and strips helper-only draft metadata", () => {
    const toJSONSchema = vi.fn(() => ({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      propertyNames: { type: "string" },
      required: [],
      properties: {
        enabled: { type: "boolean", default: true },
      },
    }));
    const schema = { toJSONSchema } as unknown as Parameters<typeof buildPluginConfigSchema>[0];

    const result = buildPluginConfigSchema(schema);

    expect(toJSONSchema).toHaveBeenCalledWith({
      target: "draft-07",
      io: "input",
      unrepresentable: "any",
    });
    expect(result.jsonSchema).toEqual({
      type: "object",
      properties: {
        enabled: { type: "boolean", default: true },
      },
    });
  });

  it("falls back when toJSONSchema is missing", () => {
    const legacySchema = {} as unknown as Parameters<typeof buildPluginConfigSchema>[0];
    const result = buildPluginConfigSchema(legacySchema);
    expectJsonSchema(result, { type: "object", additionalProperties: true });
  });

  it("uses zod runtime parsing by default", () => {
    const result = buildPluginConfigSchema(z.strictObject({ enabled: z.boolean().default(true) }));
    expect(result.safeParse?.({})).toEqual({
      success: true,
      data: { enabled: true },
    });
  });

  it("allows custom safeParse overrides", () => {
    const safeParse = vi.fn(() => ({ success: true as const, data: { normalized: true } }));
    const result = buildPluginConfigSchema(z.strictObject({ enabled: z.boolean().optional() }), {
      safeParse,
    });

    expect(result.safeParse?.({ enabled: false })).toEqual({
      success: true,
      data: { normalized: true },
    });
    expect(safeParse).toHaveBeenCalledWith({ enabled: false });
  });
});

describe("buildJsonPluginConfigSchema", () => {
  it("validates direct JSON schemas without zod conversion", () => {
    const result = buildJsonPluginConfigSchema(
      {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean", default: true },
        },
      },
      { cacheKey: "config-schema.test.json-plugin" },
    );

    expect(result.jsonSchema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true },
      },
    });
    expect(result.safeParse?.({})).toEqual({
      success: true,
      data: { enabled: true },
    });
    expect(result.safeParse?.({ enabled: "yes" })).toEqual({
      success: false,
      error: { issues: [{ path: ["enabled"], message: "must be boolean" }] },
    });
  });
});

describe("emptyPluginConfigSchema", () => {
  it("accepts undefined and empty objects only", () => {
    const schema = emptyPluginConfigSchema();
    expectSafeParseCases(schema.safeParse, [
      [undefined, { success: true, data: undefined }],
      [{}, { success: true, data: {} }],
      [
        { nope: true },
        { success: false, error: { issues: [{ path: [], message: "config must be empty" }] } },
      ],
    ] as const);
  });
});
