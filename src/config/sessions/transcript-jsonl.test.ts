// Covers JSONL artifact batch serialization.
import { describe, expect, it } from "vitest";
import { serializeJsonlLines } from "./transcript-jsonl.js";

describe("serializeJsonlLines", () => {
  it("joins serialized lines and terminates the batch with a newline", () => {
    expect(serializeJsonlLines(['{"a":1}', '{"b":2}'])).toBe('{"a":1}\n{"b":2}\n');
  });

  it("returns an empty string for an empty batch", () => {
    expect(serializeJsonlLines([])).toBe("");
  });
});
