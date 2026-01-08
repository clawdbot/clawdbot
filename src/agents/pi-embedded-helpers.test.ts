import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  buildBootstrapContextFiles,
  formatAssistantErrorText,
  isContextOverflowError,
  isMessagingToolDuplicate,
  normalizeTextForComparison,
  sanitizeGoogleTurnOrdering,
  validateGeminiTurns,
} from "./pi-embedded-helpers.js";
import {
  DEFAULT_AGENTS_FILENAME,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

const makeFile = (
  overrides: Partial<WorkspaceBootstrapFile>,
): WorkspaceBootstrapFile => ({
  name: DEFAULT_AGENTS_FILENAME,
  path: "/tmp/AGENTS.md",
  content: "",
  missing: false,
  ...overrides,
});

describe("validateGeminiTurns", () => {
  it("should return empty array unchanged", () => {
    const result = validateGeminiTurns([]);
    expect(result).toEqual([]);
  });

  it("should return single message unchanged", () => {
    const msgs: AgentMessage[] = [
      {
        role: "user",
        content: "Hello",
      },
    ];
    const result = validateGeminiTurns(msgs);
    expect(result).toEqual(msgs);
  });

  it("should leave alternating user/assistant unchanged", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
      { role: "user", content: "How are you?" },
      { role: "assistant", content: [{ type: "text", text: "Good!" }] },
    ];
    const result = validateGeminiTurns(msgs);
    expect(result).toHaveLength(4);
    expect(result).toEqual(msgs);
  });

  it("should merge consecutive assistant messages", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Part 1" }],
        stopReason: "end_turn",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Part 2" }],
        stopReason: "end_turn",
      },
      { role: "user", content: "How are you?" },
    ];

    const result = validateGeminiTurns(msgs);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ role: "user", content: "Hello" });
    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toHaveLength(2);
    expect(result[2]).toEqual({ role: "user", content: "How are you?" });
  });

  it("should preserve metadata from later message when merging", () => {
    const msgs: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Part 1" }],
        usage: { input: 10, output: 5 },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Part 2" }],
        usage: { input: 10, output: 10 },
        stopReason: "end_turn",
      },
    ];

    const result = validateGeminiTurns(msgs);

    expect(result).toHaveLength(1);
    const merged = result[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(merged.usage).toEqual({ input: 10, output: 10 });
    expect(merged.stopReason).toBe("end_turn");
    expect(merged.content).toHaveLength(2);
  });

  it("should handle toolResult messages without merging", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: "Use tool" },
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "tool-1", name: "test", input: {} }],
      },
      {
        role: "toolResult",
        toolUseId: "tool-1",
        content: [{ type: "text", text: "Result" }],
      },
      { role: "user", content: "Next request" },
    ];

    const result = validateGeminiTurns(msgs);

    expect(result).toHaveLength(4);
    expect(result).toEqual(msgs);
  });

  it("should handle real-world corrupted sequence", () => {
    // This is the pattern that causes Gemini errors:
    // user → assistant → assistant (consecutive, wrong!)
    const msgs: AgentMessage[] = [
      { role: "user", content: "Request 1" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Response A" }],
      },
      {
        role: "assistant",
        content: [{ type: "toolUse", id: "t1", name: "search", input: {} }],
      },
      {
        role: "toolResult",
        toolUseId: "t1",
        content: [{ type: "text", text: "Found data" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here's the answer" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Extra thoughts" }],
      },
      { role: "user", content: "Request 2" },
    ];

    const result = validateGeminiTurns(msgs);

    // Should merge the consecutive assistants
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    expect(result[2].role).toBe("toolResult");
    expect(result[3].role).toBe("assistant");
    expect(result[4].role).toBe("user");
  });
});

describe("buildBootstrapContextFiles", () => {
  it("keeps missing markers", () => {
    const files = [makeFile({ missing: true, content: undefined })];
    expect(buildBootstrapContextFiles(files)).toEqual([
      {
        path: DEFAULT_AGENTS_FILENAME,
        content: "[MISSING] Expected at: /tmp/AGENTS.md",
      },
    ]);
  });

  it("skips empty or whitespace-only content", () => {
    const files = [makeFile({ content: "   \n  " })];
    expect(buildBootstrapContextFiles(files)).toEqual([]);
  });

  it("truncates large bootstrap content", () => {
    const head = `HEAD-${"a".repeat(6000)}`;
    const tail = `${"b".repeat(3000)}-TAIL`;
    const long = `${head}${tail}`;
    const files = [makeFile({ content: long })];
    const [result] = buildBootstrapContextFiles(files);
    expect(result?.content).toContain(
      "[...truncated, read AGENTS.md for full content...]",
    );
    expect(result?.content.length).toBeLessThan(long.length);
    expect(result?.content.startsWith(long.slice(0, 120))).toBe(true);
    expect(result?.content.endsWith(long.slice(-120))).toBe(true);
  });
});

