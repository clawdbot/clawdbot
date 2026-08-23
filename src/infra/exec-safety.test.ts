// Covers executable config safety classification.
import { describe, expect, it } from "vitest";
import { isSafeExecutableValue } from "./exec-safety.js";

describe("isSafeExecutableValue", () => {
  it.each([
    ["node", true],
    ["/usr/bin/node", true],
    ["./bin/openclaw", true],
    ["C:\\Tools\\openclaw.exe", true],
    [" tool ", true],
    [undefined, false],
    ["   ", false],
    ["-rf", false],
    ["node;rm -rf /", false],
    ['node "arg"', false],
    ["node\nnext", false],
    ["node\0", false],
  ])("classifies executable value %j", (value, expected) => {
    expect(isSafeExecutableValue(value)).toBe(expected);
  });
});
