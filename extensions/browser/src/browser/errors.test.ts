import { describe, expect, it } from "vitest";
import { BrowserTabNotFoundError } from "./errors.js";

describe("BrowserTabNotFoundError", () => {
  it("teaches agents that bare numbers are not stable tab targets", () => {
    const err = new BrowserTabNotFoundError({ input: "2" });

    expect(err.message).toBe(
      'tab not found: browser tab "2" not found. Numeric values are not tab targets; use a stable tab id like "t1", a label, or a raw targetId. For positional selection, use "openclaw browser tab select 2".',
    );
  });
});
