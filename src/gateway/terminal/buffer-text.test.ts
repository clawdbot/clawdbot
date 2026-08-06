import { describe, expect, it } from "vitest";
import { renderTerminalBufferText } from "./buffer-text.js";

describe("renderTerminalBufferText", () => {
  it("strips ANSI color and erase sequences in ESC and C1 forms", () => {
    expect(renderTerminalBufferText("\u001b[32mok\u001b[0m done\u001b[2K")).toBe("ok done");
    expect(renderTerminalBufferText("\u009b31mred\u009b0m")).toBe("red");
  });

  it("collapses carriage-return overwrites to the last write per line", () => {
    expect(renderTerminalBufferText("10%\r20%\r100%\ndone")).toBe("100%\ndone");
  });

  it("keeps text before a line-terminating CRLF", () => {
    expect(renderTerminalBufferText("hello\r\nworld\r\n")).toBe("hello\nworld\n");
  });

  it("drops residual control bytes but keeps tabs", () => {
    expect(renderTerminalBufferText("a\u0007b\tc")).toBe("ab\tc");
  });

  it("drops the full residual C1 range without clipping adjacent Unicode text", () => {
    const c1 = Array.from({ length: 0x20 }, (_, offset) => String.fromCharCode(0x80 + offset)).join(
      "",
    );
    expect(renderTerminalBufferText(`a\u007f${c1}\u00a0b\tc`)).toBe("a\u00a0b\tc");
  });

  it("strips OSC title sequences in ESC and C1 forms", () => {
    expect(renderTerminalBufferText("\u001b]0;title\u0007prompt$ ")).toBe("prompt$ ");
    expect(renderTerminalBufferText("\u009d0;title\u009cprompt$ ")).toBe("prompt$ ");
  });
});
