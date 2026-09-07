import type { TSchema } from "typebox";
import { describe, expect, it } from "vitest";
import { composeProtocolSchemaFragments } from "./protocol-schema-composer.js";

describe("composeProtocolSchemaFragments", () => {
  it("preserves fragment and key order without replacing schema objects", () => {
    const first = {} as TSchema;
    const second = {} as TSchema;
    const registry = composeProtocolSchemaFragments([{ First: first }, { Second: second }]);

    expect(Object.keys(registry)).toEqual(["First", "Second"]);
    expect(Object.is(registry.First, first)).toBe(true);
    expect(Object.is(registry.Second, second)).toBe(true);
  });

  it("rejects duplicate owner keys", () => {
    const schema = {} as TSchema;
    expect(() => composeProtocolSchemaFragments([{ Shared: schema }, { Shared: schema }])).toThrow(
      "Duplicate protocol schema key: Shared",
    );
  });

  it("retains literal registry keys", () => {
    const registry = composeProtocolSchemaFragments([{ RequestFrame: {} as TSchema }]);
    const key: keyof typeof registry = "RequestFrame";
    expect(key).toBe("RequestFrame");
  });
});