describe("isContextOverflowError", () => {
  it("matches known overflow hints", () => {
    const samples = [
      "request_too_large",
      "Request exceeds the maximum size",
      "context length exceeded",
      "Maximum context length",
      "413 Request Entity Too Large",
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(sample)).toBe(true);
    }
  });

  it("ignores unrelated errors", () => {
    expect(isContextOverflowError("rate limit exceeded")).toBe(false);
  });
});

describe("formatAssistantErrorText", () => {
  const makeAssistantError = (errorMessage: string): AssistantMessage =>
    ({
      stopReason: "error",
      errorMessage,
    }) as AssistantMessage;

  it("returns a friendly message for context overflow", () => {
    const msg = makeAssistantError("request_too_large");
    expect(formatAssistantErrorText(msg)).toContain("Context overflow");
  });
});

describe("sanitizeGoogleTurnOrdering", () => {
  it("prepends a synthetic user turn when history starts with assistant", () => {
    const input = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "bash", arguments: {} },
        ],
      },
    ] satisfies AgentMessage[];

    const out = sanitizeGoogleTurnOrdering(input);
    expect(out[0]?.role).toBe("user");
    expect(out[1]?.role).toBe("assistant");
  });

  it("is a no-op when history starts with user", () => {
    const input = [{ role: "user", content: "hi" }] satisfies AgentMessage[];
    const out = sanitizeGoogleTurnOrdering(input);
    expect(out).toBe(input);
  });
});

describe("normalizeTextForComparison", () => {
  it("lowercases text", () => {
    expect(normalizeTextForComparison("Hello World")).toBe("hello world");
  });

  it("trims whitespace", () => {
    expect(normalizeTextForComparison("  hello  ")).toBe("hello");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeTextForComparison("hello    world")).toBe("hello world");
  });

  it("strips emoji", () => {
    expect(normalizeTextForComparison("Hello 👋 World 🌍")).toBe("hello world");
  });

  it("handles mixed normalization", () => {
    expect(normalizeTextForComparison("  Hello 👋   WORLD  🌍  ")).toBe(
      "hello world",
    );
  });
});

describe("isMessagingToolDuplicate", () => {
  it("returns false for empty sentTexts", () => {
    expect(isMessagingToolDuplicate("hello world", [])).toBe(false);
  });

  it("returns false for short texts", () => {
    expect(isMessagingToolDuplicate("short", ["short"])).toBe(false);
  });

  it("detects exact duplicates", () => {
    expect(
      isMessagingToolDuplicate("Hello, this is a test message!", [
        "Hello, this is a test message!",
      ]),
    ).toBe(true);
  });

  it("detects duplicates with different casing", () => {
    expect(
      isMessagingToolDuplicate("HELLO, THIS IS A TEST MESSAGE!", [
        "hello, this is a test message!",
      ]),
    ).toBe(true);
  });

  it("detects duplicates with emoji variations", () => {
    expect(
      isMessagingToolDuplicate("Hello! 👋 This is a test message!", [
        "Hello! This is a test message!",
      ]),
    ).toBe(true);
  });

  it("detects substring duplicates (LLM elaboration)", () => {
    expect(
      isMessagingToolDuplicate(
        'I sent the message: "Hello, this is a test message!"',
        ["Hello, this is a test message!"],
      ),
    ).toBe(true);
  });

  it("detects when sent text contains block reply (reverse substring)", () => {
    expect(
      isMessagingToolDuplicate("Hello, this is a test message!", [
        'I sent the message: "Hello, this is a test message!"',
      ]),
    ).toBe(true);
  });

  it("returns false for non-matching texts", () => {
    expect(
      isMessagingToolDuplicate("This is completely different content.", [
        "Hello, this is a test message!",
      ]),
    ).toBe(false);
  });
});
