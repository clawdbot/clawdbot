import { afterEach, describe, expect, it } from "vitest";
import { isTerminalInteractive } from "./terminal-interactivity.js";

const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

afterEach(() => {
  if (stdinIsTTYDescriptor) {
    Object.defineProperty(process.stdin, "isTTY", stdinIsTTYDescriptor);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
});

describe("isTerminalInteractive", () => {
  it("checks stdin with an explicitly selected output stream", () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    const stderrLikeOutput = { isTTY: true };

    expect(isTerminalInteractive(stderrLikeOutput)).toBe(true);
    expect(isTerminalInteractive({ isTTY: false })).toBe(false);
  });
});
