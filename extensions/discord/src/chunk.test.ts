// Discord tests cover chunk plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { countLines, hasBalancedFences } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { chunkDiscordTextWithMode } from "./chunk.js";

type ChunkOptions = Omit<Parameters<typeof chunkDiscordTextWithMode>[1], "chunkMode">;

function chunkDiscordText(text: string, options: ChunkOptions = {}) {
  return chunkDiscordTextWithMode(text, { ...options, chunkMode: "length" });
}

describe("chunkDiscordText", () => {
  it("splits tall messages even when under 2000 chars", () => {
    const text = Array.from({ length: 45 }, (_, i) => `line-${i + 1}`).join("\n");
    expect(text.length).toBeLessThan(2000);

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(countLines(chunk)).toBeLessThanOrEqual(20);
    }
  });

  it("counts the first line after each flush toward maxLines", () => {
    expect(chunkDiscordText("first\nsecond", { maxChars: 2000, maxLines: 1 })).toEqual([
      "first",
      "second",
    ]);
    expect(chunkDiscordText(`${"x".repeat(35)}\nz`, { maxChars: 30, maxLines: 1 })).toEqual([
      "x".repeat(30),
      "x".repeat(5),
      "z",
    ]);
  });

  it("uses default chunk limits for non-finite options", () => {
    const text = "x".repeat(2500);
    const chunks = chunkDiscordText(text, {
      maxChars: Number.NaN,
      maxLines: Number.POSITIVE_INFINITY,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps fenced code blocks balanced across chunks", () => {
    const body = Array.from({ length: 30 }, (_, i) => `console.log(${i});`).join("\n");
    const text = `Here is code:\n\n\`\`\`js\n${body}\n\`\`\`\n\nDone.`;

    const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 10 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(hasBalancedFences(chunk)).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }

    expect(chunks[0]).toContain("```js");
    expect(chunks.at(-1)).toContain("Done.");
  });

  it("keeps fenced blocks intact when chunkMode is newline", () => {
    const text = "```js\nconst a = 1;\nconst b = 2;\n```\nAfter";
    const chunks = chunkDiscordTextWithMode(text, {
      maxChars: 2000,
      maxLines: 50,
      chunkMode: "newline",
    });
    expect(chunks).toEqual([text]);
  });

  it("uses default newline chunk limits for non-finite max chars", () => {
    const text = "x".repeat(2500);
    const chunks = chunkDiscordTextWithMode(text, {
      maxChars: Number.NaN,
      maxLines: 50,
      chunkMode: "newline",
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("reserves space for closing fences when chunking", () => {
    const body = "a".repeat(120);
    const text = `\`\`\`txt\n${body}\n\`\`\``;

    const chunks = chunkDiscordText(text, { maxChars: 50, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
      expect(hasBalancedFences(chunk)).toBe(true);
    }
  });

  it("keeps chunks within maxChars when a closing fence line carries trailing text", () => {
    // A line that both closes the fence and carries a long tail must still reserve closing-fence
    // space; otherwise a mid-line flush appended "```" and overflowed maxChars (e.g. 2004 > 2000).
    for (let pad = 1990; pad <= 2000; pad++) {
      const text = "hi\n```lang\n```" + "z".repeat(pad);
      for (const chunk of chunkDiscordText(text, { maxChars: 2000, maxLines: 100 })) {
        expect(chunk.length).toBeLessThanOrEqual(2000);
      }
    }
  });

  it("keeps chunks within maxChars when a fenced block's opening line is very long", () => {
    // Sibling of the closing-fence test above, on the OPENING/reopen side. flush() reopened
    // continuation chunks with the FULL opening line (info string included), so reopen prefix +
    // body + closing marker overflowed maxChars (observed 2108 > 2000). Balance is not asserted:
    // an opening fence line longer than maxChars must be split, orphaning its marker, so no
    // chunking can keep that physical line both within maxChars and balanced.
    for (let pad = 1990; pad <= 2010; pad++) {
      const text = "```" + "a".repeat(pad) + "\nbody line one\nbody line two\n```";
      for (const chunk of chunkDiscordText(text, { maxChars: 2000, maxLines: 100 })) {
        expect(chunk.length).toBeLessThanOrEqual(2000);
      }
    }
  });

  it("keeps chunks within maxChars when a fence-open line exceeds a small maxChars", () => {
    // Minimal repro mirroring the existing 50-char reserve test above.
    for (let len = 44; len <= 80; len++) {
      const text = "```" + "a".repeat(len) + "\nbody\nmore body\n```";
      for (const chunk of chunkDiscordText(text, { maxChars: 50, maxLines: 50 })) {
        expect(chunk.length).toBeLessThanOrEqual(50);
      }
    }
  });

  it("puts continued code on the line after a reopened fence", () => {
    const text = `\`\`\`ts\nconst value = '${"x".repeat(80)}';\n\`\`\``;
    const chunks = chunkDiscordText(text, { maxChars: 30, maxLines: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    const fencedBodyChunks = chunks.filter((chunk) => /^```(?:ts)?\n[^`]/.test(chunk));
    expect(fencedBodyChunks.length).toBeGreaterThan(1);
    expect(
      chunks
        .filter((chunk) => chunk.startsWith("```"))
        .every((chunk) => /^```(?:ts)?(?:\n|$)/.test(chunk)),
    ).toBe(true);
    expect(chunks.every((chunk) => chunk.length <= 30)).toBe(true);
  });

  it("keeps the hard size limit when synthetic fence balancing cannot fit", () => {
    const cases = [
      { text: "```\nabcdefghij\n```", maxChars: 8 },
      { text: "~~~~~~~~\nabcdefghij\n~~~~~~~~", maxChars: 18 },
    ];

    for (const { text, maxChars } of cases) {
      const chunks = chunkDiscordText(text, { maxChars, maxLines: 50 });
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.length <= maxChars)).toBe(true);
    }
  });

  it("preserves whitespace when splitting long lines", () => {
    const text = Array.from({ length: 40 }, () => "word").join(" ");
    const chunks = chunkDiscordText(text, { maxChars: 20, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("preserves mixed whitespace across chunk boundaries", () => {
    const text = "alpha  beta\tgamma   delta epsilon  zeta";
    const chunks = chunkDiscordText(text, { maxChars: 12, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps leading whitespace when splitting long lines", () => {
    const text = "    indented line with words that force splits";
    const chunks = chunkDiscordText(text, { maxChars: 14, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("uses CJK punctuation as a safe long-line split point", () => {
    const text = "一二三四五。六七八九十。甲乙丙丁戊。";
    const chunks = chunkDiscordText(text, { maxChars: 10, maxLines: 50 });

    expect(chunks).toEqual(["一二三四五。", "六七八九十。", "甲乙丙丁戊。"]);
    expect(chunks.join("")).toBe(text);
  });

  it("still prefers whitespace before CJK punctuation", () => {
    const text = "alpha beta。gamma delta";
    const chunks = chunkDiscordText(text, { maxChars: 13, maxLines: 50 });

    expect(chunks[0]).toBe("alpha");
    expect(chunks.join("")).toBe(text);
  });

  it("does not split surrogate pairs at hard fallback boundaries", () => {
    const text = "ab😀cd😀ef";
    const chunks = chunkDiscordText(text, { maxChars: 3, maxLines: 50 });

    expect(chunks).toEqual(["ab", "😀c", "d😀", "ef"]);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps reasoning italics balanced across chunks", () => {
    const body = Array.from({ length: 25 }, (_, i) => `${i + 1}. line`).join("\n");
    const text = `Reasoning:\n_${body}_`;

    const chunks = chunkDiscordText(text, { maxLines: 10, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      // Each chunk should have balanced italics markers (even count).
      const count = (chunk.match(/_/g) || []).length;
      expect(count % 2).toBe(0);
    }

    // Ensure italics reopen on subsequent chunks
    expect(expectDefined(chunks[0], "first Discord chunk")).toContain("_1. line");
    // Second chunk should reopen italics at the start
    expect(expectDefined(chunks[1], "second Discord chunk").trimStart().startsWith("_")).toBe(true);
  });

  it("keeps reasoning italics balanced when chunks split by char limit", () => {
    const longLine = "This is a very long reasoning line that forces char splits.";
    const body = Array.from({ length: 5 }, () => longLine).join("\n");
    const text = `Reasoning:\n_${body}_`;

    const chunks = chunkDiscordText(text, { maxChars: 80, maxLines: 50 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const underscoreCount = (chunk.match(/_/g) || []).length;
      expect(underscoreCount % 2).toBe(0);
    }
  });

  it("keeps thinking-prefixed reasoning italics balanced across chunks", () => {
    const body = Array.from({ length: 25 }, (_, i) => `${i + 1}. line`).join("\n");
    const text = `Thinking\n\n_${body}_`;

    const chunks = chunkDiscordText(text, { maxLines: 10, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      const underscoreCount = (chunk.match(/_/g) || []).length;
      expect(underscoreCount % 2).toBe(0);
    }
  });

  it("reopens italics while preserving leading whitespace on following chunk", () => {
    const body = [
      "1. line",
      "2. line",
      "3. line",
      "4. line",
      "5. line",
      "6. line",
      "7. line",
      "8. line",
      "9. line",
      "10. line",
      "  11. indented line",
      "12. line",
    ].join("\n");
    const text = `Reasoning:\n_${body}_`;

    const chunks = chunkDiscordText(text, { maxLines: 10, maxChars: 2000 });
    expect(chunks.length).toBeGreaterThan(1);

    const second = expectDefined(chunks[1], "second Discord chunk");
    expect(second.startsWith("_")).toBe(true);
    expect(second).toContain("  11. indented line");
  });
});
