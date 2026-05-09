import { describe, expect, it, vi } from "vitest";
import * as fences from "../markdown/fences.js";
import { hasBalancedFences } from "../test-utils/chunk-test-helpers.js";
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
    expect(hasBalancedFences(chunk)).toBe(true);
  }
}

function requireChunk(chunks: string[], index: number): string {
  const chunk = chunks[index];
  if (chunk === undefined) {
    throw new Error(`expected chunk ${index}`);
  }
  return chunk;
}

function expectChunkLengths(chunks: string[], expectedLengths: number[]) {
  expect(chunks).toHaveLength(expectedLengths.length);
  expectedLengths.forEach((length, index) => {
    expect(requireChunk(chunks, index).length).toBe(length);
  });
}

function expectNormalizedChunkJoin(chunks: string[], text: string) {
  expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
}

function expectChunkTextCase(params: {
  text: string;
  limit: number;
  assert: (chunks: string[], text: string) => void;
}) {
  const chunks = chunkText(params.text, params.limit);
  params.assert(chunks, params.text);
}

function expectChunkSpecialCase(run: () => void) {
  run();
}

type ChunkCase = {
  name: string;
  text: string;
  limit: number;
  expected: string[];
};

function runChunkCases(chunker: (text: string, limit: number) => string[], cases: ChunkCase[]) {
  it.each(cases)("$name", ({ text, limit, expected }) => {
    expect(chunker(text, limit)).toEqual(expected);
  });
}

function expectChunkModeCase(params: {
  chunker: (text: string, limit: number, mode: "length" | "newline") => string[];
  text: string;
  limit: number;
  mode: "length" | "newline";
  expected: readonly string[];
  name?: string;
}) {
  expect(params.chunker(params.text, params.limit, params.mode), params.name).toEqual(
    params.expected,
  );
}

function expectMarkdownFenceSplitCases(
  cases: ReadonlyArray<{
    name: string;
    text: string;
    limit: number;
    expectedPrefix: string;
    expectedSuffix: string;
  }>,
) {
  cases.forEach(({ name, text, limit, expectedPrefix, expectedSuffix }) => {
    const chunks = chunkMarkdownText(text, limit);
    expect(chunks.length, name).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length, name).toBeLessThanOrEqual(limit);
      expect(chunk.startsWith(expectedPrefix), name).toBe(true);
      expect(chunk.trimEnd().endsWith(expectedSuffix), name).toBe(true);
    }
    expectFencesBalanced(chunks);
  });
}

