import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { extractAssistantText, formatReasoningMessage } from "./pi-embedded-utils.js";

describe("extractAssistantText", () => {
  it("strips Minimax tool invocation XML from text", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `<invoke name="Bash">
<parameter name="command">netstat -tlnp | grep 18789</parameter>
</invoke>
</minimax:tool_call>`,
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("strips multiple tool invocations", () => {
    const msg: AssistantMessage = {
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
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("Let me check that.");
  });

  it("keeps invoke snippets without Minimax markers", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Example:\n<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>`,
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe(
      `Example:\n<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>`,
    );
  });

  it("preserves normal text without tool invocations", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "This is a normal response without any tool calls.",
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("This is a normal response without any tool calls.");
  });

  it("strips Minimax tool invocations with extra attributes", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Before<invoke name='Bash' data-foo="bar">\n<parameter name="command">ls</parameter>\n</invoke>\n</minimax:tool_call>After`,
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("Before\nAfter");
  });

  it("strips minimax tool_call open and close tags", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Start<minimax:tool_call>Inner</minimax:tool_call>End",
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("StartInnerEnd");
  });

  it("ignores invoke blocks without minimax markers", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Before<invoke>Keep</invoke>After",
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("Before<invoke>Keep</invoke>After");
  });

  it("strips invoke blocks when minimax markers are present elsewhere", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Before<invoke>Drop</invoke><minimax:tool_call>After",
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("BeforeAfter");
  });

  it("strips invoke blocks with nested tags", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `A<invoke name="Bash"><param><deep>1</deep></param></invoke></minimax:tool_call>B`,
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("AB");
  });

  it("strips tool XML mixed with regular content", () => {
    const msg: AssistantMessage = {
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
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("I'll help you with that.\nHere are the results.");
  });

  it("handles multiple invoke blocks in one message", () => {
    const msg: AssistantMessage = {
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
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("First check.\nSecond check.\nDone.");
  });

  it("handles stray closing tags without opening tags", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Some text here.</minimax:tool_call>More text.",
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("Some text here.More text.");
  });

  it("returns empty string when message is only tool invocations", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `<invoke name="Bash">
<parameter name="command">test</parameter>
</invoke>
</minimax:tool_call>`,
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("handles multiple text blocks", () => {
    const msg: AssistantMessage = {
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
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("First block.\nThird block.");
  });

  it("strips downgraded Gemini tool call text representations", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `[Tool Call: exec (ID: toolu_vrtx_014w1P6B6w4V92v4VzG7Qk12)]
Arguments: { "command": "git status", "timeout": 120000 }`,
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("strips multiple downgraded tool calls", () => {
    const msg: AssistantMessage = {
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
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("strips tool results for downgraded calls", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `[Tool Result for ID toolu_123]
{"status": "ok", "data": "some result"}`,
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("preserves text around downgraded tool calls", () => {
    const msg: AssistantMessage = {
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
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("Let me check that for you.");
  });

  it("preserves trailing text after downgraded tool call blocks", () => {
    const msg: AssistantMessage = {
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
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("Intro text.\nBack to the user.");
  });

  it("handles multiple text blocks with tool calls and results", () => {
    const msg: AssistantMessage = {
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
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("Here's what I found:\nDone checking.");
  });

  it("strips thinking tags from text content", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "<think>El usuario quiere retomar una tarea...</think>Aquí está tu respuesta.",
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("Aquí está tu respuesta.");
  });

  it("strips thinking tags with attributes", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `<think reason="deliberate">Hidden</think>Visible`,
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("Visible");
  });

  it("strips thinking tags without closing tag", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "<think>Pensando sobre el problema...",
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("strips thinking tags with various formats", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Before<thinking>internal reasoning</thinking>After",
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("BeforeAfter");
  });

  it("strips antthinking tags", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "<antthinking>Some reasoning</antthinking>The actual answer.",
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("The actual answer.");
  });

  it("strips final tags while keeping content", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "<final>\nAnswer\n</final>",
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("Answer");
  });

  it("strips thought tags", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "<thought>Internal deliberation</thought>Final response.",
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("Final response.");
  });

  it("handles nested or multiple thinking blocks", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Start<think>first thought</think>Middle<think>second thought</think>End",
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("StartMiddleEnd");
  });
});

describe("formatReasoningMessage", () => {
  it("returns empty string for empty input", () => {
    expect(formatReasoningMessage("")).toBe("");
  });

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
