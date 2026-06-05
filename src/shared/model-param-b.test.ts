// Model parameter B tests cover reasoning budget normalization and aliases.
import { describe, expect, it } from "vitest";
import { inferParamBFromIdOrName } from "./model-param-b.js";

describe("shared/model-param-b", () => {
  it("extracts the largest valid b-sized parameter token", () => {
    expect(inferParamBFromIdOrName("llama-8b mixtral-22b")).toBe(22);
    expect(inferParamBFromIdOrName("Qwen 0.5B Instruct")).toBe(0.5);
    expect(inferParamBFromIdOrName("prefix M7B and q4_32b")).toBe(32);
    expect(inferParamBFromIdOrName("(70b) + m1.5b + qwen-14b")).toBe(70);
  });

  it("ignores malformed, zero, and non-delimited matches", () => {
    expect(inferParamBFromIdOrName("abc70beta 0b x70b2")).toBeNull();
    expect(inferParamBFromIdOrName("model 0b")).toBeNull();
    expect(inferParamBFromIdOrName("model b5")).toBeNull();
    expect(inferParamBFromIdOrName("foo70bbar")).toBeNull();
    expect(inferParamBFromIdOrName("ab7b model")).toBeNull();
  });
});
