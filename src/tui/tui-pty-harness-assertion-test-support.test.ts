import { describe, expect, it } from "vitest";
import * as oracle from "./tui-pty-harness-assertion-test-support.js";

const FRAME_START = "\x1b[?2026h";
const FRAME_END = "\x1b[?2026l";
const EXPECTED = "T08A safe T08B";
const MARKERS = ["T08A", "T08B"];
const parse = oracle.synchronizedFrameRows;
const frame = (text: string) => `${FRAME_START}${text}${FRAME_END}`;
const hasExpected = (raw: string) => oracle.hasSynchronizedFrameRow(raw, MARKERS, EXPECTED);

describe("hasSynchronizedFrameRow", () => {
  it("requires exact single-space text and all markers on one completed row", () => {
    expect(hasExpected(frame(EXPECTED))).toBe(true);
    expect(hasExpected(frame("T08A safe\r\nT08B"))).toBe(false);
    expect(hasExpected(frame("T08A\tsafe T08B"))).toBe(false);
    expect(hasExpected(frame("T08A  safe T08B"))).toBe(false);
    expect(hasExpected(`${FRAME_START}${EXPECTED}`)).toBe(false);
    expect(parse(frame("界X\r\x1b[2G?"))[0]).toEqual([" ?X"]);
    expect(parse(frame("界X\r\x1b[2G\x1b[K"))[0]).toEqual([""]);
    expect(parse(frame("\u2067RTL\u2069"))[0]).toEqual(["RTL"]);
  });
  it("rejects terminal row reconstruction false positives", () => {
    for (const raw of [
      frame("T08A safe\x1b[BT08B"),
      frame("T08A safe\r\nT08B\x1b[A"),
      frame("T08A safe\x1b[2;1HT08B"),
      frame(`${EXPECTED}\r\x1b[KT08A bad T08B`),
      `T08A safe\r\n\x1b[B${frame("T08B")}`,
      frame("T08A safe\b T08B"),
      `${FRAME_START}${EXPECTED}`,
    ]) {
      expect(hasExpected(raw)).toBe(false);
    }
    expect(
      hasExpected(frame(`\x1b[?25l\x1b[?2004h\x1b[?2031h\x1b[>7u\x1b[?u${EXPECTED}\x1b[<u`)),
    ).toBe(true);
    for (const [raw, error] of [
      [frame("safe") + "\x1b[1E", "unsupported cursor-mutating CSI"],
      [frame("safe\x1b[utext"), "unsupported cursor-mutating CSI"],
      [frame("safe\x1b[4Jtext"), "unsupported erase-display mode"],
      [frame("T08A safe\vT08B"), "unsupported terminal control"],
      [frame("T08A xxxx T08B\r\x1b[6G\x1b[4hsafe"), "unsupported cursor-mutating CSI"],
      [`${FRAME_START}safe\x1b[39${FRAME_END}`, "unsupported cursor-mutating CSI"],
      [`${FRAME_START}safe\x1b]title${FRAME_END}`, "unsupported terminal control"],
    ] as const) {
      expect(() => parse(raw)).toThrow(error);
    }

    const suffixes = "\x1b[39|\u009b39|\x1b[?2026|\x1b|\x1b]0;title\x1b|\u009d".split("|");
    for (const suffix of suffixes) {
      expect(parse(frame("safe") + suffix)).toEqual([["safe"]]);
      expect(parse(`${FRAME_START}safe${suffix}`)).toEqual([]);
    }
    expect(parse(`${FRAME_START}safe\x1b[39m${FRAME_END}`)).toEqual([["safe"]]);
  });
});
