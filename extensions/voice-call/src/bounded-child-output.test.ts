// Voice Call tests cover bounded child output plugin behavior.
import { describe, expect, it } from "vitest";
import {
  appendBoundedChildOutput,
  emptyBoundedChildOutput,
  formatBoundedChildOutput,
} from "./bounded-child-output.js";

describe("bounded child output", () => {
  it("keeps a bounded tail and records truncation", () => {
    const first = appendBoundedChildOutput(emptyBoundedChildOutput(), "abcdef", 5);
    expect(first).toEqual({ text: "bcdef", truncated: true });

    const second = appendBoundedChildOutput(first, "ghij", 5);
    expect(second).toEqual({ text: "fghij", truncated: true });
    expect(formatBoundedChildOutput(second)).toBe("[output truncated]\nfghij");
  });
});
