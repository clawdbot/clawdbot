import { describe, expect, it } from "vitest";
import {
  sanitizeAssistantVisibleText,
  sanitizeAssistantVisibleTextWithProfile,
  stripAssistantInternalScaffolding,
} from "./assistant-visible-text.js";
import { stripModelSpecialTokens } from "./model-special-tokens.js";

describe("stripAssistantInternalScaffolding", () => {
  function expectVisibleText(input: string, expected: string) {
    expect(stripAssistantInternalScaffolding(input)).toBe(expected);
  }

  function createLiteralRelevantMemoriesCodeBlock() {
    return [
      "```xml",
      "<relevant-memories>",
      "sample",
      "</relevant-memories>",
      "```",
      "",
      "Visible text",
    ].join("\n");
  }

  function expectLiteralVisibleText(input: string) {
    expectVisibleText(input, input);
  }

  it.each([
    {
      name: "strips reasoning tags",
      input: ["<thinking>", "secret", "</thinking>", "Visible"].join("\n"),
      expected: "Visible",
    },
    {
      name: "strips relevant-memories scaffolding blocks",
      input: [
        "<relevant-memories>",
        "The following memories may be relevant to this conversation:",
        "- Internal memory note",
        "</relevant-memories>",
        "",
        "User-visible answer",
      ].join("\n"),
      expected: "User-visible answer",
    },
    {
      name: "supports relevant_memories tag variants",
      input: [
        "<relevant_memories>",
        "Internal memory note",
        "</relevant_memories>",
        "Visible",
      ].join("\n"),
      expected: "Visible",
    },
    {
      name: "hides unfinished relevant-memories blocks",
      input: ["Hello", "<relevant-memories>", "internal-only"].join("\n"),
      expected: "Hello\n",
    },
    {
      name: "trims leading whitespace after stripping scaffolding",
      input: [
        "<thinking>",
        "secret",
        "</thinking>",
        "   ",
        "<relevant-memories>",
        "internal note",
        "</relevant-memories>",
        "  Visible",
      ].join("\n"),
      expected: "Visible",
    },
    {
      name: "preserves unfinished reasoning text while still stripping memory blocks",
      input: [
        "Before",
        "<thinking>",
        "secret",
        "<relevant-memories>",
        "internal note",
        "</relevant-memories>",
        "After",
      ].join("\n"),
      expected: "Before\n\nsecret\n\nAfter",
    },
    {
      name: "keeps relevant-memories tags inside fenced code",
      input: createLiteralRelevantMemoriesCodeBlock(),
      expected: undefined,
    },
    {
      name: "keeps literal relevant-memories prose",
      input: "Use `<relevant-memories>example</relevant-memories>` literally.",
      expected: undefined,
    },
  ] as const)("$name", ({ input, expected }) => {
    if (expected === undefined) {
      expectLiteralVisibleText(input);
      return;
    }
    expectVisibleText(input, expected);
  });

  describe("tool-call XML stripping", () => {
    it("strips closed <tool_call> blocks", () => {
      expectVisibleText(
        'Let me check.\n\n<tool_call> {"name": "read", "arguments": {"file_path": "test.md"}} </tool_call> after',
        "Let me check.\n\n after",
      );
    });

    it("strips closed <function_calls> blocks", () => {
      expectVisibleText(
        'Checking now. <function_calls>{"name": "exec", "args": {"cmd": "ls"}}</function_calls> Done.',
        "Checking now.  Done.",
      );
    });

    it("strips closed <tool_result> blocks", () => {
      expectVisibleText(
        'Prefix\n<tool_result> {"output": "file contents"} </tool_result>\nSuffix',
        "Prefix\n\nSuffix",
      );
    });

    it("strips dangling <tool_result> content to end-of-string", () => {
      expectVisibleText('Result:\n<tool_result>\n{"output": "data"}\n', "Result:\n");
    });

    it("strips <tool_result> closed with mismatched </tool_call> and preserves trailing text", () => {
      expectVisibleText(
        'Prefix\n<tool_result> {"output": "data"} </tool_call>\nSuffix',
        "Prefix\n\nSuffix",
      );
    });

    it("does not let </tool_result> close a <tool_call> block", () => {
      expectVisibleText(
        'Prefix\n<tool_call>{"name":"x"}</tool_result>LEAK</tool_call>\nSuffix',
        "Prefix\n\nSuffix",
      );
    });

    it("hides dangling <tool_call> content to end-of-string", () => {
      expectVisibleText(
        'Let me run.\n<tool_call>\n{"name": "find", "arguments": {}}\n',
        "Let me run.\n",
      );
    });

    it("strips standalone bracketed local-model tool blocks", () => {
      expectVisibleText(
        [
          "Let me check.",
          "[mempalace_mempalace_search]",
          '{"query":"codename","wing":"personal","room":"identities"}',
          "[END_TOOL_REQUEST]",
          "Done.",
        ].join("\n"),
        "Let me check.\n\nDone.",
      );
    });

    it("strips bracketed local-model tool blocks with named closing tags", () => {
      expectVisibleText(
        [
          "Before",
          "[mempalace_mempalace_search]",
          '{"query":"codename","limit":1}',
          "[/mempalace_mempalace_search]",
          "After",
        ].join("\n"),
        "Before\n\nAfter",
      );
    });

    it("strips Qwen-style <tool_call> with nested <function=...> XML", () => {
      expectVisibleText(
        "prefix\n<tool_call><function=read><parameter=path>/home/user</parameter></function></tool_call>\nsuffix",
        "prefix\n\nsuffix",
      );
    });

    it("strips Qwen-style <tool_call> with whitespace before nested XML", () => {
      expectVisibleText(
        "prefix\n<tool_call>\n<function=search><parameter=query>test</parameter></function>\n</tool_call>\nsuffix",
        "prefix\n\nsuffix",
      );
    });

    it("strips dangling Qwen-style <tool_call> with nested XML to end", () => {
      expectVisibleText("prefix\n<tool_call><function=read><parameter=path>/home", "prefix\n");
    });

    it("does not close early on </tool_call> text inside JSON strings", () => {
      expectVisibleText(
        [
          "prefix",
          "<tool_call>",
          '{"name":"x","arguments":{"html":"<div></tool_call><span>leak</span>"}}',
          "</tool_call>",
          "suffix",
        ].join("\n"),
        "prefix\n\nsuffix",
      );
    });

    it("does not close early on </tool_call> text inside single-quoted payload strings", () => {
      expectVisibleText(
        [
          "prefix",
          "<tool_call>",
          "{'html':'</tool_call> leak','tail':'still hidden'}",
          "</tool_call>",
          "suffix",
        ].join("\n"),
        "prefix\n\nsuffix",
      );
    });

    it("does not close early on mismatched closing tool tags", () => {
      expectVisibleText(
        [
          "prefix",
          "<tool_call>",
          '{"name":"read",',
          "</function_calls>",
          "still-hidden",
          "</tool_call>",
          "suffix",
        ].join("\n"),
        "prefix\n\nsuffix",
      );
    });

    it("hides truncated <tool_call openings that never reach >", () => {
      expectVisibleText('prefix\n<tool_call\n{"name":"find","arguments":{}}', "prefix\n");
    });

    it("hides truncated <tool_call openings with attributes before JSON payload", () => {
      expectVisibleText('prefix\n<tool_call name="find"\n{"arguments":{}}', "prefix\n");
    });

    it("preserves lone <tool_call> mentions in normal prose", () => {
      expectVisibleText("Use <tool_call> to invoke tools.", "Use <tool_call> to invoke tools.");
    });

    it("strips self-closing <tool_call/> tags", () => {
      expectVisibleText("prefix <tool_call/> suffix", "prefix  suffix");
    });

    it("strips self-closing <function_calls .../> tags", () => {
      expectVisibleText('prefix <function_calls name="x"/> suffix', "prefix  suffix");
    });

    it("strips lone closing tool-call tags", () => {
      expectVisibleText("prefix </tool_call> suffix", "prefix  suffix");
      expectVisibleText("prefix </function_calls> suffix", "prefix  suffix");
      expectVisibleText("prefix </function> suffix", "prefix  suffix");
    });

    it("strips standalone <function> blocks with nested <parameter> XML (#67093)", () => {
      expectVisibleText(
        'prefix\n<function name="sessions_spawn"><parameter name="sessionKey">agent:main</parameter><parameter name="timeout">0</parameter></function>\nsuffix',
        "prefix\n\nsuffix",
      );
    });

    it("strips Gemma-style <function> with newlines between parameters (#67093)", () => {
      expectVisibleText(
        [
          "Let me check that.",
          '<function name="read">',
          '<parameter name="file_path">/home/user/test.md</parameter>',
          "</function>",
          "After the call.",
        ].join("\n"),
        "Let me check that.\n\nAfter the call.",
      );
    });

    it("strips inline standalone <function> blocks after sentence lead-ins", () => {
      expectVisibleText(
        'Let me check that. <function name="read"><parameter name="file_path">/tmp/test.md</parameter></function> Done.',
        "Let me check that.  Done.",
      );
    });

    it("strips standalone <function> blocks with apostrophes in XML payloads (#67093)", () => {
      expectVisibleText(
        [
          "prefix",
          '<function name="spawn">',
          '<parameter name="message">what\'s up</parameter>',
          "</function>",
          "suffix",
        ].join("\n"),
        "prefix\n\nsuffix",
      );
    });

    it("preserves dangling <function> blocks instead of hiding the tail", () => {
      expectVisibleText(
        'prefix\n<function name="spawn">\n<parameter name="key">value</parameter>',
        'prefix\n<function name="spawn">\n<parameter name="key">value</parameter>',
      );
    });

    it("preserves XML-style explanations after lone <tool_call> tags", () => {
      expectVisibleText("Use <tool_call><arg> literally.", "Use <tool_call><arg> literally.");
    });

    it("preserves lone <function> mentions in normal prose", () => {
      expectVisibleText(
        "Use <function> declarations in your WASM text format.",
        "Use <function> declarations in your WASM text format.",
      );
    });

    it("preserves literal XML-style paired tool_call examples in prose", () => {
      expectVisibleText(
        "prefix <tool_call><arg>secret</arg></tool_call> suffix",
        "prefix <tool_call><arg>secret</arg></tool_call> suffix",
      );
    });

    it("preserves inline bare <function> XML examples in prose", () => {
      expectVisibleText(
        'Use <function name="read"><parameter name="path">/tmp</parameter></function> in docs.',
        'Use <function name="read"><parameter name="path">/tmp</parameter></function> in docs.',
      );
    });

    it("preserves machine-style XML payload examples in prose", () => {
      expectVisibleText(
        'prefix <function_calls><invoke name="find">secret</invoke></function_calls> suffix',
        'prefix <function_calls><invoke name="find">secret</invoke></function_calls> suffix',
      );
    });

    it("preserves non-tool tag names that share the tool_call prefix", () => {
      expectVisibleText(
        'prefix <tool_call-example>{"name":"read"}</tool_call-example> suffix',
        'prefix <tool_call-example>{"name":"read"}</tool_call-example> suffix',
      );
    });

    it("preserves truncated <tool_call mentions in prose", () => {
      expectVisibleText("Use <tool_call to invoke tools.", "Use <tool_call to invoke tools.");
    });

    it("preserves truncated <tool_call mentions with prose attributes", () => {
      expectVisibleText(
        'Use <tool_call name="find" to invoke tools.',
        'Use <tool_call name="find" to invoke tools.',
      );
    });

    it("still strips later JSON payloads after a truncated prose mention", () => {
      expectVisibleText(
        'Use <tool_call to invoke tools.\n<tool_call>{"name":"find"}</tool_call>',
        "Use <tool_call to invoke tools.\n",
      );
    });

    it("still strips later JSON payloads after a truncated closing-tag mention", () => {
      expectVisibleText(
        'Use </tool_call to explain tags.\n<tool_call>{"name":"find"}</tool_call>',
        "Use </tool_call to explain tags.\n",
      );
    });

    it("still closes a tool-call block when malformed payload opens a fenced code region", () => {
      expectVisibleText(
        [
          "prefix",
          "<tool_call>",
          '{"name":"read",',
          "```xml",
          "<note>hi</note>",
          "</tool_call>",
          "suffix",
        ].join("\n"),
        "prefix\n\nsuffix",
      );
    });

    it("preserves truncated XML payload openings in prose", () => {
      expectVisibleText(
        'prefix\n<function_calls\n<invoke name="find">',
        'prefix\n<function_calls\n<invoke name="find">',
      );
    });

    it("hides truncated <function_calls openings with attributes before array payload", () => {
      expectVisibleText('prefix\n<function_calls id="x"\n[{"name":"find"}]', "prefix\n");
    });

    it("preserves tool-call tags inside fenced code blocks", () => {
      const input = [
        "```xml",
        '<tool_call> {"name": "find"} </tool_call>',
        "```",
        "",
        "Visible text",
      ].join("\n");
      expectVisibleText(input, input);
    });

    it("preserves inline code references to tool_call tags", () => {
      expectVisibleText("Use `<tool_call>` to invoke tools.", "Use `<tool_call>` to invoke tools.");
    });
  });

  describe("model special token stripping", () => {
    it("strips Kimi/GLM special tokens in isolation", () => {
      expectVisibleText("<|assistant|>Here is the answer<|end|>", "Here is the answer");
    });

    it("strips full-width pipe DeepSeek tokens", () => {
      expectVisibleText("<｜begin▁of▁sentence｜>Hello world", "Hello world");
    });

    it("strips special tokens mixed with normal text", () => {
      expectVisibleText(
        "Start <|tool_call_result_begin|>middle<|tool_call_result_end|> end",
        "Start middle end",
      );
    });

    it("preserves special-token-like syntax inside code blocks", () => {
      expectVisibleText("Use <div>hello</div> in HTML", "Use <div>hello</div> in HTML");
    });

    it("strips special tokens combined with reasoning tags", () => {
      const input = [
        "<thinking>",
        "internal reasoning",
        "</thinking>",
        "<|assistant|>Visible response",
      ].join("\n");
      expectVisibleText(input, "Visible response");
    });

    it("preserves indentation in code blocks", () => {
      const input = [
        "<|assistant|>Here is the code:",
        "",
        "```python",
        "def foo():",
        "    if True:",
        "        return 42",
        "```",
      ].join("\n");
      const expected = [
        "Here is the code:",
        "",
        "```python",
        "def foo():",
        "    if True:",
        "        return 42",
        "```",
      ].join("\n");
      expectVisibleText(input, expected);
    });

    it("preserves special tokens inside fenced code blocks", () => {
      const input = [
        "Here are the model tokens:",
        "",
        "```",
        "<|assistant|>Hello<|end|>",
        "```",
        "",
        "As you can see above.",
      ].join("\n");
      expectVisibleText(input, input);
    });

    it("preserves special tokens inside inline code spans", () => {
      expectVisibleText(
        "The token `<|assistant|>` marks the start.",
        "The token `<|assistant|>` marks the start.",
      );
    });

    it("preserves malformed tokens that end inside inline code spans", () => {
      expectVisibleText("Before <|token `code|>` after", "Before <|token `code|>` after");
    });

    it("preserves malformed tokens that end inside fenced code blocks", () => {
      const input = ["Before <|token", "```js", "const x = 1;|>", "```", "after"].join("\n");
      expectVisibleText(input, input);
    });

    it("resets special-token regex state between calls", () => {
      expect(stripModelSpecialTokens("prefix <|assistant|>")).toBe("prefix ");
      expect(stripModelSpecialTokens("<|assistant|>short")).toBe("short");
    });
  });
});

