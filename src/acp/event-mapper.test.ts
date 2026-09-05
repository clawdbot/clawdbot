/** Tests ACP tool-call location extraction limits. */
import { describe, expect, it } from "vitest";
import { extractToolCallLocations, formatToolTitle } from "./event-mapper.js";

describe("extractToolCallLocations", () => {
  it("enforces the global node visit cap across nested structures", () => {
    const nested = Array.from({ length: 20 }, (_, outer) =>
      Array.from({ length: 20 }, (_Local, inner) =>
        inner === 19 ? { path: `/tmp/file-${outer}.txt` } : { note: `${outer}-${inner}` },
      ),
    );

    const locations = extractToolCallLocations(nested);

    if (locations === undefined) {
      throw new Error("expected bounded tool-call locations");
    }
    expect(locations).toEqual([{ path: "/tmp/file-0.txt" }, { path: "/tmp/file-1.txt" }]);
  });
});

describe("formatToolTitle", () => {
  it("does not split surrogate pairs when truncating argument values", () => {
    const title = formatToolTitle("exec", {
      command: `${"x".repeat(99)}🚀tail`,
    });

    expect(title).toBe(`exec: command: ${"x".repeat(99)}...`);
  });
});
