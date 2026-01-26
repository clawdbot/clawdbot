import { describe, expect, it } from "vitest";

import {
  chunkByNewline,
  chunkMarkdownText,
  chunkMarkdownTextWithMode,
  chunkText,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "./chunk.js";

function expectFencesBalanced(chunks: string[]) {
  for (const chunk of chunks) {
    let open: { markerChar: string; markerLen: number } | null = null;
    for (const line of chunk.split("\n")) {
      const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
      if (!match) continue;
      const marker = match[2];
      if (!open) {
        open = { markerChar: marker[0], markerLen: marker.length };
        continue;
      }
      if (open.markerChar === marker[0] && marker.length >= open.markerLen) {
        open = null;
      }
    }
    expect(open).toBe(null);
  }
}

type ChunkCase = {
  name: string;
  text: string;
  limit: number;
  expected: string[];
};

function runChunkCases(chunker: (text: string, limit: number) => string[], cases: ChunkCase[]) {
  for (const { name, text, limit, expected } of cases) {
    it(name, () => {
      expect(chunker(text, limit)).toEqual(expected);
    });
  }
}

const parentheticalCases: ChunkCase[] = [
  {
    name: "keeps parenthetical phrases together",
    text: "Heads up now (Though now I'm curious)ok",
    limit: 35,
    expected: ["Heads up now", "(Though now I'm curious)ok"],
  },
  {
    name: "handles nested parentheses",
    text: "Hello (outer (inner) end) world",
    limit: 26,
    expected: ["Hello (outer (inner) end)", "world"],
  },
  {
    name: "ignores unmatched closing parentheses",
    text: "Hello) world (ok)",
    limit: 12,
    expected: ["Hello)", "world (ok)"],
  },
];

describe("chunkText", () => {
  it("keeps multi-line text in one chunk when under limit", () => {
    const text = "Line one\n\nLine two\n\nLine three";
    const chunks = chunkText(text, 1600);
    expect(chunks).toEqual([text]);
  });

  it("splits only when text exceeds the limit", () => {
    const part = "a".repeat(20);
    const text = part.repeat(5); // 100 chars
    const chunks = chunkText(text, 60);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(60);
    expect(chunks[1].length).toBe(40);
    expect(chunks.join("")).toBe(text);
  });

  it("prefers breaking at a newline before the limit", () => {
    const text = `paragraph one line\n\nparagraph two starts here and continues`;
    const chunks = chunkText(text, 40);
    expect(chunks).toEqual(["paragraph one line", "paragraph two starts here and continues"]);
  });

  it("otherwise breaks at the last whitespace under the limit", () => {
    const text = "This is a message that should break nicely near a word boundary.";
    const chunks = chunkText(text, 30);
    expect(chunks[0].length).toBeLessThanOrEqual(30);
    expect(chunks[1].length).toBeLessThanOrEqual(30);
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("falls back to a hard break when no whitespace is present", () => {
    const text = "Supercalifragilisticexpialidocious"; // 34 chars
    const chunks = chunkText(text, 10);
    expect(chunks).toEqual(["Supercalif", "ragilistic", "expialidoc", "ious"]);
  });

  runChunkCases(chunkText, [parentheticalCases[0]]);
});

describe("resolveTextChunkLimit", () => {
  it("uses per-provider defaults", () => {
    expect(resolveTextChunkLimit(undefined, "whatsapp")).toBe(4000);
    expect(resolveTextChunkLimit(undefined, "telegram")).toBe(4000);
    expect(resolveTextChunkLimit(undefined, "slack")).toBe(4000);
    expect(resolveTextChunkLimit(undefined, "signal")).toBe(4000);
    expect(resolveTextChunkLimit(undefined, "imessage")).toBe(4000);
    expect(resolveTextChunkLimit(undefined, "discord")).toBe(4000);
    expect(
      resolveTextChunkLimit(undefined, "discord", undefined, {
        fallbackLimit: 2000,
      }),
    ).toBe(2000);
  });

  it("supports provider overrides", () => {
    const cfg = { channels: { telegram: { textChunkLimit: 1234 } } };
    expect(resolveTextChunkLimit(cfg, "whatsapp")).toBe(4000);
    expect(resolveTextChunkLimit(cfg, "telegram")).toBe(1234);
  });

  it("prefers account overrides when provided", () => {
    const cfg = {
      channels: {
        telegram: {
          textChunkLimit: 2000,
          accounts: {
            default: { textChunkLimit: 1234 },
            primary: { textChunkLimit: 777 },
          },
        },
      },
    };
    expect(resolveTextChunkLimit(cfg, "telegram", "primary")).toBe(777);
    expect(resolveTextChunkLimit(cfg, "telegram", "default")).toBe(1234);
  });

  it("uses the matching provider override", () => {
    const cfg = {
      channels: {
        discord: { textChunkLimit: 111 },
        slack: { textChunkLimit: 222 },
      },
    };
    expect(resolveTextChunkLimit(cfg, "discord")).toBe(111);
    expect(resolveTextChunkLimit(cfg, "slack")).toBe(222);
    expect(resolveTextChunkLimit(cfg, "telegram")).toBe(4000);
  });
});

describe("chunkMarkdownText", () => {
  it("keeps fenced blocks intact when a safe break exists", () => {
    const prefix = "p".repeat(60);
    const fence = "```bash\nline1\nline2\n```";
    const suffix = "s".repeat(60);
    const text = `${prefix}\n\n${fence}\n\n${suffix}`;

    const chunks = chunkMarkdownText(text, 40);
    expect(chunks.some((chunk) => chunk.trimEnd() === fence)).toBe(true);
    expectFencesBalanced(chunks);
  });

  it("reopens fenced blocks when forced to split inside them", () => {
    const text = `\`\`\`txt\n${"a".repeat(500)}\n\`\`\``;
    const limit = 120;
    const chunks = chunkMarkdownText(text, limit);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
      expect(chunk.startsWith("```txt\n")).toBe(true);
      expect(chunk.trimEnd().endsWith("```")).toBe(true);
    }
    expectFencesBalanced(chunks);
  });

  it("supports tilde fences", () => {
    const text = `~~~sh\n${"x".repeat(600)}\n~~~`;
    const limit = 140;
    const chunks = chunkMarkdownText(text, limit);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
      expect(chunk.startsWith("~~~sh\n")).toBe(true);
      expect(chunk.trimEnd().endsWith("~~~")).toBe(true);
    }
    expectFencesBalanced(chunks);
  });

  it("supports longer fence markers for close", () => {
    const text = `\`\`\`\`md\n${"y".repeat(600)}\n\`\`\`\``;
    const limit = 140;
    const chunks = chunkMarkdownText(text, limit);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
      expect(chunk.startsWith("````md\n")).toBe(true);
      expect(chunk.trimEnd().endsWith("````")).toBe(true);
    }
    expectFencesBalanced(chunks);
  });

  it("preserves indentation for indented fences", () => {
    const text = `  \`\`\`js\n  ${"z".repeat(600)}\n  \`\`\``;
    const limit = 160;
    const chunks = chunkMarkdownText(text, limit);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
      expect(chunk.startsWith("  ```js\n")).toBe(true);
      expect(chunk.trimEnd().endsWith("  ```")).toBe(true);
    }
    expectFencesBalanced(chunks);
  });

  it("never produces an empty fenced chunk when splitting", () => {
    const text = `\`\`\`txt\n${"a".repeat(300)}\n\`\`\``;
    const chunks = chunkMarkdownText(text, 60);
    for (const chunk of chunks) {
      const nonFenceLines = chunk
        .split("\n")
        .filter((line) => !/^( {0,3})(`{3,}|~{3,})(.*)$/.test(line));
      expect(nonFenceLines.join("\n").trim()).not.toBe("");
    }
  });

  runChunkCases(chunkMarkdownText, parentheticalCases);

  it("hard-breaks when a parenthetical exceeds the limit", () => {
    const text = `(${"a".repeat(80)})`;
    const chunks = chunkMarkdownText(text, 20);
    expect(chunks[0]?.length).toBe(20);
    expect(chunks.join("")).toBe(text);
  });
});

describe("chunkByNewline", () => {
  it("splits text on newlines", () => {
    const text = "Line one\nLine two\nLine three";
    const chunks = chunkByNewline(text, 1000);
    expect(chunks).toEqual(["Line one", "Line two", "Line three"]);
  });

  it("preserves blank lines by folding into the next chunk", () => {
    const text = "Line one\n\n\nLine two\n\nLine three";
    const chunks = chunkByNewline(text, 1000);
    expect(chunks).toEqual(["Line one", "\n\nLine two", "\nLine three"]);
  });

  it("trims whitespace from lines", () => {
    const text = "  Line one  \n  Line two  ";
    const chunks = chunkByNewline(text, 1000);
    expect(chunks).toEqual(["Line one", "Line two"]);
  });

  it("preserves leading blank lines on the first chunk", () => {
    const text = "\n\nLine one\nLine two";
    const chunks = chunkByNewline(text, 1000);
    expect(chunks).toEqual(["\n\nLine one", "Line two"]);
  });

  it("falls back to length-based for long lines", () => {
    const text = "Short line\n" + "a".repeat(50) + "\nAnother short";
    const chunks = chunkByNewline(text, 20);
    expect(chunks[0]).toBe("Short line");
    // Long line gets split into multiple chunks
    expect(chunks[1].length).toBe(20);
    expect(chunks[2].length).toBe(20);
    expect(chunks[3].length).toBe(10);
    expect(chunks[4]).toBe("Another short");
  });

  it("does not split long lines when splitLongLines is false", () => {
    const text = "a".repeat(50);
    const chunks = chunkByNewline(text, 20, { splitLongLines: false });
    expect(chunks).toEqual([text]);
  });

  it("returns empty array for empty input", () => {
    expect(chunkByNewline("", 100)).toEqual([]);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(chunkByNewline("   \n\n   ", 100)).toEqual([]);
  });

  it("preserves trailing blank lines on the last chunk", () => {
    const text = "Line one\n\n";
    const chunks = chunkByNewline(text, 1000);
    expect(chunks).toEqual(["Line one\n\n"]);
  });

  it("keeps whitespace when trimLines is false", () => {
    const text = "  indented line  \nNext";
    const chunks = chunkByNewline(text, 1000, { trimLines: false });
    expect(chunks).toEqual(["  indented line  ", "Next"]);
  });
});

describe("chunkTextWithMode", () => {
  it("uses length-based chunking for length mode", () => {
    const text = "Line one\nLine two";
    const chunks = chunkTextWithMode(text, 1000, "length");
    expect(chunks).toEqual(["Line one\nLine two"]);
  });

  it("uses paragraph-based chunking for newline mode", () => {
    const text = "Line one\nLine two";
    const chunks = chunkTextWithMode(text, 1000, "newline");
    expect(chunks).toEqual(["Line one\nLine two"]);
  });

  it("splits on blank lines for newline mode", () => {
    const text = "Para one\n\nPara two";
    const chunks = chunkTextWithMode(text, 1000, "newline");
    expect(chunks).toEqual(["Para one", "Para two"]);
  });
});

describe("chunkMarkdownTextWithMode", () => {
  it("uses markdown-aware chunking for length mode", () => {
    const text = "Line one\nLine two";
    expect(chunkMarkdownTextWithMode(text, 1000, "length")).toEqual(chunkMarkdownText(text, 1000));
  });

  it("uses paragraph-based chunking for newline mode", () => {
    const text = "Line one\nLine two";
    expect(chunkMarkdownTextWithMode(text, 1000, "newline")).toEqual(["Line one\nLine two"]);
  });

  it("splits on blank lines for newline mode", () => {
    const text = "Para one\n\nPara two";
    expect(chunkMarkdownTextWithMode(text, 1000, "newline")).toEqual(["Para one", "Para two"]);
  });

  it("does not split single-newline code fences in newline mode", () => {
    const text = "```js\nconst a = 1;\nconst b = 2;\n```\nAfter";
    expect(chunkMarkdownTextWithMode(text, 1000, "newline")).toEqual([text]);
  });

  it("defers long markdown paragraphs to markdown chunking in newline mode", () => {
    const text = `\`\`\`js\n${"const a = 1;\n".repeat(20)}\`\`\``;
    expect(chunkMarkdownTextWithMode(text, 40, "newline")).toEqual(chunkMarkdownText(text, 40));
  });

  it("does not split on blank lines inside a fenced code block", () => {
    const text = "```python\ndef my_function():\n    x = 1\n\n    y = 2\n    return x + y\n```";
    expect(chunkMarkdownTextWithMode(text, 1000, "newline")).toEqual([text]);
  });

  it("splits on blank lines between a code fence and following paragraph", () => {
    const fence = "```python\ndef my_function():\n    x = 1\n\n    y = 2\n    return x + y\n```";
    const text = `${fence}\n\nAfter`;
    expect(chunkMarkdownTextWithMode(text, 1000, "newline")).toEqual([fence, "After"]);
  });
});

describe("resolveChunkMode", () => {
  it("returns length as default", () => {
    expect(resolveChunkMode(undefined, "telegram")).toBe("length");
    expect(resolveChunkMode({}, "discord")).toBe("length");
    expect(resolveChunkMode(undefined, "bluebubbles")).toBe("length");
  });

  it("returns length for internal channel", () => {
    const cfg = { channels: { bluebubbles: { chunkMode: "newline" as const } } };
    expect(resolveChunkMode(cfg, "__internal__")).toBe("length");
  });

  it("supports provider-level overrides for slack", () => {
    const cfg = { channels: { slack: { chunkMode: "newline" as const } } };
    expect(resolveChunkMode(cfg, "slack")).toBe("newline");
    expect(resolveChunkMode(cfg, "discord")).toBe("length");
  });

  it("supports account-level overrides for slack", () => {
    const cfg = {
      channels: {
        slack: {
          chunkMode: "length" as const,
          accounts: {
            primary: { chunkMode: "newline" as const },
          },
        },
      },
    };
    expect(resolveChunkMode(cfg, "slack", "primary")).toBe("newline");
    expect(resolveChunkMode(cfg, "slack", "other")).toBe("length");
  });
});
