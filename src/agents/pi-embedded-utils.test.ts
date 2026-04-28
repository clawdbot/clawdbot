import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  extractAssistantText,
  extractAssistantThinking,
  extractAssistantVisibleText,
  formatReasoningMessage,
  promoteThinkingTagsToBlocks,
  stripDowngradedToolCallText,
} from "./pi-embedded-utils.js";

function makeAssistantMessage(
  message: Omit<AssistantMessage, "api" | "provider" | "model" | "usage" | "stopReason"> &
    Partial<Pick<AssistantMessage, "api" | "provider" | "model" | "usage" | "stopReason">> & {
      phase?: "commentary" | "final_answer";
    },
): AssistantMessage {
  return {
    api: "responses",
    provider: "openai",
    model: "gpt-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    ...message,
  };
}

describe("extractAssistantText", () => {
  it("strips tool-only Minimax invocation XML from text", () => {
    const cases = [
      `<invoke name="Bash">
<parameter name="command">netstat -tlnp | grep 18789</parameter>
</invoke>
</minimax:tool_call>`,
      `<invoke name="Bash">
<parameter name="command">test</parameter>
</invoke>
</minimax:tool_call>`,
    ];
    for (const text of cases) {
      const msg = makeAssistantMessage({
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      });
      expect(extractAssistantText(msg)).toBe("");
    }
  });

  it("strips multiple tool invocations", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Let me check that.<invoke name="Read">
<parameter name="path">/home/admin/test.txt</parameter>
</invoke>
</minimax:tool_call>`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("Let me check that.");
  });

  it("keeps invoke snippets without Minimax markers", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Example:\n<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe(
      `Example:\n<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>`,
    );
  });

  it("preserves normal text without tool invocations", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "This is a normal response without any tool calls.",
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("This is a normal response without any tool calls.");
  });

  it("sanitizes HTTP-ish error text only when stopReason is error", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: "500 Internal Server Error",
      content: [{ type: "text", text: "500 Internal Server Error" }],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("HTTP 500: Internal Server Error");
  });

  it("does not rewrite normal text that references billing plans", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Firebase downgraded Chore Champ to the Spark plan; confirm whether billing should be re-enabled.",
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe(
      "Firebase downgraded Chore Champ to the Spark plan; confirm whether billing should be re-enabled.",
    );
  });

  it("preserves response when errorMessage set from background failure (#13935)", () => {
    const responseText = "Handle payment required errors in your API.";
    const msg = makeAssistantMessage({
      role: "assistant",
      errorMessage: "insufficient credits for embedding model",
      stopReason: "stop",
      content: [{ type: "text", text: responseText }],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe(responseText);
  });

  it("strips Minimax tool invocations with extra attributes", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Before<invoke name='Bash' data-foo="bar">\n<parameter name="command">ls</parameter>\n</invoke>\n</minimax:tool_call>After`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("Before\nAfter");
  });

  it("strips minimax tool_call open and close tags", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Start<minimax:tool_call>Inner</minimax:tool_call>End",
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("StartInnerEnd");
  });

  it("ignores invoke blocks without minimax markers", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Before<invoke>Keep</invoke>After",
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("Before<invoke>Keep</invoke>After");
  });

  it("strips invoke blocks when minimax markers are present elsewhere", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Before<invoke>Drop</invoke><minimax:tool_call>After",
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("BeforeAfter");
  });

  it("strips invoke blocks with nested tags", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `A<invoke name="Bash"><param><deep>1</deep></param></invoke></minimax:tool_call>B`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("AB");
  });

  it("strips tool XML mixed with regular content", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `I'll help you with that.<invoke name="Bash">
<parameter name="command">ls -la</parameter>
</invoke>
</minimax:tool_call>Here are the results.`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("I'll help you with that.\nHere are the results.");
  });

  it("handles multiple invoke blocks in one message", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `First check.<invoke name="Read">
<parameter name="path">file1.txt</parameter>
</invoke>
</minimax:tool_call>Second check.<invoke name="Bash">
<parameter name="command">pwd</parameter>
</invoke>
</minimax:tool_call>Done.`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("First check.\nSecond check.\nDone.");
  });

  it("handles stray closing tags without opening tags", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Some text here.</minimax:tool_call>More text.",
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("Some text here.More text.");
  });

  it("handles multiple text blocks", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "First block.",
        },
        {
          type: "text",
          text: `<invoke name="Bash">
<parameter name="command">ls</parameter>
</invoke>
</minimax:tool_call>`,
        },
        {
          type: "text",
          text: "Third block.",
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("First block.\nThird block.");
  });

  it("strips downgraded Gemini tool call text representations", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `[Tool Call: exec (ID: toolu_vrtx_014w1P6B6w4V92v4VzG7Qk12)]
Arguments: { "command": "git status", "timeout": 120000 }`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("strips multiple downgraded tool calls", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `[Tool Call: read (ID: toolu_1)]
Arguments: { "path": "/some/file.txt" }
[Tool Call: exec (ID: toolu_2)]
Arguments: { "command": "ls -la" }`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("strips tool results for downgraded calls", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `[Tool Result for ID toolu_123]
{"status": "ok", "data": "some result"}`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("preserves text around downgraded tool calls", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Let me check that for you.
[Tool Call: browser (ID: toolu_abc)]
Arguments: { "action": "act", "request": "click button" }`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("Let me check that for you.");
  });

  it("preserves trailing text after downgraded tool call blocks", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Intro text.
[Tool Call: read (ID: toolu_1)]
Arguments: {
  "path": "/tmp/file.txt"
}
Back to the user.`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("Intro text.\nBack to the user.");
  });

  it("handles multiple text blocks with tool calls and results", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Here's what I found:",
        },
        {
          type: "text",
          text: `[Tool Call: read (ID: toolu_1)]
Arguments: { "path": "/test.txt" }`,
        },
        {
          type: "text",
          text: `[Tool Result for ID toolu_1]
File contents here`,
        },
        {
          type: "text",
          text: "Done checking.",
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("Here's what I found:\nDone checking.");
  });

  it("strips raw <tool_call> XML blocks from assistant text", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: 'Let me check.\n\n<tool_call> {"name": "read", "arguments": {"file_path": "test.md"}} </tool_call> Done.',
        },
      ],
      timestamp: Date.now(),
    });

    expect(extractAssistantText(msg)).toBe("Let me check.\n\n Done.");
  });

  it("strips raw <tool_result> XML blocks from assistant text", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: 'Prefix\n<tool_result> {"output": "file contents"} </tool_result>\nSuffix',
        },
      ],
      timestamp: Date.now(),
    });

    expect(extractAssistantText(msg)).toBe("Prefix\n\nSuffix");
  });

  it("strips dangling <tool_call> XML content to end-of-string", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: 'Let me run.\n<tool_call>\n{"name": "find", "arguments": {}}\n',
        },
      ],
      timestamp: Date.now(),
    });

    expect(extractAssistantText(msg)).toBe("Let me run.");
  });

  it("strips mixed <tool_call> and <tool_result> XML blocks from assistant text", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "I will read the file.",
            '<tool_call>{"name":"read","arguments":{"path":"/tmp/x"}}</tool_call>',
            '<tool_result>{"output":"hello world"}</tool_result>',
            "The file contains: hello world",
          ].join("\n"),
        },
      ],
      timestamp: Date.now(),
    });

    expect(extractAssistantText(msg)).toBe(
      "I will read the file.\n\n\nThe file contains: hello world",
    );
  });

  it("strips <tool_result> closed with mismatched </tool_call> tag and preserves trailing text", () => {
    // Issue #61688: gateway sometimes emits <tool_result>...</tool_call>
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: 'Prefix\n<tool_result> {"output": "data"} </tool_call>\nSuffix',
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    // The mismatched closing tag should still exit the block, stripping the
    // tool XML while preserving legitimate trailing prose.
    expect(result).not.toContain("<tool_result>");
    expect(result).not.toContain("output");
    expect(result).toContain("Prefix");
    expect(result).toContain("Suffix");
  });

  it("does not let </tool_result> close a <tool_call> block (prevents payload leak)", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: 'Prefix\n<tool_call>{"name":"x"}</tool_result>LEAK</tool_call>\nSuffix',
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    // </tool_result> must NOT exit a <tool_call> block; the block should
    // continue until the matching </tool_call>, preventing payload leaks.
    expect(result).not.toContain("LEAK");
    expect(result).not.toContain("<tool_call>");
    expect(result).toContain("Prefix");
    expect(result).toContain("Suffix");
  });

  it("strips reasoning/thinking tag variants", () => {
    const cases = [
      {
        name: "think tag",
        text: "<think>El usuario quiere retomar una tarea...</think>Aquí está tu respuesta.",
        expected: "Aquí está tu respuesta.",
      },
      {
        name: "think tag with attributes",
        text: `<think reason="deliberate">Hidden</think>Visible`,
        expected: "Visible",
      },
      {
        name: "unclosed think tag",
        text: "<think>Pensando sobre el problema...",
        expected: "Pensando sobre el problema...",
      },
      {
        name: "thinking tag",
        text: "Before<thinking>internal reasoning</thinking>After",
        expected: "BeforeAfter",
      },
      {
        name: "antthinking tag",
        text: "<antthinking>Some reasoning</antthinking>The actual answer.",
        expected: "The actual answer.",
      },
      {
        name: "antml namespaced thinking tag",
        text: "<antml:thinking>This shows Robin Waslander DMing maintainers o...</antml:thinking>Actual reply.",
        expected: "Actual reply.",
      },
      {
        name: "final wrapper",
        text: "<final>\nAnswer\n</final>",
        expected: "Answer",
      },
      {
        name: "thought tag",
        text: "<thought>Internal deliberation</thought>Final response.",
        expected: "Final response.",
      },
      {
        name: "multiple think blocks",
        text: "Start<think>first thought</think>Middle<think>second thought</think>End",
        expected: "StartMiddleEnd",
      },
    ] as const;

    for (const testCase of cases) {
      const msg = makeAssistantMessage({
        role: "assistant",
        content: [{ type: "text", text: testCase.text }],
        timestamp: Date.now(),
      });
      expect(extractAssistantText(msg), testCase.name).toBe(testCase.expected);
    }
  });
});

