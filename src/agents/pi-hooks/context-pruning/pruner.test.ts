import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { pruneContextMessages } from "./pruner.js";
import { DEFAULT_CONTEXT_PRUNING_SETTINGS } from "./settings.js";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type AssistantContentBlock = AssistantMessage["content"][number];

const CONTEXT_WINDOW_1M = {
  model: { contextWindow: 1_000_000 },
} as unknown as ExtensionContext;
const CONTEXT_WINDOW_5K = {
  model: { contextWindow: 5_000 },
} as unknown as ExtensionContext;

function makeUser(text: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  };
}

function makeAssistant(content: AssistantMessage["content"]): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function makeToolResult(
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >,
): AgentMessage {
  return {
    role: "toolResult",
    toolName: "read",
    content,
    timestamp: Date.now(),
  } as AgentMessage;
}

function pruneWithOversizedAssistantThinking(params: {
  assistantBlock: AssistantContentBlock;
  dropThinkingBlocksForEstimate?: boolean;
}) {
  return pruneContextMessages({
    messages: [
      makeUser("hello"),
      makeToolResult([{ type: "text", text: "X".repeat(2_000) }]),
      makeAssistant([params.assistantBlock, { type: "text", text: "done" }]),
    ],
    settings: {
      ...buildToolTrimSettings(),
    },
    ctx: CONTEXT_WINDOW_5K,
    isToolPrunable: () => true,
    ...(params.dropThinkingBlocksForEstimate ? { dropThinkingBlocksForEstimate: true } : {}),
  });
}

function buildToolTrimSettings() {
  return {
    mode: DEFAULT_CONTEXT_PRUNING_SETTINGS.mode,
    ttlMs: DEFAULT_CONTEXT_PRUNING_SETTINGS.ttlMs,
    keepLastAssistants: 1,
    softTrimRatio: 0.5,
    hardClearRatio: DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClearRatio,
    minPrunableToolChars: DEFAULT_CONTEXT_PRUNING_SETTINGS.minPrunableToolChars,
    tools: DEFAULT_CONTEXT_PRUNING_SETTINGS.tools,
    softTrim: { maxChars: 200, headChars: 100, tailChars: 50 },
    hardClear: { ...DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClear, enabled: false },
  };
}

function expectToolResultWasTrimmed(result: AgentMessage[]) {
  const toolResult = result.find((message) => message.role === "toolResult") as Extract<
    AgentMessage,
    { role: "toolResult" }
  >;
  const textBlock = toolResult.content[0] as { type: "text"; text: string };
  expect(textBlock.text).toContain("[Tool result trimmed:");
}

