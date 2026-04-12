import { describe, expect, it } from "vitest";
import { resolveActiveErrorContext } from "./helpers.js";

describe("resolveActiveErrorContext", () => {
  it("returns the current provider/model", () => {
    const result = resolveActiveErrorContext({
      provider: "deepseek",
      model: "deepseek-chat",
    });
    expect(result).toEqual({ provider: "deepseek", model: "deepseek-chat" });
  });
});
