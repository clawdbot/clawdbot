import { describe, expect, it } from "vitest";
import * as oracle from "./tui-pty-harness-assertion-test-support.js";

const FRAME_START = "\x1b[?2026h";
const FRAME_END = "\x1b[?2026l";
const EXPECTED = "T08A safe T08B";
const MARKERS = ["T08A", "T08B"];
const TERMINAL = { cols: 32, rows: 4 };
const parse = (raw: string, dimensions = TERMINAL) => oracle.synchronizedFrameRows(raw, dimensions);
const frame = (text: string) => `${FRAME_START}${text}${FRAME_END}`;
const hasExpected = (raw: string, dimensions = TERMINAL) =>
  oracle.hasSynchronizedFrameRow(raw, MARKERS, EXPECTED, dimensions);
const hasHistoricalExpected = (raw: string, dimensions = TERMINAL) =>
  oracle.hasHistoricalSynchronizedFrameRow(raw, MARKERS, EXPECTED, dimensions);

describe("hasSynchronizedFrameRow", () => {
  it("authenticates a bidi-isolated disconnect row before reconnect erases it", () => {
    const markers = ["T08Ia", "T08Ib", "T08Ic", "T08Id"];
    const status = "local runtime stopped: T08IaT08Ib café 東京 👩🏽‍💻 T08Ic مرحبا שלום T08Id";
    const isolatedStatus = `\u2067${status}\u2069`;
    const expected = `${status} | idle`;
    const dimensions = { cols: 120, rows: 18 };
    const reconnect = frame("\x1b[2J\x1b[Hlocal ready | idle");
    const raw = frame(`${isolatedStatus} | idle`) + reconnect;
    expect(oracle.hasHistoricalSynchronizedFrameRow(raw, markers, expected, dimensions)).toBe(true);
    expect(oracle.hasSynchronizedFrameRow(raw, markers, expected, dimensions)).toBe(false);

    for (const invalid of [
      frame(`${isolatedStatus}\r\n | idle`) + reconnect,
      frame(isolatedStatus) + reconnect,
      isolatedStatus + frame(" | idle") + reconnect,
      frame(`${isolatedStatus} | idle\r\x1b[2Klocal ready | idle`) + reconnect,
      frame(`${isolatedStatus.replace("東京", "")} | idle`) + reconnect,
      raw + FRAME_START,
    ]) {
      expect(oracle.hasHistoricalSynchronizedFrameRow(invalid, markers, expected, dimensions)).toBe(
        false,
      );
    }
  });

  it("requires exact single-space text and all markers on one completed row", () => {
    expect(hasExpected(frame(EXPECTED))).toBe(true);
    expect(hasExpected(frame("T08A safe\r\nT08B"))).toBe(false);
    expect(hasExpected(frame("T08A\tsafe T08B"))).toBe(false);
    expect(
      oracle.hasSynchronizedFrameRow(
        frame("\x1b[2J\x1b[H1234567\tsafe T08B"),
        ["1234567", "T08B"],
        "1234567 safe T08B",
        TERMINAL,
      ),
    ).toBe(false);
    expect(
      oracle.hasSynchronizedFrameRow(
        frame("\x1b[2J\x1b[H1234567X\b safe T08B"),
        ["1234567", "T08B"],
        "1234567 safe T08B",
        TERMINAL,
      ),
    ).toBe(false);
    expect(hasExpected(frame("T08A  safe T08B"))).toBe(false);
    expect(parse(frame("界X\r\x1b[2G?"))[0]).toEqual([" ?X"]);
    expect(parse(frame("界X\r\x1b[2G\x1b[K"))[0]).toEqual([""]);
    expect(parse(`${EXPECTED}${frame("")}`)).toEqual([[""]]);
    expect(parse(frame("\u2067RTL\u2069"))[0]).toEqual(["RTL"]);
    expect(parse(frame(`${"x".repeat(32)}\x1b[3Jy`), { cols: 32, rows: 2 })[0]).toEqual([
      "x".repeat(32),
      "y",
    ]);
  });
  it("rejects terminal row reconstruction false positives", () => {
    expect(hasExpected(frame(`stale\x1b[2J\x1b[HT08A\x1b[6Gsafe\x1b[11GT08B`))).toBe(true);
    expect(hasExpected(`${EXPECTED}${frame("\x1b[H\x1b[JT08A\x1b[6Gsafe\x1b[11GT08B")}`)).toBe(
      true,
    );
    expect(hasExpected(`legacy ${frame(`\x1b[8G${EXPECTED}`)}`)).toBe(true);
    expect(hasExpected(`${frame(EXPECTED)}${frame("")}`)).toBe(true);
    expect(hasExpected(`${frame(EXPECTED)}${frame("\x1b[31m")}`)).toBe(true);
    expect(hasExpected(`${frame(EXPECTED)}${frame("\x1b[Bunrelated")}`)).toBe(true);
    expect(hasExpected(`${frame(EXPECTED)}\x1b[A\x1b[1G`)).toBe(true);
    for (const raw of [
      frame("T08A safe\x1b[BT08B"),
      frame(`${EXPECTED}\r\x1b[KT08A bad T08B`),
      frame("T08AxsafexT08B\x1b[3J\x1b[HT08A\x1b[6Gsafe\x1b[11GT08B"),
      `T08A safe\r\n\x1b[B${frame("T08B")}`,
      `${EXPECTED}${frame("")}`,
      `${frame(EXPECTED)}${frame("\x1b[2J")}`,
      `${EXPECTED}${frame("T08A\x1b[6Gsafe\x1b[11GT08B")}`,
      `${EXPECTED}\x1b[H\x1b[J${frame("T08A\x1b[6Gsafe\x1b[11GT08B")}`,
      `${frame(EXPECTED)} unrelated`,
      `${frame(EXPECTED)}\r`,
      `${frame(EXPECTED)}\rT08A unsafe T08B`,
      `${frame(EXPECTED)}\r\x1b[K`,
      `${frame(EXPECTED)}\x1b[H\x1b[J`,
      `${frame(EXPECTED)}\x1b[2J`,
      `${frame(EXPECTED)}\rT08A unsafe T08B${frame("\x1b[31m")}`,
      `${frame(EXPECTED)}\r\x1b[K${frame("\x1b[31m")}`,
      `${frame(EXPECTED)}\x1b[2J${frame("\x1b[31m")}`,
    ]) {
      expect(hasExpected(raw)).toBe(false);
    }
    expect(hasExpected(frame(EXPECTED), { cols: EXPECTED.length, rows: 2 })).toBe(true);
    expect(hasExpected(frame(EXPECTED), { cols: EXPECTED.length - 1, rows: 2 })).toBe(false);
    expect(hasExpected(frame(`${EXPECTED}\r\nrow two\r\nrow three`), { cols: 32, rows: 2 })).toBe(
      false,
    );
    expect(hasExpected(`${frame(EXPECTED)}\r\nrow two\r\nrow three`, { cols: 32, rows: 2 })).toBe(
      false,
    );
    expect(hasHistoricalExpected(`${frame(EXPECTED)}\r\x1b[K`)).toBe(true);
    expect(hasHistoricalExpected(`${frame(EXPECTED)}${frame("later")}`)).toBe(true);
    expect(hasHistoricalExpected(`${EXPECTED}${frame("")}`)).toBe(false);
    expect(hasHistoricalExpected(`${frame(EXPECTED)}${FRAME_START}later`)).toBe(false);
    for (const control of "\x1b[A|\x1b[2B|\x1b[3G|\x1b[H|\x1b[J|\x1b[0J|\x1b[2J|\x1b[3J|\x1b[K|\x1b[0K|\x1b[2K|\x1b[m|\x1b[1;38;2;255;0;0m".split(
      "|",
    )) {
      expect(hasExpected(frame(`${control}${EXPECTED}`))).toBe(true);
    }
    const lifecycle =
      "\x1b[?25h\x1b[?25l\x1b[?2004h\x1b[?2004l\x1b[>7u\x1b[?u\x1b[c\x1b[<u\x1b[>4;2m\x1b[>4;0m\x1b]8;;\x07\x1b]8;;\x1b\\";
    expect(hasExpected(lifecycle + frame(EXPECTED))).toBe(true);
    const osc8Bel = "\x1b]8;;https://example.test/path\x07";
    const osc8St = "\x1b]8;;https://example.test/path\x1b\\";
    expect(
      hasExpected(frame(`${osc8Bel}${EXPECTED}\x1b]8;;\x07${osc8St}x\x1b]8;;\x1b\\\x1b]8;;\x07`)),
    ).toBe(true);
    for (const control of "\u009b31m|\x1b[3\t1m|\x1b[C|\x1b[D|\x1b[2;1H|\x1b[f|\x1b[n|\x1b[q|\x1b[c|\x1b[0c|\x1b[?2031h|\x1b[?2026h|\x1b[?2026l|\x1b[4h|\x1b[1J|\x1b[1K|\x1b[1 q|\x1b[1:2m|\x1b[33G|\x1b[9007199254740991B|\x1b]0;title\x07|\x1b]9;4;3\x07|\x1b]11;?\x07|\x1b]52;c;secret\x07|\x1b]1337;File=name=x\x07|\x1b]8;id=x;https://example.test\x07|\x1b]8;;ftp://example.test\x07|\u009d8;;https://example.test\x07|\x1b]8;;https://a.test\x07|\x1b]8;;https://a.test\x07\x1b]8;;https://b.test\x07|\x1bc|\x1b[?20\t26h|\x1b[?20\t26l|\v".split(
      "|",
    )) {
      expect(() => parse(frame(`safe${control}`))).toThrow();
    }
    expect(() =>
      parse(`\x1b]8;;https://example.test\x07outside\x1b]8;;\x07${frame("safe")}`),
    ).toThrow();
    for (const suffix of "\x1b[39|\u009b39|\x1b[?2026|\x1b|\x1b]0;title\x1b|\u009d|\x1b]8;;https://example.test|\x1b]8;;\x1b".split(
      "|",
    )) {
      expect(parse(frame("safe") + suffix)).toEqual([]);
    }
    expect(parse(frame("safe") + ["\x1b[39", "m"].join(""))).toEqual([["safe"]]);
    const openFrame = `${FRAME_START}safe\x1b]8;;https://example.test\x07`;
    expect(parse(openFrame)).toEqual([]);
    const splitClose = `${openFrame}\x1b]8;;\x1b`;
    expect(parse(splitClose)).toEqual([]);
    expect(parse(`${splitClose}\\${FRAME_END}`)).toEqual([["safe"]]);
    expect(() => parse(`${frame("safe")}\x1b]0;title\x1b\\`)).toThrow();
  });
});