describe("formatReasoningMessage", () => {
  it("returns empty string for whitespace-only input", () => {
    expect(formatReasoningMessage("   \n  \t  ")).toBe("");
  });

  it("wraps single line in italics", () => {
    expect(formatReasoningMessage("Single line of reasoning")).toBe(
      "Reasoning:\n_Single line of reasoning_",
    );
  });

  it("wraps each line separately for multiline text (Telegram fix)", () => {
    expect(formatReasoningMessage("Line one\nLine two\nLine three")).toBe(
      "Reasoning:\n_Line one_\n_Line two_\n_Line three_",
    );
  });

  it("preserves empty lines between reasoning text", () => {
    expect(formatReasoningMessage("First block\n\nSecond block")).toBe(
      "Reasoning:\n_First block_\n\n_Second block_",
    );
  });

  it("handles mixed empty and non-empty lines", () => {
    expect(formatReasoningMessage("A\n\nB\nC")).toBe("Reasoning:\n_A_\n\n_B_\n_C_");
  });

  it("trims leading/trailing whitespace", () => {
    expect(formatReasoningMessage("  \n  Reasoning here  \n  ")).toBe(
      "Reasoning:\n_Reasoning here_",
    );
  });
});

describe("extractAssistantThinking", () => {
  it("surfaces signed native reasoning even when the provider returns an empty summary", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_live", summary: [] }),
        },
        { type: "text", text: "Done." },
      ],
      timestamp: Date.now(),
    });

    expect(extractAssistantThinking(msg)).toBe(
      "Native reasoning was produced; no summary text was returned.",
    );
  });
});

