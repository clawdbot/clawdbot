/**
 * Regression coverage for PTY key encoding and DSR stripping.
 * Protects terminal control bytes used by process send-keys and PTY sessions.
 */
import { expect, test } from "vitest";
import { buildCursorPositionResponse, stripDsrRequests } from "./pty-dsr.js";
import { encodeKeySequence, encodePaste } from "./pty-keys.js";

const ESC = "\x1b";

test("encodeKeySequence maps common keys and modifiers", () => {
  const enter = encodeKeySequence({ keys: ["Enter"] });
  expect(enter.data).toBe("\r");

  const ctrlC = encodeKeySequence({ keys: ["C-c"] });
  expect(ctrlC.data).toBe("\x03");

  const altX = encodeKeySequence({ keys: ["M-x"] });
  expect(altX.data).toBe("\x1bx");

  const shiftTab = encodeKeySequence({ keys: ["S-Tab"] });
  expect(shiftTab.data).toBe("\x1b[Z");

  const kpEnter = encodeKeySequence({ keys: ["KPEnter"] });
  expect(kpEnter.data).toBe("\x1bOM");
});

test("encodeKeySequence uses CSI sequences in normal cursor key mode (default)", () => {
  // Default mode (cursorKeyMode not specified) uses CSI sequences.
  const up = encodeKeySequence({ keys: ["up"] });
  expect(up.data).toBe(`${ESC}[A`);

  const down = encodeKeySequence({ keys: ["down"] });
  expect(down.data).toBe(`${ESC}[B`);

  const right = encodeKeySequence({ keys: ["right"] });
  expect(right.data).toBe(`${ESC}[C`);

  const left = encodeKeySequence({ keys: ["left"] });
  expect(left.data).toBe(`${ESC}[D`);

  // Home/End use CSI sequences in normal mode.
  const home = encodeKeySequence({ keys: ["home"] });
  expect(home.data).toBe(`${ESC}[1~`);

  const end = encodeKeySequence({ keys: ["end"] });
  expect(end.data).toBe(`${ESC}[4~`);
});

test("encodeKeySequence uses CSI sequences in explicit normal cursor key mode", () => {
  const up = encodeKeySequence({ keys: ["up"] }, "normal");
  expect(up.data).toBe(`${ESC}[A`);

  const down = encodeKeySequence({ keys: ["down"] }, "normal");
  expect(down.data).toBe(`${ESC}[B`);

  const right = encodeKeySequence({ keys: ["right"] }, "normal");
  expect(right.data).toBe(`${ESC}[C`);

  const left = encodeKeySequence({ keys: ["left"] }, "normal");
  expect(left.data).toBe(`${ESC}[D`);

  // Home/End use CSI sequences in explicit normal mode.
  const home = encodeKeySequence({ keys: ["home"] }, "normal");
  expect(home.data).toBe(`${ESC}[1~`);

  const end = encodeKeySequence({ keys: ["end"] }, "normal");
  expect(end.data).toBe(`${ESC}[4~`);
});

test("encodeKeySequence uses SS3 sequences in application cursor key mode", () => {
  // Application mode (smkx) uses SS3 sequences.
  const up = encodeKeySequence({ keys: ["up"] }, "application");
  expect(up.data).toBe(`${ESC}OA`);

  const down = encodeKeySequence({ keys: ["down"] }, "application");
  expect(down.data).toBe(`${ESC}OB`);

  const right = encodeKeySequence({ keys: ["right"] }, "application");
  expect(right.data).toBe(`${ESC}OC`);

  const left = encodeKeySequence({ keys: ["left"] }, "application");
  expect(left.data).toBe(`${ESC}OD`);

  // Home/End also use SS3 sequences in application mode.
  const home = encodeKeySequence({ keys: ["home"] }, "application");
  expect(home.data).toBe(`${ESC}OH`);

  const end = encodeKeySequence({ keys: ["end"] }, "application");
  expect(end.data).toBe(`${ESC}OF`);
});

test.each([
  ["M-up", `${ESC}[1;3A`],
  ["C-right", `${ESC}[1;5C`],
  ["S-down", `${ESC}[1;2B`],
  ["C-home", `${ESC}[1;5~`],
  ["M-C-End", `${ESC}[4;7~`],
  ["S-M-C-PgDn", `${ESC}[6;8~`],
  ["S-insert", `${ESC}[2;2~`],
  ["S-M-del", `${ESC}[3;4~`],
])("encodeKeySequence applies xterm modifiers to %s in every cursor mode", (key, data) => {
  for (const mode of [undefined, "normal", "application"] as const) {
    expect(encodeKeySequence({ keys: [key] }, mode)).toEqual({ data, warnings: [] });
  }
});

test("encodeKeySequence supports hex + literal with warnings", () => {
  const result = encodeKeySequence({
    literal: "hi",
    hex: ["0d", "0x0a", "zz"],
    keys: ["Enter"],
  });
  expect(result.data).toBe("hi\r\n\r");
  expect(result.warnings).toStrictEqual(["Invalid hex byte: zz"]);
});

test("encodePaste wraps bracketed sequences by default", () => {
  const payload = encodePaste("line1\nline2\n");
  expect(payload.startsWith(`${ESC}[200~`)).toBe(true);
  expect(payload.endsWith(`${ESC}[201~`)).toBe(true);
});

test("stripDsrRequests removes cursor queries and counts them", () => {
  const input = "hi\x1b[6nthere\x1b[?6n";
  const { cleaned, requests } = stripDsrRequests(input);
  expect(cleaned).toBe("hithere");
  expect(requests).toBe(2);
});

test("buildCursorPositionResponse returns CPR sequence", () => {
  expect(buildCursorPositionResponse()).toBe("\x1b[1;1R");
  expect(buildCursorPositionResponse(12, 34)).toBe("\x1b[12;34R");
});
