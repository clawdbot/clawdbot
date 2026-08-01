import { describe, expect, it } from "vitest";
import { appendCliOutputTail } from "./execute-output-buffer.js";

const CLI_RUNNER_OUTPUT_TAIL_BYTES = 64 * 1024;
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);
const MULTIBYTE_CHARACTER = String.fromCodePoint(0x1f642);

describe("appendCliOutputTail", () => {
  it("keeps large chunk tails UTF-8 safe when truncation starts inside a character", () => {
    const chunk = `${"x".repeat(10)}${MULTIBYTE_CHARACTER}${"y".repeat(
      CLI_RUNNER_OUTPUT_TAIL_BYTES - 3,
    )}`;

    const output = appendCliOutputTail("", chunk);

    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(CLI_RUNNER_OUTPUT_TAIL_BYTES);
    expect(output).not.toContain(REPLACEMENT_CHARACTER);
    expect(output).toBe("y".repeat(CLI_RUNNER_OUTPUT_TAIL_BYTES - 3));
  });

  it("keeps appended tails UTF-8 safe when rolling overflow starts inside a character", () => {
    const existingTail = `${"x".repeat(10)}${MULTIBYTE_CHARACTER}${"y".repeat(
      CLI_RUNNER_OUTPUT_TAIL_BYTES - 14,
    )}`;

    const output = appendCliOutputTail(existingTail, "z".repeat(11));

    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(CLI_RUNNER_OUTPUT_TAIL_BYTES);
    expect(output).not.toContain(REPLACEMENT_CHARACTER);
    expect(output).toBe(`${"y".repeat(CLI_RUNNER_OUTPUT_TAIL_BYTES - 14)}${"z".repeat(11)}`);
  });
});
