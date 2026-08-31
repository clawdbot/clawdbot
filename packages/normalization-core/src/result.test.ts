import { describe, expect, it } from "vitest";
import { err, ok } from "./result.js";

describe("Result constructors", () => {
  it("creates discriminated success and failure arms", () => {
    expect(ok("value")).toEqual({ ok: true, value: "value" });
    expect(err("failure")).toEqual({ ok: false, error: "failure" });
  });
});
