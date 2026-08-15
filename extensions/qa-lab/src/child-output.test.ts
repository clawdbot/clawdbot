// Qa Lab tests cover child output byte caps.
import { describe, expect, it } from "vitest";
import {
  appendQaChildOutput,
  appendQaChildOutputTail,
  createQaChildOutputCapture,
  createQaChildOutputTail,
  formatQaChildOutputTail,
  readQaChildOutput,
} from "./child-output.js";

describe("qa child output", () => {
  it("keeps capped stdout UTF-8 safe when the byte cap splits a code point", () => {
    const text = "ok \u{1f600} done";
    const capture = createQaChildOutputCapture(Buffer.byteLength("ok \u{1f600}", "utf8") - 1);

    appendQaChildOutput(capture, Buffer.from(text, "utf8"));

    expect(readQaChildOutput(capture)).toBe("ok ");
  });

  it("keeps stderr tails UTF-8 safe when the retained tail starts inside a code point", () => {
    const tail = createQaChildOutputTail(Buffer.byteLength("\u{1f600}tail", "utf8") - 1);

    appendQaChildOutputTail(tail, Buffer.from("prefix \u{1f600}tail", "utf8"));

    expect(formatQaChildOutputTail(tail, "stderr")).toBe(
      "[stderr truncated to last 7 bytes]\ntail",
    );
  });

  it("preserves malformed trailing stdout when no byte cap was hit", () => {
    const capture = createQaChildOutputCapture(8);

    appendQaChildOutput(capture, Buffer.from([0x6f, 0x6b, 0x20, 0xf0]));

    expect(readQaChildOutput(capture)).toBe("ok �");
  });

  it("preserves malformed trailing stderr when no tail bytes were dropped", () => {
    const tail = createQaChildOutputTail(8);

    appendQaChildOutputTail(tail, Buffer.from([0x65, 0x72, 0x72, 0x20, 0xf0]));

    expect(formatQaChildOutputTail(tail, "stderr")).toBe("err �");
  });
});