describe("pruneContextMessages", () => {
  it("does not crash on assistant message with malformed thinking block (missing thinking string)", () => {
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant([
        { type: "thinking" } as unknown as AssistantContentBlock,
        { type: "text", text: "ok" },
      ]),
    ];
    expect(() =>
      pruneContextMessages({
        messages,
        settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
        ctx: CONTEXT_WINDOW_1M,
      }),
    ).not.toThrow();
  });

  it("does not crash on assistant message with null content entries", () => {
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant([null as unknown as AssistantContentBlock, { type: "text", text: "world" }]),
    ];
    expect(() =>
      pruneContextMessages({
        messages,
        settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
        ctx: CONTEXT_WINDOW_1M,
      }),
    ).not.toThrow();
  });

  it("does not crash on assistant message with malformed text block (missing text string)", () => {
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant([
        { type: "text" } as unknown as AssistantContentBlock,
        { type: "thinking", thinking: "still fine" },
      ]),
    ];
    expect(() =>
      pruneContextMessages({
        messages,
        settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
        ctx: CONTEXT_WINDOW_1M,
      }),
    ).not.toThrow();
  });

  it("handles well-formed thinking blocks correctly", () => {
    const messages: AgentMessage[] = [
      makeUser("hello"),
      makeAssistant([
        { type: "thinking", thinking: "let me think" },
        { type: "text", text: "here is the answer" },
      ]),
    ];
    const result = pruneContextMessages({
      messages,
      settings: DEFAULT_CONTEXT_PRUNING_SETTINGS,
      ctx: CONTEXT_WINDOW_1M,
    });
    expect(result).toHaveLength(2);
  });

  it("counts thinkingSignature bytes when estimating assistant message size", () => {
    const result = pruneWithOversizedAssistantThinking({
      assistantBlock: {
        type: "thinking",
        thinking: "[redacted]",
        thinkingSignature: "S".repeat(40_000),
        redacted: true,
      } as unknown as AssistantContentBlock,
    });
    expectToolResultWasTrimmed(result);
  });

  it("counts redacted_thinking data bytes when estimating assistant message size", () => {
    const result = pruneWithOversizedAssistantThinking({
      assistantBlock: {
        type: "redacted_thinking",
        data: "D".repeat(40_000),
        thinkingSignature: "sig",
      } as unknown as AssistantContentBlock,
    });
    expectToolResultWasTrimmed(result);
  });

  it("ignores non-latest thinking signatures that will be dropped before send", () => {
    const messages: AgentMessage[] = [
      makeUser("first"),
      makeAssistant([
        {
          type: "thinking",
          thinking: "internal",
          thinkingSignature: "S".repeat(40_000),
        } as unknown as AssistantContentBlock,
        { type: "text", text: "older reply" },
      ]),
      makeToolResult([{ type: "text", text: "X".repeat(2_000) }]),
      makeUser("latest"),
      makeAssistant([{ type: "text", text: "latest reply" }]),
    ];

    const result = pruneContextMessages({
      messages,
      settings: {
        ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
        ...buildToolTrimSettings(),
      },
      ctx: CONTEXT_WINDOW_5K,
      isToolPrunable: () => true,
      dropThinkingBlocksForEstimate: true,
    });

    expect(result).toBe(messages);
  });

  it("soft-trims image-containing tool results by replacing image blocks with placeholders", () => {
    const messages: AgentMessage[] = [
      makeUser("summarize this"),
      makeToolResult([
        { type: "text", text: "A".repeat(120) },
        { type: "image", data: "img", mimeType: "image/png" },
        { type: "text", text: "B".repeat(120) },
      ]),
      makeAssistant([{ type: "text", text: "done" }]),
    ];

    const result = pruneContextMessages({
      messages,
      settings: {
        ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
        keepLastAssistants: 1,
        softTrimRatio: 0,
        hardClear: {
          ...DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClear,
          enabled: false,
        },
        softTrim: {
          maxChars: 200,
          headChars: 170,
          tailChars: 30,
        },
      },
      ctx: CONTEXT_WINDOW_1M,
      isToolPrunable: () => true,
      contextWindowTokensOverride: 16,
    });

    const toolResult = result[1] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(toolResult.content).toHaveLength(1);
    expect(toolResult.content[0]).toMatchObject({ type: "text" });
    const textBlock = toolResult.content[0] as { type: "text"; text: string };
    expect(textBlock.text).toContain("[image removed during context pruning]");
    expect(textBlock.text).toContain(
      "[Tool result trimmed: kept first 170 chars and last 30 chars",
    );
  });

  it("replaces image-only tool results with placeholders even when text trimming is not needed", () => {
    const messages: AgentMessage[] = [
      makeUser("summarize this"),
      makeToolResult([{ type: "image", data: "img", mimeType: "image/png" }]),
      makeAssistant([{ type: "text", text: "done" }]),
    ];

    const result = pruneContextMessages({
      messages,
      settings: {
        ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
        keepLastAssistants: 1,
        softTrimRatio: 0,
        hardClearRatio: 10,
        hardClear: {
          ...DEFAULT_CONTEXT_PRUNING_SETTINGS.hardClear,
          enabled: false,
        },
        softTrim: {
          maxChars: 5_000,
          headChars: 2_000,
          tailChars: 2_000,
        },
      },
      ctx: CONTEXT_WINDOW_1M,
      isToolPrunable: () => true,
      contextWindowTokensOverride: 1,
    });

    const toolResult = result[1] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(toolResult.content).toEqual([
      { type: "text", text: "[image removed during context pruning]" },
    ]);
  });

  it("hard-clears image-containing tool results once ratios require clearing", () => {
    const messages: AgentMessage[] = [
      makeUser("summarize this"),
      makeToolResult([
        { type: "text", text: "small text" },
        { type: "image", data: "img", mimeType: "image/png" },
      ]),
      makeAssistant([{ type: "text", text: "done" }]),
    ];

    const placeholder = "[hard cleared test placeholder]";
    const result = pruneContextMessages({
      messages,
      settings: {
        ...DEFAULT_CONTEXT_PRUNING_SETTINGS,
        keepLastAssistants: 1,
        softTrimRatio: 0,
        hardClearRatio: 0,
        minPrunableToolChars: 1,
        softTrim: {
          maxChars: 5_000,
          headChars: 2_000,
          tailChars: 2_000,
        },
        hardClear: {
          enabled: true,
          placeholder,
        },
      },
      ctx: CONTEXT_WINDOW_1M,
      isToolPrunable: () => true,
      contextWindowTokensOverride: 8,
    });

    const toolResult = result[1] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(toolResult.content).toEqual([{ type: "text", text: placeholder }]);
  });
});
