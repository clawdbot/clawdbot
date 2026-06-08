// Bounded child output tests cover tail-only test child output buffering.
import { describe, expect, it } from "vitest";
import { createBoundedChildOutput } from "./bounded-child-output.js";

describe("bounded child output", () => {
  it("keeps only the latest output bytes", () => {
    const output = createBoundedChildOutput(16);

    output.append(`DO_NOT_KEEP${"x".repeat(32)}`);
    output.append("\nrecent tail");

    const text = output.text();
    expect(text).toContain("recent tail");
    expect(text).not.toContain("DO_NOT_KEEP");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(16);
  });

  it("keeps only the tail of a single oversized chunk", () => {
    const output = createBoundedChildOutput(8);

    output.append(Buffer.from("old-prefix-recent"));

    expect(output.text()).toBe("x-recent");
  });
});
