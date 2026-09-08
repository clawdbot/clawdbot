import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { HelloOkSchema } from "./frames.js";

describe("hello authentication method", () => {
  const auth = { role: "operator", scopes: ["operator.read"] };

  it.each([
    "none",
    "token",
    "password",
    "tailscale",
    "device-token",
    "bootstrap-token",
    "trusted-proxy",
  ])("accepts the %s authentication method", (method) => {
    expect(Value.Check(HelloOkSchema.properties.auth, { ...auth, method })).toBe(true);
  });

  it("keeps the method optional and rejects unknown or malformed methods", () => {
    expect(Value.Check(HelloOkSchema.properties.auth, auth)).toBe(true);
    for (const method of ["unknown", "", null, 1]) {
      expect(Value.Check(HelloOkSchema.properties.auth, { ...auth, method })).toBe(false);
    }
  });
});
