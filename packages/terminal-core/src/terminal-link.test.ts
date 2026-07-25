// Terminal Core tests cover terminal hyperlink formatting behavior.
import { describe, expect, it } from "vitest";
import { formatTerminalLink } from "./terminal-link.js";

describe("formatTerminalLink", () => {
  it("strips terminal control characters from OSC labels and urls", () => {
    const out = formatTerminalLink(
      "safe\u0007la\u001bbel",
      "https://example.test/a\u0007oops\u001b[31m",
      { force: true },
    );

    expect(out).toBe("\u001b]8;;https://example.test/aoops[31m\u0007safelabel\u001b]8;;\u0007");
  });

  it("strips terminal control characters from plain fallback text", () => {
    const out = formatTerminalLink("safe\u0007label", "https://example.test/a\u001b[31m", {
      force: false,
    });

    expect(out).toBe("safelabel (https://example.test/a[31m)");
  });

  it("strips terminal control characters from explicit fallback text", () => {
    const out = formatTerminalLink("label", "https://example.test", {
      fallback: "fallback\u0007text\u001b[31m",
      force: false,
    });

    expect(out).toBe("fallbacktext[31m");
  });

  it("preserves explicit empty fallback text", () => {
    const out = formatTerminalLink("label", "https://example.test", {
      fallback: "",
      force: false,
    });

    expect(out).toBe("");
  });
});
