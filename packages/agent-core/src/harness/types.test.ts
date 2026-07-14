import { describe, expect, it } from "vitest";
import { toError } from "./types.js";

describe("toError", () => {
  it("preserves the shipped facade semantics", () => {
    const thrown = { code: "E_TEST", detail: "structured" };

    const error = toError(thrown);

    expect(error.message).toBe('{"code":"E_TEST","detail":"structured"}');
    expect(error).not.toHaveProperty("cause");
  });
});
