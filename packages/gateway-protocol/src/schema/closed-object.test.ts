import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { closedObject } from "./closed-object.js";

function identity(schema: object): unknown {
  return Object.getOwnPropertyDescriptor(schema, "~openclawClosedObjectIdentity")?.value;
}

describe("closed schema identity", () => {
  it("distinguishes equal shapes without changing their JSON schema", () => {
    const first = closedObject({ sessionKey: Type.Optional(Type.String()) });
    const second = closedObject({ sessionKey: Type.Optional(Type.String()) });
    expect(identity(first)).not.toBe(identity(second));
    const serialized = JSON.stringify(first);
    expect(serialized).toBe(JSON.stringify(second));
    expect(JSON.parse(serialized)).toEqual({
      type: "object",
      properties: { sessionKey: { type: "string" } },
      additionalProperties: false,
    });
  });

  it("retains identity through TypeBox's optional deep clone", () => {
    const schema = closedObject({ sessionKey: Type.String() });
    const clone = Type.Optional(schema);
    expect(clone).not.toBe(schema);
    expect(clone.properties).not.toBe(schema.properties);
    expect(identity(clone)).toBe(identity(schema));
    expect(identity(clone)).toBeTypeOf("symbol");
  });
});
