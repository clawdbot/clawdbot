import { describe, expect, it } from "vitest";
import {
  appendUtf8Lines,
  createUtf8LineAccumulator,
  flushUtf8Line,
} from "./utf8-line-accumulator.js";

describe("UTF-8 line accumulator", () => {
  it("preserves split UTF-8 and split CRLF delimiters", () => {
    const accumulator = createUtf8LineAccumulator();
    const line = Buffer.from("诊断 你好\r\n", "utf8");
    const split = line.indexOf(0xbd);

    expect(
      appendUtf8Lines({
        accumulator,
        chunk: line.subarray(0, split),
        maxPendingLineBytes: 8 * 1024,
        splitOnCarriageReturn: true,
      }),
    ).toEqual([]);
    expect(
      appendUtf8Lines({
        accumulator,
        chunk: line.subarray(split),
        maxPendingLineBytes: 8 * 1024,
        splitOnCarriageReturn: true,
      }),
    ).toEqual([{ line: "诊断 你好", truncated: false }]);
    expect(flushUtf8Line(accumulator, 8 * 1024)).toBeUndefined();
  });

  it("bounds completed and trailing lines without breaking UTF-8", () => {
    const accumulator = createUtf8LineAccumulator();
    const oversized = "诊".repeat(3_000);

    const completed = appendUtf8Lines({
      accumulator,
      chunk: `${oversized}\n尾行`,
      maxPendingLineBytes: 8 * 1024,
      maxLineBytes: 8 * 1024,
    });
    expect(completed).toHaveLength(1);
    expect(completed[0]?.truncated).toBe(true);
    expect(completed[0]?.line).toBe("诊".repeat(2_730));
    expect(flushUtf8Line(accumulator, 8 * 1024)).toEqual({
      line: "尾行",
      truncated: false,
    });
  });
});
