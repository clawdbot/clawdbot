// Terminal Core tests cover terminal hyperlink formatting behavior.
import { describe, expect, it } from "vitest";
import { formatTerminalLink } from "./terminal-link.js";

const controls = String.fromCharCode(
  ...Array.from({ length: 32 }, (_, index) => index),
  ...Array.from({ length: 33 }, (_, index) => index + 0x7f),
);
const printableText = "\u0020\u007e\u00a0é\u200d\u2028\u2029🦞\ud800-\udc00";
const unsafeText = `${controls}${printableText}\u001b[31m`;
const safeText = `${printableText}[31m`;

describe("formatTerminalLink", () => {
  it("strips terminal control characters from OSC labels and urls", () => {
    const out = formatTerminalLink(unsafeText, `https://example.test/${unsafeText}`, {
      force: true,
    });

    expect(out).toBe(`\u001b]8;;https://example.test/${safeText}\u0007${safeText}\u001b]8;;\u0007`);
  });

  it("strips terminal control characters from plain fallback text", () => {
    const out = formatTerminalLink(unsafeText, `https://example.test/${unsafeText}`, {
      force: false,
    });

    expect(out).toBe(`${safeText} (https://example.test/${safeText})`);
  });

  it("strips terminal control characters from explicit fallback text", () => {
    const out = formatTerminalLink("label", "https://example.test", {
      fallback: unsafeText,
      force: false,
    });

    expect(out).toBe(safeText);
  });

  it("preserves explicit empty fallback text", () => {
    const out = formatTerminalLink("label", "https://example.test", {
      fallback: "",
      force: false,
    });

    expect(out).toBe("");
  });
});
