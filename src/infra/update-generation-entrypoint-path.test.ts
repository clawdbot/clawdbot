import { describe, expect, it } from "vitest";
import { isSafeUpdateGenerationEntrypointPath } from "./update-generation-entrypoint-path.js";

const WINDOWS_DEVICE_PATHS = [
  "CON",
  "con.txt",
  "NUL.mjs",
  "PrN.js",
  "AUX",
  "CONIN$",
  "conout$",
  "CoNiN$.js",
  "CONOUT$.txt",
  "dir/CONIN$/index.js",
  "dir\\conout$.mjs",
  "COM1.txt",
  "com9",
  "LPT1.js",
  "dir/lpt9/index.js",
];

describe("update generation entrypoint path", () => {
  it.each(WINDOWS_DEVICE_PATHS)("rejects the Windows device path %s", (value) => {
    expect(isSafeUpdateGenerationEntrypointPath(value)).toBe(false);
  });

  it.each([
    "CLOCK$",
    "clock$",
    "Clock$.js",
    "CLOCK$.txt",
    "dir/CLOCK$/index.js",
    "normal$.js",
    "dir/price$.mjs",
  ])("accepts the ordinary dollar-sign path %s", (value) => {
    expect(isSafeUpdateGenerationEntrypointPath(value)).toBe(true);
  });

  it.each(["dir\\entry.mjs", "dir\\clock$.mjs", "dir\\price$.mjs"])(
    "rejects the noncanonical backslash path %s",
    (value) => {
      expect(isSafeUpdateGenerationEntrypointPath(value)).toBe(false);
    },
  );
});
