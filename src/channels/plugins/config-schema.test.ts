import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildChannelConfigSchema,
  buildJsonChannelConfigSchema,
  emptyChannelConfigSchema,
} from "./config-schema.js";

describe("buildChannelConfigSchema", () => {
  it("builds json schema when toJSONSchema is available", () => {
    const schema = z.object({ enabled: z.boolean().default(true) });
    const result = buildChannelConfigSchema(schema);
    expect(result.schema).toMatchObject({ type: "object" });
  });

  it("falls back when toJSONSchema is missing (zod v3 plugin compatibility)", () => {
    const legacySchema = {} as unknown as Parameters<typeof buildChannelConfigSchema>[0];
    const result = buildChannelConfigSchema(legacySchema);
    expect(result.schema).toEqual({ type: "object", additionalProperties: true });
  });

  it("passes draft-07 compatibility options to toJSONSchema", () => {
    const toJSONSchema = vi.fn(() => ({
      type: "object",
      properties: { enabled: { type: "boolean" } },
    }));
    const schema = { toJSONSchema } as unknown as Parameters<typeof buildChannelConfigSchema>[0];

    const result = buildChannelConfigSchema(schema);

    expect(toJSONSchema).toHaveBeenCalledWith({
      target: "draft-07",
      unrepresentable: "any",
    });
    expect(result.schema).toEqual({
      type: "object",
      properties: { enabled: { type: "boolean" } },
    });
  });

  it("passes through ui hints and exposes a runtime parser", () => {
    const result = buildChannelConfigSchema(z.object({ enabled: z.boolean().default(true) }), {
      uiHints: { enabled: { label: "Enabled" } },
    });

    expect(result.uiHints).toEqual({ enabled: { label: "Enabled" } });
    expect(result.runtime?.safeParse({})).toEqual({
      success: true,
      data: { enabled: true },
    });
  });
});

describe("buildJsonChannelConfigSchema", () => {
  it("validates direct JSON schemas without zod conversion", () => {
    const result = buildJsonChannelConfigSchema(
      {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean", default: true },
        },
      },
      { cacheKey: "config-schema.test.json-channel" },
    );

    expect(result.schema).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", default: true },
      },
    });
    expect(result.runtime?.safeParse({})).toEqual({
      success: true,
      data: { enabled: true },
    });
    expect(result.runtime?.safeParse({ enabled: "yes" })).toEqual({
      success: false,
      issues: [{ path: ["enabled"], message: "must be boolean" }],
    });
  });
});

describe("emptyChannelConfigSchema", () => {
  it("accepts undefined and empty objects only", () => {
    const result = emptyChannelConfigSchema();

    expect(result.runtime?.safeParse(undefined)).toEqual({
      success: true,
      data: undefined,
    });
    expect(result.runtime?.safeParse({})).toEqual({
      success: true,
      data: {},
    });
    expect(result.runtime?.safeParse({ enabled: true })).toEqual({
      success: false,
      issues: [{ path: [], message: "config must be empty" }],
    });
  });
});
