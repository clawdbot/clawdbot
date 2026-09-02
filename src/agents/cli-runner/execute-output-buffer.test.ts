import { describe, expect, it } from "vitest";
import {
  appendCliOutputTail,
  CLI_RUNNER_OUTPUT_TAIL_BYTES,
  formatCliStderrTail,
} from "./execute-output-buffer.js";

const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);
const MULTIBYTE_CHARACTER = String.fromCodePoint(0x1f642);

describe("appendCliOutputTail", () => {
  it("keeps large chunk tails UTF-8 safe when truncation starts inside a character", () => {
    const chunk = `${"x".repeat(10)}${MULTIBYTE_CHARACTER}${"y".repeat(
      CLI_RUNNER_OUTPUT_TAIL_BYTES - 3,
    )}`;

    const { tail, droppedBytes } = appendCliOutputTail("", chunk);

    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(CLI_RUNNER_OUTPUT_TAIL_BYTES);
    expect(tail).not.toContain(REPLACEMENT_CHARACTER);
    expect(tail).toBe("y".repeat(CLI_RUNNER_OUTPUT_TAIL_BYTES - 3));
    expect(droppedBytes).toBe(14);
  });

  it("keeps appended tails UTF-8 safe when rolling overflow starts inside a character", () => {
    const existingTail = `${"x".repeat(10)}${MULTIBYTE_CHARACTER}${"y".repeat(
      CLI_RUNNER_OUTPUT_TAIL_BYTES - 14,
    )}`;

    const { tail, droppedBytes } = appendCliOutputTail(existingTail, "z".repeat(11));

    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(CLI_RUNNER_OUTPUT_TAIL_BYTES);
    expect(tail).not.toContain(REPLACEMENT_CHARACTER);
    expect(tail).toBe(`${"y".repeat(CLI_RUNNER_OUTPUT_TAIL_BYTES - 14)}${"z".repeat(11)}`);
    expect(droppedBytes).toBe(14);
  });

  it("reports zero dropped bytes when the combined output fits within the cap", () => {
    const { tail, droppedBytes } = appendCliOutputTail("hello ", "world");

    expect(tail).toBe("hello world");
    expect(droppedBytes).toBe(0);
  });
});

describe("formatCliStderrTail", () => {
  it("returns the tail unchanged when no bytes were discarded", () => {
    expect(formatCliStderrTail("error details", 0)).toBe("error details");
  });

  it("prepends a discard note when bytes were discarded", () => {
    const formatted = formatCliStderrTail("error details", 1234);

    expect(formatted).toContain("1234 UTF-8 bytes of earlier stderr discarded");
    expect(formatted).toContain("error details");
  });

  it("returns only the discard note when the tail is empty but bytes were discarded", () => {
    const formatted = formatCliStderrTail("   ", 1234);

    expect(formatted).toBe(
      `[1234 UTF-8 bytes of earlier stderr discarded at the ${CLI_RUNNER_OUTPUT_TAIL_BYTES}-byte retention cap]`,
    );
  });
});
