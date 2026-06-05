// Agent Core tests cover truncate behavior.
import { describe, expect, it } from "vitest";
import { truncateHead, truncateTail } from "./truncate.js";

describe("truncate utilities", () => {
  it("does not count a trailing newline as an extra display line", () => {
    expect(truncateHead("alpha\nbeta\n").totalLines).toBe(2);
    expect(truncateTail("alpha\nbeta\n").totalLines).toBe(2);
  });

  it("classifies trailing-newline truncation by the byte limit", () => {
    expect(truncateHead("x\n", { maxBytes: 1 }).truncatedBy).toBe("bytes");
    expect(truncateTail("x\n", { maxBytes: 1 }).truncatedBy).toBe("bytes");
  });

  it("keeps complete UTF-8 characters when taking a partial tail line", () => {
    const result = truncateTail("alpha🙂", { maxBytes: 4 });

    expect(result.content).toBe("🙂");
    expect(result.lastLinePartial).toBe(true);
    expect(result.outputBytes).toBe(4);
  });
});
