import { describe, expect, it } from "vitest";
import { stripReasoningTagsFromText } from "./reasoning-tags.js";

describe("stripReasoningTagsFromText", () => {
  function expectStrippedCase(params: {
    input: string | null;
    expected: string | null;
    opts?: Parameters<typeof stripReasoningTagsFromText>[1];
  }) {
    expect(stripReasoningTagsFromText(params.input as unknown as string, params.opts)).toBe(
      params.expected,
    );
  }

  function expectPreservedReasoningTagCodeExample(input: string) {
    expect(stripReasoningTagsFromText(input)).toBe(input);
  }

  function expectReasoningCodeCase(params: { input: string; expected?: string }) {
    if (params.expected === undefined) {
      expectPreservedReasoningTagCodeExample(params.input);
      return;
    }
    expectStrippedCase({
      input: params.input,
      expected: params.expected,
    });
  }

  describe("basic functionality", () => {
    it.each([
      {
        name: "returns text unchanged when no reasoning tags present",
        input: "Hello, this is a normal message.",
        expected: "Hello, this is a normal message.",
      },
      {
        name: "strips proper think tags",
        input: "Hello <think>internal reasoning</think> world!",
        expected: "Hello  world!",
      },
      {
        name: "strips thinking tags",
        input: "Before <thinking>some thought</thinking> after",
        expected: "Before  after",
      },
      { name: "strips thought tags", input: "A <thought>hmm</thought> B", expected: "A  B" },
      {
        name: "strips antthinking tags",
        input: "X <antthinking>internal</antthinking> Y",
        expected: "X  Y",
      },
      {
        name: "strips antml namespaced thinking tags",
        input: "Before <antml:thinking>secret</antml:thinking> after",
        expected: "Before  after",
      },
      {
        name: "strips multiple reasoning blocks",
        input: "<think>first</think>A<think>second</think>B",
        expected: "AB",
      },
    ] as const)("$name", (testCase) => {
      expectStrippedCase(testCase);
    });
  });

  describe("code block preservation (issue #3952)", () => {
    it.each([
      {
        name: "preserves plain code example",
        input: "Use the tag like this:\n```\n<think>reasoning</think>\n```\nThat's it!",
      },
      {
        name: "preserves inline literal think tag documentation",
        input: "The `<think>` tag is used for reasoning. Don't forget the closing `</think>` tag.",
      },
      {
        name: "preserves xml fenced examples",
        input: "Example:\n```xml\n<think>\n  <thought>nested</thought>\n</think>\n```\nDone!",
      },
      {
        name: "preserves plain literal opening and closing tags",
        input: "Use `<think>` to open and `</think>` to close.",
      },
      {
        name: "preserves fenced think example",
        input: "Example:\n```\n<think>reasoning</think>\n```",
      },
      {
        name: "preserves final tags inside code examples",
        input: "Use `<final>` for final answers in code: ```\n<final>42</final>\n```",
      },
      {
        name: "preserves mixed literal think tags and code blocks",
        input: "First `<think>` then ```\n<thinking>block</thinking>\n``` then `<thought>`",
      },
      {
        name: "strips real tags while preserving literal think examples",
        input: "<think>hidden</think>Visible text with `<think>` example.",
        expected: "Visible text with `<think>` example.",
      },
      {
        name: "strips real tags after fenced code block",
        input: "```\n<think>code</think>\n```\n<think>real hidden</think>visible",
        expected: "```\n<think>code</think>\n```\nvisible",
      },
    ] as const)("$name", ({ input, expected }) => {
      expectReasoningCodeCase({ input, expected });
    });
  });

  describe("edge cases", () => {
    it.each([
      {
        input: "Here is how to use <think tags in your code",
        expected: "Here is how to use <think tags in your code",
      },
      {
        input: "You can start with <think and then close with </think>",
        expected: "You can start with <think and then close with",
      },
      {
        input: "Internal reasoning </think> final answer",
        expected: "final answer",
      },
      {
        input: "Use `<think>` to open and `</think>` to close. Final sentence.",
        expected: "Use `<think>` to open and `</think>` to close. Final sentence.",
      },
      {
        input: "A < think >content< /think > B",
        expected: "A  B",
      },
      {
        input: "",
        expected: "",
      },
      {
        input: null as unknown as string,
        expected: null,
      },
    ] as const)("handles malformed/null-ish input %j", (testCase) => {
      expectStrippedCase(testCase);
    });

    it.each([
      {
        input: "Example:\n~~~\n<think>reasoning</think>\n~~~\nDone!",
        expected: "Example:\n~~~\n<think>reasoning</think>\n~~~\nDone!",
      },
      {
        input: "Example:\n~~~js\n<think>code</think>\n~~~",
        expected: "Example:\n~~~js\n<think>code</think>\n~~~",
      },
      {
        input: "Use ``code`` with <think>hidden</think> text",
        expected: "Use ``code`` with  text",
      },
      {
        input: "Before\n```\ncode\n```\nAfter with <think>hidden</think>",
        expected: "Before\n```\ncode\n```\nAfter with",
      },
      {
        input: "```\n<think>not protected\n~~~\n</think>text",
        expected: "```\n<think>not protected\n~~~\n</think>text",
      },
      {
        input: "Start `unclosed <think>hidden</think> end",
        expected: "Start `unclosed  end",
      },
    ] as const)("handles fenced/inline code edge behavior: %j", (testCase) => {
      expectStrippedCase(testCase);
    });

    it.each([
      {
        input: "<think>outer <think>inner</think> still outer</think>visible",
        expected: "visible",
      },
      {
        input: "A<final>1</final>B<final>2</final>C",
        expected: "A1B2C",
      },
      {
        input: "`<final>` in code, <final>visible</final> outside",
        expected: "`<final>` in code, visible outside",
      },
      {
        input: "A <FINAL data-x='1'>visible</Final> B",
        expected: "A visible B",
      },
    ] as const)("handles nested/final tag behavior: %j", (testCase) => {
      expectStrippedCase(testCase);
    });

    it.each([
      {
        input: "你好 <think>思考 🤔</think> 世界",
        expected: "你好  世界",
      },
      {
        input: "A <think id='test' class=\"foo\">hidden</think> B",
        expected: "A  B",
      },
      {
        input: "A <THINK>hidden</THINK> <Thinking>also hidden</Thinking> B",
        expected: "A   B",
      },
      {
        input: "A <ANTML:THINKING hidden='1'>secret</ANTML:THINKING> B",
        expected: "A  B",
      },
    ] as const)("handles unicode/attributes/case-insensitive names: %j", (testCase) => {
      expectStrippedCase(testCase);
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
  });

  describe("strict vs preserve mode", () => {
    it.each([
      {
        name: "keeps strict mode from leaking unclosed trailing reasoning after visible text",
        input: "Before <think>unclosed content after",
        expected: "Before",
        opts: { mode: "strict" as const },
      },
      {
        name: "recovers fully wrapped unclosed tags that would otherwise deliver empty text",
        input: "<think>Answer after malformed opening tag",
        expected: "Answer after malformed opening tag",
        opts: { mode: "strict" as const },
      },
      {
        name: "does not recover fully closed reasoning-only blocks in strict mode",
        input: "<think>hidden reasoning only</think>",
        expected: "",
        opts: { mode: "strict" as const },
      },
      {
        name: "applies preserve mode to unclosed tags",
        input: "Before <think>unclosed content after",
        expected: "Before unclosed content after",
        opts: { mode: "preserve" as const },
      },
      {
        name: "still strips fully closed reasoning blocks in preserve mode",
        input: "A <think>hidden</think> B",
        expected: "A  B",
        opts: { mode: "preserve" as const },
      },
    ] as const)("$name", (testCase) => {
      expectStrippedCase(testCase);
    });
  });

  describe("trim options", () => {
    it.each([
      {
        name: "applies default trim strategy",
        input: "  <think>x</think>  result  <think>y</think>  ",
        expected: "result",
        opts: undefined,
      },
      {
        name: "supports trim=none",
        input: "  <think>x</think>  result  ",
        expected: "    result  ",
        opts: { trim: "none" as const },
      },
      {
        name: "supports trim=start",
        input: "  <think>x</think>  result  ",
        expected: "result  ",
        opts: { trim: "start" as const },
      },
    ] as const)("$name", (testCase) => {
      expectStrippedCase(testCase);
    });
  });

  it.each([
    { input: "A <final>1</final> B", expected: "A 1 B" },
    { input: "C <final>2</final> D", expected: "C 2 D" },
    { input: "E <think>x</think> F", expected: "E  F" },
  ] as const)("does not leak regex state across repeated calls: %j", (testCase) => {
    expectStrippedCase(testCase);
  });
});
