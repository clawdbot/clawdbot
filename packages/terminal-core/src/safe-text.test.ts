// Terminal Core tests cover safe text behavior.
import { describe, expect, it } from "vitest";
import { hasTerminalControl, sanitizeTerminalText } from "./safe-text.js";

describe("hasTerminalControl", () => {
  it.each([
    ["C0", "safe\u0000text"],
    ["DEL", "safe\u007ftext"],
    ["C1", "safe\u0085text"],
  ])("detects %s controls", (_name, input) => {
    expect(hasTerminalControl(input)).toBe(true);
  });

  it("allows printable shell metacharacters and Unicode", () => {
    expect(hasTerminalControl(`'"$&;|<>^()%![]{}\\\`-%PATH%-��`)).toBe(false);
  });
});

describe("sanitizeTerminalText", () => {
  it("removes C1 control characters", () => {
    expect(sanitizeTerminalText("ab\u0085\u008Dc")).toBe("abc");
  });

  it("strips cursor and erase ANSI sequences", () => {
    expect(sanitizeTerminalText("\u001b[2K\u001b[1Arewritten")).toBe("rewritten");
  });

  it("removes OSC clipboard payloads", () => {
    expect(sanitizeTerminalText("safe\u001b]52;c;YWJj\u0007text")).toBe("safetext");
  });

  it("escapes line controls while preserving printable text", () => {
    expect(sanitizeTerminalText("a\tb\nc\rd")).toBe("a\\tb\\nc\\rd");
  });
});
