// Tests fenced-code-block span scanning used to keep chunk breaks out of code blocks.
import { describe, expect, it } from "vitest";
import { isSafeFenceBreak, parseFenceSpans } from "./fences.js";

describe("parseFenceSpans closing-fence rules", () => {
  it("treats a marker line with trailing text as code content, not a closing fence", () => {
    // CommonMark: a closing fence may be followed only by whitespace, so "``` not a close" is code
    // content and the block stays open until the real closing fence. Reporting an interior offset
    // as a safe break would let a chunker split inside the code block.
    const text = "```\ncode\n``` not a close\nmore code\n```\n";
    const spans = parseFenceSpans(text);

    expect(spans).toHaveLength(1);
    expect(isSafeFenceBreak(spans, text.indexOf("more code") + 1)).toBe(false);
  });

  it("does not close on non-space/tab whitespace", () => {
    for (const suffix of ["\u00a0", "\v", "\f"]) {
      const text = `\`\`\`\ncode\n\`\`\`${suffix}\nmore code\n`;
      const spans = parseFenceSpans(text);

      expect(spans).toHaveLength(1);
      expect(spans[0]?.end).toBe(text.length);
      expect(isSafeFenceBreak(spans, text.indexOf("more code") + 1)).toBe(false);
    }
  });

  it("closes fences with CRLF line endings", () => {
    const text = "```\r\ncode\r\n```\r\nafter\r\n";
    const spans = parseFenceSpans(text);

    expect(spans).toHaveLength(1);
    expect(isSafeFenceBreak(spans, text.indexOf("after") + 1)).toBe(true);
  });

  it("still closes on a bare fence, a longer same-marker fence, and keeps an opener info string", () => {
    expect(parseFenceSpans("```\ncode\n```\nafter\n")).toHaveLength(1);
    expect(parseFenceSpans("```\ncode\n`````  \nafter\n")).toHaveLength(1);
    expect(parseFenceSpans("```python\nx = 1\n```\n")).toHaveLength(1);

    const closed = "```\ncode\n```\nafter\n";
    const spans = parseFenceSpans(closed);
    expect(isSafeFenceBreak(spans, closed.indexOf("after") + 1)).toBe(true);
  });
});
