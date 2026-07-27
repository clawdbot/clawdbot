import { describe, expect, it } from "vitest";
import { composeProtocolSchemaFragments } from "./protocol-schema-composer.js";
import { ComposedProtocolSchemas } from "./protocol-schemas-composed.js";
import { ProtocolSchemas } from "./protocol-schemas.js";

describe("composed protocol schema registry", () => {
  it("preserves legacy key order and canonical schema identities", () => {
    expect(Object.keys(ComposedProtocolSchemas)).toEqual(Object.keys(ProtocolSchemas));
    for (const key of Object.keys(ProtocolSchemas) as Array<keyof typeof ProtocolSchemas>) {
      expect(Object.is(ComposedProtocolSchemas[key], ProtocolSchemas[key]), key).toBe(true);
    }
  });

  it("rejects duplicate owner keys", () => {
    const schema = ProtocolSchemas.RequestFrame;
    expect(() =>
      composeProtocolSchemaFragments([{ RequestFrame: schema }, { RequestFrame: schema }]),
    ).toThrow("Duplicate protocol schema key: RequestFrame");
  });

  it("retains literal registry keys", () => {
    const key: keyof typeof ComposedProtocolSchemas = "RequestFrame";
    expect(key).toBe("RequestFrame");
  });
});