describe("sanitizeAssistantVisibleText", () => {
  it("strips minimax, tool XML, downgraded tool markers, and think tags in one pass", () => {
    const input = [
      '<invoke name="read">payload</invoke></minimax:tool_call>',
      '<tool_result>{"output":"hidden"}</tool_result>',
      "[Tool Call: read (ID: toolu_1)]",
      'Arguments: {"path":"/tmp/x"}',
      "<think>secret</think>",
      "Visible answer",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("Visible answer");
  });

  it("strips relevant-memories blocks on the canonical user-visible path", () => {
    const input = [
      "<relevant-memories>",
      "internal note",
      "</relevant-memories>",
      "Visible answer",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("Visible answer");
  });

  it("drops malformed reasoning before orphan close tags when final text follows", () => {
    expect(sanitizeAssistantVisibleText("private chain of thought </think> Visible answer")).toBe(
      "Visible answer",
    );
  });

  it("recovers fully wrapped unclosed reasoning tags that would otherwise deliver empty text", () => {
    expect(sanitizeAssistantVisibleText("<think>Visible answer from a malformed local model")).toBe(
      "Visible answer from a malformed local model",
    );
  });

  it("keeps unclosed trailing reasoning hidden when visible text already exists", () => {
    expect(sanitizeAssistantVisibleText("Visible prefix <think>private reasoning tail")).toBe(
      "Visible prefix",
    );
  });
});

describe("sanitizeAssistantVisibleTextWithProfile", () => {
  it("uses the history profile to preserve block-boundary whitespace", () => {
    const input = ["Hi ", '<tool_result>{"output":"hidden"}</tool_result>', "there"].join("");

    expect(sanitizeAssistantVisibleTextWithProfile(input, "history")).toBe("Hi there");
  });

  it("uses the history profile to drop malformed reasoning before orphan close tags", () => {
    expect(
      sanitizeAssistantVisibleTextWithProfile(
        "private chain of thought </think> Visible answer",
        "history",
      ),
    ).toBe(" Visible answer");
  });

  it("uses the internal-scaffolding profile to preserve downgraded tool text behavior", () => {
    const input = [
      "[Tool Call: read (ID: toolu_1)]",
      'Arguments: {"path":"/tmp/x"}',
      "Visible answer",
    ].join("\n");

    expect(sanitizeAssistantVisibleTextWithProfile(input, "internal-scaffolding")).toContain(
      "[Tool Call: read (ID: toolu_1)]",
    );
  });
});
