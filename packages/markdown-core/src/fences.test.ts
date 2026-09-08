// Tests fenced-code-block span scanning used to keep chunk breaks out of code blocks.
import { describe, expect, it } from "vitest";
import { isSafeFenceBreak, parseFenceSpans, scanFenceSpans } from "./fences.js";

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

  it.each(["\n", "\r\n"])("preserves raw UTF-16 offsets with %j line endings", (newline) => {
    const prefix = `😀${newline}`;
    const openLine = "  ````ts `metadata`";
    const text = `${prefix}${openLine}${newline}code${newline} \`\`\`\`\` \t${newline}tail`;

    expect(parseFenceSpans(text)).toEqual([
      {
        start: prefix.length,
        end: text.lastIndexOf("\n"),
        openLine,
        marker: "````",
        indent: "  ",
      },
    ]);
  });

  it.each(["\r", "\u2028", "\u2029"])("does not treat %j as a scanner line break", (separator) => {
    expect(parseFenceSpans(`intro${separator}\`\`\`ts\ncode`)).toEqual([]);
    expect(parseFenceSpans(`\`\`\`ts${separator}info\ncode`)).toEqual([]);
  });

  it("carries an open fence through empty input and a continued line without mutating state", () => {
    const { state } = scanFenceSpans("  ~~~sh\nbody");
    Object.freeze(state.open);
    Object.freeze(state);
    const continued = "~~~\nbody\n~~~~ ";
    const span = { start: 0, openLine: "  ~~~sh", marker: "~~~", indent: "  " };

    expect(scanFenceSpans("", state)).toEqual({ spans: [{ ...span, end: 0 }], state });
    expect(scanFenceSpans(continued, state)).toEqual({
      spans: [{ ...span, end: continued.length }],
      state: { atLineStart: false },
    });
    expect(state).toMatchObject({ atLineStart: false, open: { openLine: "  ~~~sh" } });
  });
});