function expectNoEmptyFencedChunks(text: string, limit: number) {
  const chunks = chunkMarkdownText(text, limit);
  for (const chunk of chunks) {
    const nonFenceLines = chunk
      .split("\n")
      .filter((line) => !/^( {0,3})(`{3,}|~{3,})(.*)$/.test(line));
    expect(nonFenceLines.join("\n").trim()).not.toBe("");
  }
}

function expectFenceParseOccursOnce(text: string, limit: number) {
  const parseSpy = vi.spyOn(fences, "parseFenceSpans");
  const chunks = chunkMarkdownText(text, limit);

  expect(chunks.length).toBeGreaterThan(2);
  expect(parseSpy).toHaveBeenCalledTimes(1);
  parseSpy.mockRestore();
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

const newlineModeFenceCases = (() => {
  const fence = "```python\ndef my_function():\n    x = 1\n\n    y = 2\n    return x + y\n```";
  const longFence = `\`\`\`js\n${"const a = 1;\n".repeat(20)}\`\`\``;
  return [
    {
      name: "keeps single-newline fence+paragraph together",
      text: "```js\nconst a = 1;\nconst b = 2;\n```\nAfter",
      limit: 1000,
      expected: ["```js\nconst a = 1;\nconst b = 2;\n```\nAfter"],
    },
    {
      name: "keeps blank lines inside fence together",
      text: fence,
      limit: 1000,
      expected: [fence],
    },
    {
      name: "splits between fence and following paragraph",
      text: `${fence}\n\nAfter`,
      limit: 1000,
      expected: [fence, "After"],
    },
    {
      name: "defers long markdown blocks to markdown chunker",
      text: longFence,
      limit: 40,
      expected: chunkMarkdownText(longFence, 40),
    },
  ] as const;
})();

describe("chunkText", () => {
  it.each([
    {
      name: "keeps multi-line text in one chunk when under limit",
      text: "Line one\n\nLine two\n\nLine three",
      limit: 1600,
      assert: (chunks: string[], text: string) => {
        expect(chunks).toEqual([text]);
      },
    },
    {
      name: "splits only when text exceeds the limit",
      text: "a".repeat(20).repeat(5),
      limit: 60,
      assert: (chunks: string[], text: string) => {
        expectChunkLengths(chunks, [60, 40]);
        expect(chunks.join("")).toBe(text);
      },
    },
    {
      name: "prefers breaking at a newline before the limit",
      text: "paragraph one line\n\nparagraph two starts here and continues",
      limit: 40,
      assert: (chunks: string[]) => {
        expect(chunks).toEqual(["paragraph one line", "paragraph two starts here and continues"]);
      },
    },
    {
      name: "otherwise breaks at the last whitespace under the limit",
      text: "This is a message that should break nicely near a word boundary.",
      limit: 30,
      assert: (chunks: string[], text: string) => {
        expect(requireChunk(chunks, 0).length).toBeLessThanOrEqual(30);
        expect(requireChunk(chunks, 1).length).toBeLessThanOrEqual(30);
        expectNormalizedChunkJoin(chunks, text);
      },
    },
    {
      name: "falls back to a hard break when no whitespace is present",
      text: "Supercalifragilisticexpialidocious",
      limit: 10,
      assert: (chunks: string[]) => {
        expect(chunks).toEqual(["Supercalif", "ragilistic", "expialidoc", "ious"]);
      },
    },
  ] as const)("$name", ({ text, limit, assert }) => {
    expectChunkTextCase({ text, limit, assert });
  });

  runChunkCases(chunkText, [parentheticalCases[0]]);
});

describe("resolveTextChunkLimit", () => {
  it.each([
    ...(["whatsapp", "telegram", "slack", "signal", "imessage", "discord"] as const).map(
      (provider) => ({
        name: `uses default limit for ${provider}`,
        cfg: undefined,
        provider,
        accountId: undefined,
        options: undefined,
        expected: 4000,
      }),
    ),
    {
      name: "uses fallback limit override when provided",
      cfg: undefined,
      provider: "discord" as const,
      accountId: undefined,
      options: { fallbackLimit: 2000 },
      expected: 2000,
    },
    {
      name: "supports provider overrides for telegram",
      cfg: { channels: { telegram: { textChunkLimit: 1234 } } },
      provider: "telegram" as const,
      accountId: undefined,
      options: undefined,
      expected: 1234,
    },
    {
      name: "falls back when provider override does not match",
      cfg: { channels: { telegram: { textChunkLimit: 1234 } } },
      provider: "whatsapp" as const,
      accountId: undefined,
      options: undefined,
      expected: 4000,
    },
    {
      name: "prefers account overrides when provided",
      cfg: {
        channels: {
          telegram: {
            textChunkLimit: 2000,
            accounts: {
              default: { textChunkLimit: 1234 },
              primary: { textChunkLimit: 777 },
            },
          },
        },
      },
      provider: "telegram" as const,
      accountId: "primary",
      options: undefined,
      expected: 777,
    },
    {
      name: "uses default account override when requested",
      cfg: {
        channels: {
          telegram: {
            textChunkLimit: 2000,
            accounts: {
              default: { textChunkLimit: 1234 },
              primary: { textChunkLimit: 777 },
            },
          },
        },
      },
      provider: "telegram" as const,
      accountId: "default",
      options: undefined,
      expected: 1234,
    },
    {
      name: "uses the matching provider override for discord",
      cfg: {
        channels: {
          discord: { textChunkLimit: 111 },
          slack: { textChunkLimit: 222 },
        },
      },
      provider: "discord" as const,
      accountId: undefined,
      options: undefined,
      expected: 111,
    },
    {
      name: "uses the matching provider override for slack",
      cfg: {
        channels: {
          discord: { textChunkLimit: 111 },
          slack: { textChunkLimit: 222 },
        },
      },
      provider: "slack" as const,
      accountId: undefined,
      options: undefined,
      expected: 222,
    },
    {
      name: "falls back when multi-provider override does not match",
      cfg: {
        channels: {
          discord: { textChunkLimit: 111 },
          slack: { textChunkLimit: 222 },
        },
      },
      provider: "telegram" as const,
      accountId: undefined,
      options: undefined,
      expected: 4000,
    },
  ] as const)("$name", ({ cfg, provider, accountId, options, expected }) => {
    expect(resolveTextChunkLimit(cfg as never, provider, accountId, options)).toBe(expected);
  });
});

describe("chunkMarkdownText", () => {
  it.each([
    {
      name: "keeps fenced blocks intact when a safe break exists",
      run: () => {
        const prefix = "p".repeat(60);
        const fence = "```bash\nline1\nline2\n```";
        const suffix = "s".repeat(60);
        const text = `${prefix}\n\n${fence}\n\n${suffix}`;

        const chunks = chunkMarkdownText(text, 40);
        const intactFenceChunks = chunks.filter((chunk) => chunk.trimEnd() === fence);
        expect(intactFenceChunks.length).toBeGreaterThan(0);
        expectFencesBalanced(chunks);
      },
    },
    {
      name: "handles multiple fence marker styles when splitting inside fences",
      run: () =>
        expectMarkdownFenceSplitCases([
          {
            name: "backtick fence",
            text: `\`\`\`txt\n${"a".repeat(500)}\n\`\`\``,
            limit: 120,
            expectedPrefix: "```txt\n",
            expectedSuffix: "```",
          },
          {
            name: "tilde fence",
            text: `~~~sh\n${"x".repeat(600)}\n~~~`,
            limit: 140,
            expectedPrefix: "~~~sh\n",
            expectedSuffix: "~~~",
          },
          {
            name: "long backtick fence",
            text: `\`\`\`\`md\n${"y".repeat(600)}\n\`\`\`\``,
            limit: 140,
            expectedPrefix: "````md\n",
            expectedSuffix: "````",
          },
          {
            name: "indented fence",
            text: `  \`\`\`js\n  ${"z".repeat(600)}\n  \`\`\``,
            limit: 160,
            expectedPrefix: "  ```js\n",
            expectedSuffix: "  ```",
          },
        ]),
    },
  ] as const)("$name", ({ run }) => {
    expectChunkSpecialCase(run);
  });

  runChunkCases(chunkMarkdownText, parentheticalCases);

  it.each([
    {
      name: "never produces an empty fenced chunk when splitting",
      run: () => {
        expectNoEmptyFencedChunks(`\`\`\`txt\n${"a".repeat(300)}\n\`\`\``, 60);
      },
    },
    {
      name: "hard-breaks when a parenthetical exceeds the limit",
      run: () => {
        const text = `(${"a".repeat(80)})`;
        const chunks = chunkMarkdownText(text, 20);
        expect(requireChunk(chunks, 0).length).toBe(20);
        expect(chunks.join("")).toBe(text);
      },
    },
    {
      name: "parses fence spans once for long fenced payloads",
      run: () => {
        expectFenceParseOccursOnce(`\`\`\`txt\n${"line\n".repeat(600)}\`\`\``, 80);
      },
    },
  ] as const)("$name", ({ run }) => {
    expectChunkSpecialCase(run);
  });
});

describe("chunkByNewline", () => {
  it.each([
    {
      name: "splits text on newlines",
      text: "Line one\nLine two\nLine three",
      limit: 1000,
      expected: ["Line one", "Line two", "Line three"],
    },
    {
      name: "preserves blank lines by folding into the next chunk",
      text: "Line one\n\n\nLine two\n\nLine three",
      limit: 1000,
      expected: ["Line one", "\n\nLine two", "\nLine three"],
    },
    {
      name: "trims whitespace from lines",
      text: "  Line one  \n  Line two  ",
      limit: 1000,
      expected: ["Line one", "Line two"],
    },
    {
      name: "preserves leading blank lines on the first chunk",
      text: "\n\nLine one\nLine two",
      limit: 1000,
      expected: ["\n\nLine one", "Line two"],
    },
    {
      name: "preserves trailing blank lines on the last chunk",
      text: "Line one\n\n",
      limit: 1000,
      expected: ["Line one\n\n"],
    },
    {
      name: "keeps whitespace when trimLines is false",
      text: "  indented line  \nNext",
      limit: 1000,
      options: { trimLines: false },
      expected: ["  indented line  ", "Next"],
    },
  ] as const)("$name", ({ text, limit, options, expected }) => {
    expect(chunkByNewline(text, limit, options)).toEqual(expected);
  });

  it.each([
    {
      name: "falls back to length-based for long lines",
      run: () => {
        const text = "Short line\n" + "a".repeat(50) + "\nAnother short";
        const chunks = chunkByNewline(text, 20);
        expect(chunks[0]).toBe("Short line");
        expectChunkLengths(chunks.slice(1, 4), [20, 20, 10]);
        expect(chunks[4]).toBe("Another short");
      },
    },
    {
      name: "does not split long lines when splitLongLines is false",
      run: () => {
        const text = "a".repeat(50);
        expect(chunkByNewline(text, 20, { splitLongLines: false })).toEqual([text]);
      },
    },
  ] as const)("$name", ({ run }) => {
    expectChunkSpecialCase(run);
  });

  it.each(["", "   \n\n   "] as const)("returns empty array for input %j", (text) => {
    expect(chunkByNewline(text, 100)).toStrictEqual([]);
  });
});

describe("chunkTextWithMode", () => {
  it.each([
    {
      name: "length mode",
      text: "Line one\nLine two",
      mode: "length" as const,
      expected: ["Line one\nLine two"],
    },
    {
      name: "newline mode (single paragraph)",
      text: "Line one\nLine two",
      mode: "newline" as const,
      expected: ["Line one\nLine two"],
    },
    {
      name: "newline mode (blank-line split)",
      text: "Para one\n\nPara two",
      mode: "newline" as const,
      expected: ["Para one", "Para two"],
    },
  ] as const)(
    "applies mode-specific chunking behavior: $name",
    ({ text, mode, expected, name }) => {
      expectChunkModeCase({
        chunker: chunkTextWithMode,
        text,
        limit: 1000,
        mode,
        expected,
        name,
      });
    },
  );
});

describe("chunkMarkdownTextWithMode", () => {
  it.each([
    {
      name: "length mode uses markdown-aware chunker",
      text: "Line one\nLine two",
      mode: "length" as const,
      expected: chunkMarkdownText("Line one\nLine two", 1000),
    },
    {
      name: "newline mode keeps single paragraph",
      text: "Line one\nLine two",
      mode: "newline" as const,
      expected: ["Line one\nLine two"],
    },
    {
      name: "newline mode splits by blank line",
      text: "Para one\n\nPara two",
      mode: "newline" as const,
      expected: ["Para one", "Para two"],
    },
  ] as const)("applies markdown/newline mode behavior: $name", ({ text, mode, expected, name }) => {
    expectChunkModeCase({
      chunker: chunkMarkdownTextWithMode,
      text,
      limit: 1000,
      mode,
      expected,
      name,
    });
  });

  it.each(newlineModeFenceCases)(
    "handles newline mode fence splitting rules: $name",
    ({ text, limit, expected, name }) => {
      expect(chunkMarkdownTextWithMode(text, limit, "newline"), name).toEqual(expected);
    },
  );
});

describe("resolveChunkMode", () => {
  const providerCfg = { channels: { slack: { chunkMode: "newline" as const } } };
  const accountCfg = {
    channels: {
      slack: {
        chunkMode: "length" as const,
        accounts: {
          primary: { chunkMode: "newline" as const },
        },
      },
    },
  };

  it.each([
    { cfg: undefined, provider: "telegram", accountId: undefined, expected: "length" },
    { cfg: {}, provider: "discord", accountId: undefined, expected: "length" },
    { cfg: undefined, provider: "imessage", accountId: undefined, expected: "length" },
    { cfg: providerCfg, provider: "__internal__", accountId: undefined, expected: "length" },
    { cfg: providerCfg, provider: "slack", accountId: undefined, expected: "newline" },
    { cfg: providerCfg, provider: "discord", accountId: undefined, expected: "length" },
    { cfg: accountCfg, provider: "slack", accountId: "primary", expected: "newline" },
    { cfg: accountCfg, provider: "slack", accountId: "other", expected: "length" },
  ] as const)(
    "resolves default/provider/account/internal chunk mode for $provider $accountId",
    ({ cfg, provider, accountId, expected }) => {
      expect(resolveChunkMode(cfg as never, provider, accountId)).toBe(expected);
    },
  );
});