describe("stripDowngradedToolCallText", () => {
  it("strips downgraded marker blocks while preserving surrounding user-facing text", () => {
    const cases = [
      {
        name: "historical context only",
        text: `[Historical context: a different model called tool "exec" with arguments {"command":"git status"}]`,
        expected: "",
      },
      {
        name: "text before historical context",
        text: `Here is the answer.\n[Historical context: a different model called tool "read"]`,
        expected: "Here is the answer.",
      },
      {
        name: "text around historical context",
        text: `Before.\n[Historical context: tool call info]\nAfter.`,
        expected: "Before.\nAfter.",
      },
      {
        name: "multiple historical context blocks",
        text: `[Historical context: first tool call]\n[Historical context: second tool call]`,
        expected: "",
      },
      {
        name: "mixed tool call and historical context",
        text: `Intro.\n[Tool Call: exec (ID: toolu_1)]\nArguments: { "command": "ls" }\n[Historical context: a different model called tool "read"]`,
        expected: "Intro.",
      },
      {
        name: "no markers",
        text: "Just a normal response with no markers.",
        expected: "Just a normal response with no markers.",
      },
    ] as const;

    for (const testCase of cases) {
      expect(stripDowngradedToolCallText(testCase.text), testCase.name).toBe(testCase.expected);
    }
  });
});

