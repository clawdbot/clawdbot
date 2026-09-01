import type { ParsedMail } from "mailparser";
import { describe, expect, it } from "vitest";
import { renderImapPrompt } from "./prompt.js";

// Matches an unpaired UTF-16 surrogate (lone high or lone low), without relying
// on the ES2024 String.prototype.isWellFormed() runtime API.
const UNPAIRED_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function mail(text: string): ParsedMail {
  return {
    text,
    subject: "test",
    from: { text: "sender@example.com" },
    attachments: [],
  } as unknown as ParsedMail;
}

describe("renderImapPrompt", () => {
  it("snippet cut does not split a surrogate pair", () => {
    const body = `${"x".repeat(239)}🙂tail`;
    const prompt = renderImapPrompt(mail(body), { includeBody: true, maxBytes: 20_000 }, false);
    expect(UNPAIRED_SURROGATE_RE.test(prompt)).toBe(false);
    const snippetLine = prompt.split("\n").find((line) => line.startsWith("Snippet: "));
    expect(snippetLine).toBeDefined();
    // The 240th UTF-16 code unit lands on the emoji's high surrogate; the
    // safe cut backs off before it rather than stranding a lone surrogate.
    expect(snippetLine?.endsWith("x")).toBe(true);
    expect(snippetLine?.includes("🙂")).toBe(false);
  });

  it("byte cut cannot introduce replacement characters or split a code point", () => {
    const body = `${"A".repeat(100)}${"🙂".repeat(50)}`;
    // Emoji are 4 UTF-8 bytes each; sweep maxBytes across a range so the cut
    // lands at every interior byte offset (1, 2, and 3 bytes into an emoji).
    for (let maxBytes = 400; maxBytes <= 420; maxBytes++) {
      const result = renderImapPrompt(mail(body), { includeBody: true, maxBytes }, false);
      expect(result).toContain("[truncated: email content exceeded the configured byte limit]");
      expect(Buffer.byteLength(result)).toBeLessThanOrEqual(maxBytes);
      expect(UNPAIRED_SURROGATE_RE.test(result)).toBe(false);
      expect(result.includes("�")).toBe(false);
    }
  });

  it("sourceTruncated appends the marker even under the byte limit", () => {
    const body = "hello world";
    const result = renderImapPrompt(mail(body), { includeBody: true, maxBytes: 20_000 }, true);
    expect(result.endsWith("[truncated: email content exceeded the configured byte limit]")).toBe(
      true,
    );
    expect(result).toContain(body);
    expect(UNPAIRED_SURROGATE_RE.test(result)).toBe(false);
  });
});
