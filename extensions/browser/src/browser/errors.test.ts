import { describe, expect, it } from "vitest";
import { BrowserTabNotFoundError } from "./errors.js";

describe("BrowserTabNotFoundError", () => {
  it("teaches agents that bare numbers are not stable tab targets", () => {
    const err = new BrowserTabNotFoundError({ input: "2" });

    expect(err.message).toContain('browser tab "2" not found');
    expect(err.message).toContain("Numeric values are not tab targets");
    expect(err.message).toContain("openclaw browser tab select 2");
  });
});