describe("extractAssistantVisibleText", () => {
  it("prefers non-empty final_answer text over commentary", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Working...",
          textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ],
      timestamp: Date.now(),
    });

    expect(extractAssistantVisibleText(msg)).toBe("Done.");
  });

  it("does not fall back to commentary when final_answer is empty", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Working...",
          textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "   ",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ],
      timestamp: Date.now(),
    });

    expect(extractAssistantVisibleText(msg)).toBe("");
  });

  it("does not fall back to unphased legacy text when an empty final_answer block exists", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        { type: "text", text: "Legacy answer" },
        {
          type: "text",
          text: "   ",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ],
      timestamp: Date.now(),
    });

    expect(extractAssistantVisibleText(msg)).toBe("");
  });

  it("falls back to legacy unphased text when phased text is absent", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text: "Legacy answer" }],
      timestamp: Date.now(),
    });

    expect(extractAssistantVisibleText(msg)).toBe("Legacy answer");
  });

  it("does not pull unphased legacy text into final_answer extraction when phased blocks are present", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      phase: "final_answer",
      content: [
        { type: "text", text: "Legacy." },
        {
          type: "text",
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ],
      timestamp: Date.now(),
    });

    expect(extractAssistantVisibleText(msg)).toBe("Done.");
  });
});

describe("promoteThinkingTagsToBlocks", () => {
  it("does not crash on malformed null content entries", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [null as never, { type: "text", text: "<thinking>hello</thinking>ok" }],
      timestamp: Date.now(),
    });
    expect(() => promoteThinkingTagsToBlocks(msg)).not.toThrow();
    const types = msg.content.map((b: { type?: string }) => b?.type);
    expect(types).toContain("thinking");
    expect(types).toContain("text");
  });

  it("splits antml namespaced thinking tags into thinking blocks", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text: "<antml:thinking>hidden</antml:thinking>Visible" }],
      timestamp: Date.now(),
    });

    promoteThinkingTagsToBlocks(msg);
    expect(msg.content).toEqual([
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: "Visible" },
    ]);
  });

  it("does not crash on undefined content entries", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [undefined as never, { type: "text", text: "no tags here" }],
      timestamp: Date.now(),
    });
    expect(() => promoteThinkingTagsToBlocks(msg)).not.toThrow();
  });

  it("passes through well-formed content unchanged when no thinking tags", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello world" }],
      timestamp: Date.now(),
    });
    promoteThinkingTagsToBlocks(msg);
    expect(msg.content).toEqual([{ type: "text", text: "hello world" }]);
  });
});

describe("empty input handling", () => {
  it("returns empty string", () => {
    const helpers = [formatReasoningMessage, stripDowngradedToolCallText];
    for (const helper of helpers) {
      expect(helper("")).toBe("");
    }
  });
});
