import { describe, expect, it } from "vitest";
import { stripReasoningTagsFromText } from "./reasoning-tags.js";

describe("stripReasoningTagsFromText", () => {
  describe("basic functionality", () => {
    it.each([
      [
        "returns text unchanged when no reasoning tags present",
        "Hello, this is a normal message.",
        "Hello, this is a normal message.",
      ],
      [
        "strips proper think tags",
        "Hello <think>internal reasoning</think> world!",
        "Hello  world!",
      ],
      ["strips thinking tags", "Before <thinking>some thought</thinking> after", "Before  after"],
      ["strips tags separated by Unicode whitespace", "<think\u00a0>hidden</think>After", "After"],
      ["strips thought tags", "A <thought>hmm</thought> B", "A  B"],
      ["strips antthinking tags", "X <antthinking>internal</antthinking> Y", "X  Y"],
      [
        "strips antml namespaced thinking tags",
        "Before <antml:thinking>secret</antml:thinking> after",
        "Before  after",
      ],
      [
        "strips mm namespaced think tags (MiniMax)",
        "<mm:think>internal reasoning</mm:think>Visible answer.",
        "Visible answer.",
      ],
      [
        "strips mm namespaced thinking/thought variants",
        "<mm:thinking>x</mm:thinking>A<mm:thought>y</mm:thought>B",
        "AB",
      ],
      [
        "recovers visible text after truncated mm:think opening tag",
        "leaked preamble</mm:think>Real answer.",
        "Real answer.",
      ],
      ["strips multiple reasoning blocks", "<think>first</think>A<think>second</think>B", "AB"],
      [
        "strips internal reflection blocks",
        "<internal>private reflection</internal>Visible answer.",
        "Visible answer.",
      ],
      [
        "never recovers nested unclosed internal reflection as visible text",
        "<thinking>outer<internal>private reflection",
        "",
      ],
    ] as const)("%s", (_name, input, expected) => {
      expect(stripReasoningTagsFromText(input)).toBe(expected);
    });
  });

  describe("code block preservation (issue #3952)", () => {
    it.each<[string, string, string?]>([
      [
        "preserves plain code example",
        "Use the tag like this:\n```\n<think>reasoning</think>\n```\nThat's it!",
      ],
      [
        "preserves inline literal think tag documentation",
        "The `<think>` tag is used for reasoning. Don't forget the closing `</think>` tag.",
      ],
      [
        "preserves literal internal tag documentation",
        "Use `<internal>private</internal>` literally.",
      ],
      [
        "preserves xml fenced examples",
        "Example:\n```xml\n<think>\n  <thought>nested</thought>\n</think>\n```\nDone!",
      ],
      [
        "preserves plain literal opening and closing tags",
        "Use `<think>` to open and `</think>` to close.",
      ],
      ["preserves fenced think example", "Example:\n```\n<think>reasoning</think>\n```"],
      [
        "preserves final tags inside code examples",
        "Use `<final>` for final answers in code:\n```\n<final>42</final>\n```",
      ],
      [
        "preserves mixed literal think tags and code blocks",
        "First `<think>` then ```\n<thinking>block</thinking>\n``` then `<thought>`",
      ],
      [
        "strips real tags while preserving literal think examples",
        "<think>hidden</think>Visible text with `<think>` example.",
        "Visible text with `<think>` example.",
      ],
      [
        "strips real tags after fenced code block",
        "```\n<think>code</think>\n```\n<think>real hidden</think>visible",
        "```\n<think>code</think>\n```\nvisible",
      ],
    ] as const)("%s", (_name, input, expected) => {
      expect(stripReasoningTagsFromText(input)).toBe(expected ?? input);
    });
  });

  describe("edge cases", () => {
    it.each([
      [
        "Here is how to use <think tags in your code",
        "Here is how to use <think tags in your code",
      ],
      [
        "You can start with <think and then close with </think>",
        "You can start with <think and then close with",
      ],
      ["Internal reasoning </think> final answer", "final answer"],
      ["<reasoning>outer<think>secret</think>", ""],
      [
        "Use `<think>` to open and `</think>` to close. Final sentence.",
        "Use `<think>` to open and `</think>` to close. Final sentence.",
      ],
      ["A < think >content< /think > B", "A  B"],
      ["", ""],
      [null as unknown as string, null],
    ] as const)("handles malformed/null-ish input %j", (input, expected) => {
      expect(stripReasoningTagsFromText(input)).toBe(expected);
    });

    it.each([
      [
        "Example:\n~~~\n<think>reasoning</think>\n~~~\nDone!",
        "Example:\n~~~\n<think>reasoning</think>\n~~~\nDone!",
      ],
      ["Example:\n~~~js\n<think>code</think>\n~~~", "Example:\n~~~js\n<think>code</think>\n~~~"],
      ["Use ``code`` with <think>hidden</think> text", "Use ``code`` with  text"],
      [
        "Before\n```\ncode\n```\nAfter with <think>hidden</think>",
        "Before\n```\ncode\n```\nAfter with",
      ],
      [
        "```\n<think>not protected\n~~~\n</think>text",
        "```\n<think>not protected\n~~~\n</think>text",
      ],
      ["Start `unclosed <think>hidden</think> end", "Start `unclosed  end"],
    ] as const)("handles fenced/inline code edge behavior: %j", (input, expected) => {
      expect(stripReasoningTagsFromText(input)).toBe(expected);
    });

    it.each([
      ["<think>outer <think>inner</think> still outer</think>visible", "visible"],
      ["A<final>1</final>B<final>2</final>C", "A1B2C"],
      ["`<final>` in code, <final>visible</final> outside", "`<final>` in code, visible outside"],
      ["  `<final>literal</final>`  ", "`<final>literal</final>`"],
      ["A <FINAL data-x='1'>visible</Final> B", "A visible B"],
      ["A <final/>visible <final data-model='gemini'>answer</final> B", "A visible answer B"],
      ["A <final data-model=openrouter/google/gemini>answer</final> B", "A answer B"],
      ["A <final-result>visible</final-result> B", "A <final-result>visible</final-result> B"],
      ["  <final-result>visible</final-result>  ", "  <final-result>visible</final-result>  "],
      ['A <final reason="a>b">visible B', 'A <final reason="a>b">visible B'],
      ["A <final / nottag>visible B", "A <final / nottag>visible B"],
      [`A <final ${" ".repeat(10_000)} B`, `A <final ${" ".repeat(10_000)} B`],
      [`A <final ${" ".repeat(10_000)}= > B`, `A <final ${" ".repeat(10_000)}= > B`],
    ] as const)("handles nested/final tag behavior: %j", (input, expected) => {
      expect(stripReasoningTagsFromText(input)).toBe(expected);
    });

    it.each([
      ["你好 <think>思考 🤔</think> 世界", "你好  世界"],
      ["A <think id='test' class=\"foo\">hidden</think> B", "A  B"],
      ["A <THINK>hidden</THINK> <Thinking>also hidden</Thinking> B", "A   B"],
      ["A <ANTML:THINKING hidden='1'>secret</ANTML:THINKING> B", "A  B"],
    ] as const)("handles unicode/attributes/case-insensitive names: %j", (input, expected) => {
      expect(stripReasoningTagsFromText(input)).toBe(expected);
    });

    it("handles long content and pathological backtick patterns efficiently", () => {
      const longContent = "x".repeat(10000);
      expect(stripReasoningTagsFromText(`<think>${longContent}</think>visible`)).toBe("visible");

      const pathological = "`".repeat(100) + "<think>test</think>" + "`".repeat(100);
      const start = Date.now();
      stripReasoningTagsFromText(pathological);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });

    it("recovers malformed quoted tags iteratively at large input sizes", () => {
      const input = `<think data-x="${"x".repeat(110_000)}<think>hidden</think>After`;

      const output = stripReasoningTagsFromText(input, { trim: "none" });

      expect(output).not.toContain("hidden");
      expect(output.endsWith("After")).toBe(true);
    });
  });

  describe("shared Markdown reasoning contract", () => {
    it.each([
      ["keeps visible text after a self-closing tag", "Before<thinking/>After", "BeforeAfter"],
      [
        "treats quoted greater-than delimiters as attribute content",
        'Before <think data-x=">">hidden</think> After',
        "Before  After",
      ],
      [
        "strips tags between unequal backtick runs",
        "before ```<think>private</think>`` after",
        "before ````` after",
      ],
      [
        "ends inline-code ownership at a paragraph-to-list transition",
        "Paragraph `literal\n- <think>private</think> `visible",
        "Paragraph `literal\n-  `visible",
      ],
      [
        "keeps inline code across a soft line break in one paragraph",
        "Paragraph `literal\ncontinued <think>example</think>` after",
        "Paragraph `literal\ncontinued <think>example</think>` after",
      ],
    ] as const)("%s", (_name, input, expected) => {
      expect(stripReasoningTagsFromText(input, { trim: "none" })).toBe(expected);
    });

    it("does not mistake a close tag after an unmatched backtick for code", () => {
      expect(
        stripReasoningTagsFromText("Visible <think>secret ` </think> after", {
          scope: "leading",
          trim: "none",
        }),
      ).toBe("Visible  after");
    });

    it("preserves valid output before an adjacent orphan close", () => {
      expect(stripReasoningTagsFromText("Before<think>x</think></think>After")).toBe("BeforeAfter");
    });
  });

  describe("strict vs preserve mode", () => {
    it.each([
      [
        "keeps strict mode from leaking unclosed trailing reasoning after visible text",
        "Before <think>unclosed content after",
        "Before",
        { mode: "strict" as const },
      ],
      [
        "recovers fully wrapped unclosed tags that would otherwise deliver empty text",
        "<think>Answer after malformed opening tag",
        "Answer after malformed opening tag",
        { mode: "strict" as const },
      ],
      [
        "does not recover fully closed reasoning-only blocks in strict mode",
        "<think>hidden reasoning only</think>",
        "",
        { mode: "strict" as const },
      ],
      [
        "applies preserve mode to unclosed tags",
        "Before <think>unclosed content after",
        "Before unclosed content after",
        { mode: "preserve" as const },
      ],
      [
        "still strips fully closed reasoning blocks in preserve mode",
        "A <think>hidden</think> B",
        "A  B",
        { mode: "preserve" as const },
      ],
      [
        "does not recover internal reflection in preserve mode",
        "<internal>private reflection",
        "",
        { mode: "preserve" as const },
      ],
    ] as const)("%s", (_name, input, expected, opts) => {
      expect(stripReasoningTagsFromText(input, opts)).toBe(expected);
    });
  });

  describe("trim options", () => {
    it.each([
      [
        "applies default trim strategy",
        "  <think>x</think>  result  <think>y</think>  ",
        "result",
        undefined,
      ],
      [
        "supports trim=none",
        "  <think>x</think>  result  ",
        "    result  ",
        { trim: "none" as const },
      ],
      [
        "supports trim=start",
        "  <think>x</think>  result  ",
        "result  ",
        { trim: "start" as const },
      ],
    ] as const)("%s", (_name, input, expected, opts) => {
      expect(stripReasoningTagsFromText(input, opts)).toBe(expected);
    });
  });

  it.each([
    ["A <final>1</final> B", "A 1 B"],
    ["C <final>2</final> D", "C 2 D"],
    ["E <think>x</think> F", "E  F"],
  ] as const)("does not leak regex state across repeated calls: %j", (input, expected) => {
    expect(stripReasoningTagsFromText(input)).toBe(expected);
  });
});
