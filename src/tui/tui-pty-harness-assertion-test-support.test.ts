import { describe, expect, it } from "vitest";
import { hasSynchronizedFrameRow } from "./tui-pty-harness-assertion-test-support.js";

const FRAME_START = "\x1b[?2026h";
const FRAME_END = "\x1b[?2026l";

function frame(text: string) {
  return `${FRAME_START}${text}${FRAME_END}`;
}

describe("hasSynchronizedFrameRow", () => {
  it("requires exact single-space text and all markers on one completed row", () => {
    const markers = ["T08A", "T08B"];
    const expected = "T08A safe T08B";

    expect(hasSynchronizedFrameRow(frame(expected), markers, expected)).toBe(true);
    expect(hasSynchronizedFrameRow(frame("T08A safe\r\nT08B"), markers, expected)).toBe(false);
    expect(hasSynchronizedFrameRow(frame("T08A\tsafe T08B"), markers, expected)).toBe(false);
    expect(hasSynchronizedFrameRow(frame("T08A  safe T08B"), markers, expected)).toBe(false);
    expect(hasSynchronizedFrameRow(`${FRAME_START}${expected}`, markers, expected)).toBe(false);
  });
});
