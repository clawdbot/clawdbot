import { describe, expect, it } from "vitest";
import { truncateHead } from "./truncate.js";

describe("session tool truncation facade", () => {
  it.each([
    { limit: "maxLines", options: { maxLines: -1 }, truncatedBy: "lines" as const },
    { limit: "maxBytes", options: { maxBytes: -1 }, truncatedBy: "bytes" as const },
  ])("handles empty content with a negative $limit", ({ options, truncatedBy }) => {
    expect(truncateHead("", options)).toMatchObject({
      content: "",
      truncated: true,
      truncatedBy,
      totalLines: 0,
      totalBytes: 0,
      outputLines: 0,
      outputBytes: 0,
      firstLineExceedsLimit: false,
    });
  });
});
