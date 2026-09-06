/**
 * Regression coverage for PTY key encoding.
 * Protects terminal control bytes used by process send-keys and PTY sessions.
 */
import { expect, test } from "vitest";
import { encodeKeySequence, encodePaste } from "./pty-keys.js";

const ESC = "\x1b";

test("encodeKeySequence maps common keys and modifiers", () => {
  const enter = encodeKeySequence({ keys: ["Enter"] });
  expect(enter.data).toEqual(Buffer.from("\r"));

  const ctrlC = encodeKeySequence({ keys: ["C-c"] });
  expect(ctrlC.data).toEqual(Buffer.from("\x03"));

  const altX = encodeKeySequence({ keys: ["M-x"] });
  expect(altX.data).toEqual(Buffer.from("\x1bx"));

  const shiftTab = encodeKeySequence({ keys: ["S-Tab"] });
  expect(shiftTab.data).toEqual(Buffer.from("\x1b[Z"));

  const kpEnter = encodeKeySequence({ keys: ["KPEnter"] });
  expect(kpEnter.data).toEqual(Buffer.from("\x1bOM"));
});

test("encodeKeySequence uses CSI sequences in normal cursor key mode (default)", () => {
  // Default mode (cursorKeyMode not specified) uses CSI sequences.
  const up = encodeKeySequence({ keys: ["up"] });
  expect(up.data).toEqual(Buffer.from(`${ESC}[A`));

  const down = encodeKeySequence({ keys: ["down"] });
  expect(down.data).toEqual(Buffer.from(`${ESC}[B`));

  const right = encodeKeySequence({ keys: ["right"] });
  expect(right.data).toEqual(Buffer.from(`${ESC}[C`));

  const left = encodeKeySequence({ keys: ["left"] });
  expect(left.data).toEqual(Buffer.from(`${ESC}[D`));

  // Home/End use CSI sequences in normal mode.
  const home = encodeKeySequence({ keys: ["home"] });
  expect(home.data).toEqual(Buffer.from(`${ESC}[1~`));

  const end = encodeKeySequence({ keys: ["end"] });
  expect(end.data).toEqual(Buffer.from(`${ESC}[4~`));
});

test("encodeKeySequence uses CSI sequences in explicit normal cursor key mode", () => {
  const up = encodeKeySequence({ keys: ["up"] }, "normal");
  expect(up.data).toEqual(Buffer.from(`${ESC}[A`));

  const down = encodeKeySequence({ keys: ["down"] }, "normal");
  expect(down.data).toEqual(Buffer.from(`${ESC}[B`));

  const right = encodeKeySequence({ keys: ["right"] }, "normal");
  expect(right.data).toEqual(Buffer.from(`${ESC}[C`));

  const left = encodeKeySequence({ keys: ["left"] }, "normal");
  expect(left.data).toEqual(Buffer.from(`${ESC}[D`));

  // Home/End use CSI sequences in explicit normal mode.
  const home = encodeKeySequence({ keys: ["home"] }, "normal");
  expect(home.data).toEqual(Buffer.from(`${ESC}[1~`));

  const end = encodeKeySequence({ keys: ["end"] }, "normal");
  expect(end.data).toEqual(Buffer.from(`${ESC}[4~`));
});

test("encodeKeySequence uses SS3 sequences in application cursor key mode", () => {
  // Application mode (smkx) uses SS3 sequences.
  const up = encodeKeySequence({ keys: ["up"] }, "application");
  expect(up.data).toEqual(Buffer.from(`${ESC}OA`));

  const down = encodeKeySequence({ keys: ["down"] }, "application");
  expect(down.data).toEqual(Buffer.from(`${ESC}OB`));

  const right = encodeKeySequence({ keys: ["right"] }, "application");
  expect(right.data).toEqual(Buffer.from(`${ESC}OC`));

  const left = encodeKeySequence({ keys: ["left"] }, "application");
  expect(left.data).toEqual(Buffer.from(`${ESC}OD`));

  // Home/End also use SS3 sequences in application mode.
  const home = encodeKeySequence({ keys: ["home"] }, "application");
  expect(home.data).toEqual(Buffer.from(`${ESC}OH`));

  const end = encodeKeySequence({ keys: ["end"] }, "application");
  expect(end.data).toEqual(Buffer.from(`${ESC}OF`));
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
    expect(encodeKeySequence({ keys: [key] }, mode)).toEqual({
      data: Buffer.from(data),
      warnings: [],
    });
  }
});

test("encodeKeySequence supports hex + literal with warnings", () => {
  const result = encodeKeySequence({
    literal: "hi",
    hex: ["0d", "0x0a", "zz"],
    keys: ["Enter"],
  });
  expect(result.data).toEqual(Buffer.from("hi\r\n\r"));
  expect(result.warnings).toStrictEqual(["Invalid hex byte: zz"]);
});

test("encodePaste wraps bracketed sequences by default", () => {
  const payload = encodePaste("line1\nline2\n");
  expect(payload.startsWith(`${ESC}[200~`)).toBe(true);
  expect(payload.endsWith(`${ESC}[201~`)).toBe(true);
});
