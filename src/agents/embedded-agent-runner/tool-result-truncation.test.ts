// Tool-result truncation tests cover live and persisted shrinking of oversized
// tool outputs while preserving transcript shape and update notifications.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceTranscriptEvents,
} from "../../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import type { SessionEntry as SessionStoreEntry } from "../../config/sessions/types.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { formatFullOutputFooter } from "../sessions/tools/tool-contracts.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { buildRuntimeContextCustomMessage } from "./run/runtime-context-prompt.js";
import {
  getEmbeddedSessionPromptState,
  testing as sessionPromptStateTesting,
} from "./session-prompt-state.js";

let truncateToolResultText: typeof import("./tool-result-truncation.js").truncateToolResultText;
let truncateToolResultMessage: typeof import("./tool-result-truncation.js").truncateToolResultMessage;
let calculateMaxToolResultChars: typeof import("./tool-result-truncation.js").calculateMaxToolResultChars;
let calculateMaxToolResultCharsWithCap: typeof import("./tool-result-truncation.js").calculateMaxToolResultCharsWithCap;
let resolveAutoLiveToolResultMaxChars: typeof import("./tool-result-truncation.js").resolveAutoLiveToolResultMaxChars;
let getToolResultTextLength: typeof import("./tool-result-truncation.js").getToolResultTextLength;
let truncateOversizedToolResultsInMessages: typeof import("./tool-result-truncation.js").truncateOversizedToolResultsInMessages;
let truncateOversizedToolResultsInRuntimeTranscript: typeof import("./tool-result-truncation.js").truncateOversizedToolResultsInRuntimeTranscript;
let truncateOversizedToolResultsInSession: typeof import("./tool-result-truncation.js").truncateOversizedToolResultsInSession;
let truncateOversizedToolResultsInActiveTarget: typeof import("./tool-result-truncation.js").truncateOversizedToolResultsInActiveTarget;
let sessionLikelyHasOversizedToolResults: typeof import("./tool-result-truncation.js").sessionLikelyHasOversizedToolResults;
let estimateToolResultReductionPotential: typeof import("./tool-result-truncation.js").estimateToolResultReductionPotential;
let DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS: typeof import("./tool-result-truncation.js").DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS;
let resolveLiveToolResultMaxChars: typeof import("./tool-result-truncation.js").resolveLiveToolResultMaxChars;
let resolveLiveToolResultAggregateMaxChars: typeof import("./tool-result-truncation.js").resolveLiveToolResultAggregateMaxChars;
let createToolResultPromptProjectionState: typeof import("./tool-result-truncation.js").createToolResultPromptProjectionState;
let tmpDir: string | undefined;

async function loadFreshToolResultTruncationModuleForTest() {
  // Load after each setup so module-level constants and mocks stay isolated
  // across persisted-session and live-truncation tests.
  ({
    truncateToolResultText,
    truncateToolResultMessage,
    calculateMaxToolResultChars,
    calculateMaxToolResultCharsWithCap,
    resolveAutoLiveToolResultMaxChars,
    getToolResultTextLength,
    truncateOversizedToolResultsInMessages,
    truncateOversizedToolResultsInRuntimeTranscript,
    truncateOversizedToolResultsInSession,
    truncateOversizedToolResultsInActiveTarget,
    sessionLikelyHasOversizedToolResults,
    estimateToolResultReductionPotential,
    DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
    resolveLiveToolResultMaxChars,
    resolveLiveToolResultAggregateMaxChars,
    createToolResultPromptProjectionState,
  } = await import("./tool-result-truncation.js"));
}

let testTimestamp = 1;
const nextTimestamp = () => testTimestamp++;

beforeEach(async () => {
  testTimestamp = 1;
  await loadFreshToolResultTruncationModuleForTest();
});

afterEach(async () => {
  sessionPromptStateTesting.reset();
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    tmpDir = undefined;
  }
});

function makeToolResult(text: string, toolCallId = "call_1", details?: unknown): ToolResultMessage {
  // Tool-result fixtures use increasing timestamps so persisted branch rewrites
  // can preserve ordering while changing content.
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    ...(details !== undefined ? { details } : {}),
    timestamp: nextTimestamp(),
  };
}

function textWithFullOutputFooter(text: string, fullOutputPath: string): string {
  return `${text}\n\n[Showing truncated output. ${formatFullOutputFooter(fullOutputPath)}]`;
}

function realisticSpillPath(dir: string, name: string): string {
  return path.join(dir, `${name}-${"segment-".repeat(8)}output.log`);
}

function makeUserMessage(text: string): UserMessage {
  return {
    role: "user",
    content: text,
    timestamp: nextTimestamp(),
  };
}

function makeAssistantMessage(text: string): AssistantMessage {
  return makeAgentAssistantMessage({
    content: [{ type: "text", text }],
    model: "gpt-5.2",
    stopReason: "stop",
    timestamp: nextTimestamp(),
  });
}

function getFirstToolResultText(message: AgentMessage | ToolResultMessage): string {
  if (message.role !== "toolResult") {
    return "";
  }
  const firstBlock = message.content[0];
  return firstBlock && "text" in firstBlock ? firstBlock.text : "";
}

async function createTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tool-result-truncation-test-"));
  return tmpDir;
}

async function createShortTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "oc-"));
  return tmpDir;
}

describe("truncateToolResultText", () => {
  it("returns text unchanged when under limit", () => {
    const text = "hello world";
    expect(truncateToolResultText(text, 1000)).toBe(text);
  });

  it("truncates text that exceeds limit", () => {
    const text = "a".repeat(10_000);
    const result = truncateToolResultText(text, 5_000);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain("truncated");
  });

  it("preserves at least MIN_KEEP_CHARS (2000) when the budget allows it", () => {
    const text = "x".repeat(50_000);
    const result = truncateToolResultText(text, 3_000);
    expect(result.length).toBeGreaterThan(2000);
  });

  it("tries to break at newline boundary", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}: ${"x".repeat(50)}`).join("\n");
    const result = truncateToolResultText(lines, 3000);
    // Should contain truncation notice
    expect(result).toContain("truncated");
    // The truncated content should be shorter than the original
    expect(result.length).toBeLessThan(lines.length);
    // Extract the kept content (before the truncation suffix marker)
    const suffixIndex = result.indexOf("\n\n⚠️");
    if (suffixIndex > 0) {
      const keptContent = result.slice(0, suffixIndex);
      // Should end at a newline boundary (i.e., the last char before suffix is a complete line)
      const lastNewline = keptContent.lastIndexOf("\n");
      // The last newline should be near the end (within the last line)
      expect(lastNewline).toBeGreaterThan(keptContent.length - 100);
    }
  });

  it("supports custom suffix and min keep chars", () => {
    const text = "x".repeat(5_000);
    const result = truncateToolResultText(text, 300, {
      suffix: "\n\n[custom-truncated]",
      minKeepChars: 250,
    });
    expect(result).toContain("[custom-truncated]");
    expect(result.length).toBeGreaterThan(250);
  });

  it("keeps direct and suffix-only cuts on complete code points", () => {
    expect(
      truncateToolResultText("aaa😀z", 5, {
        suffix: "!",
        minKeepChars: 0,
      }),
    ).toBe("aaa!");
    expect(
      truncateToolResultText("abcdef", 1, {
        suffix: "😀",
        minKeepChars: 0,
      }),
    ).toBe("");
  });

  it("keeps both head and tail cuts on complete code points", () => {
    const marker = "\n\n⚠️ [... middle content omitted — showing head and tail ...]\n\n";
    const text = `${"a".repeat(6)}😀${"m".repeat(100)}😀${"x".repeat(22)} Error`;
    expect(
      truncateToolResultText(text, 100, {
        suffix: "!",
        minKeepChars: 1,
      }),
    ).toBe(`${"a".repeat(6)}${marker}${"x".repeat(22)} Error!`);
  });
});

describe("getToolResultTextLength", () => {
  it("sums all text blocks in tool results", () => {
    const msg: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      isError: false,
      content: [
        { type: "text", text: "abc" },
        { type: "image", data: "x", mimeType: "image/png" },
        { type: "text", text: "12345" },
      ],
      timestamp: nextTimestamp(),
    };

    expect(getToolResultTextLength(msg)).toBe(8);
  });

  it("counts Codex protocol toolResult content blocks", () => {
    const msg = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "exec",
      isError: false,
      content: [
        {
          type: "toolResult",
          toolUseId: "call_1",
          text: "codex output",
          content: "codex output",
        },
      ],
      timestamp: nextTimestamp(),
    } as unknown as ToolResultMessage;

    expect(getToolResultTextLength(msg)).toBe("codex output".length);
  });

  it("returns zero for non-toolResult messages", () => {
    expect(getToolResultTextLength(makeAssistantMessage("hello"))).toBe(0);
  });
});

describe("truncateToolResultMessage", () => {
  it("truncates with a custom suffix", () => {
    const msg: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "x".repeat(50_000) }],
      isError: false,
      timestamp: nextTimestamp(),
    };

    const result = truncateToolResultMessage(msg, 10_000, {
      suffix: "\n\n[persist-truncated]",
      minKeepChars: 2_000,
    });
    expect(result.role).toBe("toolResult");
    if (result.role !== "toolResult") {
      throw new Error("expected toolResult");
    }
    expect(getFirstToolResultText(result)).toContain("[persist-truncated]");
  });

  it("truncates Codex protocol toolResult content blocks and mirrored content", () => {
    const oversized = "x".repeat(50_000);
    const msg = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "exec",
      content: [
        {
          type: "toolResult",
          toolUseId: "call_1",
          text: oversized,
          content: oversized,
        },
      ],
      isError: false,
      timestamp: nextTimestamp(),
    } as unknown as ToolResultMessage;

    const result = truncateToolResultMessage(msg, 10_000, {
      suffix: "\n\n[persist-truncated]",
      minKeepChars: 2_000,
    });
    expect(result.role).toBe("toolResult");
    if (result.role !== "toolResult") {
      throw new Error("expected toolResult");
    }
    const firstBlock = result.content[0] as unknown as { text?: unknown; content?: unknown };
    expect(typeof firstBlock.text).toBe("string");
    expect(firstBlock.text).toContain("[persist-truncated]");
    expect(String(firstBlock.text).length).toBeLessThan(oversized.length);
    expect(firstBlock.content).toBe(firstBlock.text);
  });
});

describe("calculateMaxToolResultChars", () => {
  it("scales with context window size", () => {
    const small = calculateMaxToolResultChars(8_000);
    const large = calculateMaxToolResultChars(200_000);
    expect(large).toBeGreaterThan(small);
  });

  it("exports the low-context live cap constant", () => {
    expect(DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS).toBe(16_000);
  });

  it("auto-scales above the low-context cap for very large windows", () => {
    const result = calculateMaxToolResultChars(2_000_000); // 2M token window
    expect(result).toBeGreaterThan(DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS);
  });

  it("uses a larger auto cap for 128K contexts", () => {
    const result = calculateMaxToolResultChars(128_000);
    expect(result).toBe(32_000);
  });

  it("uses the largest auto cap for 200K contexts", () => {
    expect(resolveAutoLiveToolResultMaxChars(200_000)).toBe(64_000);
    expect(calculateMaxToolResultChars(200_000)).toBe(64_000);
  });

  it("supports a higher configured hard cap", () => {
    const result = calculateMaxToolResultCharsWithCap(128_000, 32_000);
    expect(result).toBe(32_000);
  });

  it("resolves per-agent tool-result cap overrides", () => {
    const result = resolveLiveToolResultMaxChars({
      contextWindowTokens: 128_000,
      cfg: {
        agents: {
          defaults: {
            contextLimits: {
              toolResultMaxChars: 24_000,
            },
          },
          list: [{ id: "writer" }],
        },
      },
      agentId: "writer",
    });
    expect(result).toBe(24_000);
  });

  it.each([
    { contextWindowTokens: 20_000, perResultMaxChars: 16_000, aggregateMaxChars: 64_000 },
    { contextWindowTokens: 128_000, perResultMaxChars: 32_000, aggregateMaxChars: 256_000 },
    { contextWindowTokens: 200_000, perResultMaxChars: 64_000, aggregateMaxChars: 400_000 },
    { contextWindowTokens: 1_000_000, perResultMaxChars: 64_000, aggregateMaxChars: 2_000_000 },
  ])(
    "resolves aggregate live cap for $contextWindowTokens token windows",
    ({ contextWindowTokens, perResultMaxChars, aggregateMaxChars }) => {
      expect(
        resolveLiveToolResultAggregateMaxChars({
          contextWindowTokens,
          perResultMaxChars,
        }),
      ).toBe(aggregateMaxChars);
    },
  );
});

describe("sessionLikelyHasOversizedToolResults", () => {
  it("returns true for individually oversized tool results", () => {
    const messages: AgentMessage[] = [makeToolResult("x".repeat(500_000))];
    expect(sessionLikelyHasOversizedToolResults({ messages, contextWindowTokens: 128_000 })).toBe(
      true,
    );
  });

  it("returns true for aggregate medium tool results that exceed the shared budget", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(500);
    const messages: AgentMessage[] = [
      makeToolResult(medium, "call_1"),
      makeToolResult(medium, "call_2"),
      makeToolResult(medium, "call_3"),
      makeToolResult(medium, "call_4"),
      makeToolResult(medium, "call_5"),
      makeToolResult(medium, "call_6"),
    ];
    expect(sessionLikelyHasOversizedToolResults({ messages, contextWindowTokens: 20_000 })).toBe(
      true,
    );
  });
});

describe("estimateToolResultReductionPotential", () => {
  it("reports no reducible budget when tool results are already small", () => {
    const messages: AgentMessage[] = [makeToolResult("small result")];

    const estimate = estimateToolResultReductionPotential({
      messages,
      contextWindowTokens: 128_000,
    });

    expect(estimate.toolResultCount).toBe(1);
    expect(estimate.maxReducibleChars).toBe(0);
  });

  it("estimates reducible chars for aggregate medium tool-result tails", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(400);
    const messages: AgentMessage[] = [
      makeToolResult(medium, "call_1"),
      makeToolResult(medium, "call_2"),
      makeToolResult(medium, "call_3"),
      makeToolResult(medium, "call_4"),
      makeToolResult(medium, "call_5"),
      makeToolResult(medium, "call_6"),
    ];

    const estimate = estimateToolResultReductionPotential({
      messages,
      contextWindowTokens: 20_000,
    });

    expect(estimate.toolResultCount).toBe(6);
    expect(estimate.oversizedCount).toBe(0);
    expect(estimate.aggregateReducibleChars).toBeGreaterThan(0);
    expect(estimate.maxReducibleChars).toBe(estimate.aggregateReducibleChars);
  });

  it("counts aggregate savings on top of oversized savings in a single pass", () => {
    const oversized = "x".repeat(500_000);
    const medium = "alpha beta gamma delta epsilon ".repeat(800);
    const messages: AgentMessage[] = [
      makeToolResult(oversized, "call_1"),
      makeToolResult(medium, "call_2"),
      makeToolResult(medium, "call_3"),
    ];

    const estimate = estimateToolResultReductionPotential({
      messages,
      contextWindowTokens: 128_000,
      aggregateMaxCharsOverride: 50_000,
    });

    expect(estimate.oversizedCount).toBeGreaterThan(0);
    expect(estimate.oversizedReducibleChars).toBeGreaterThan(0);
    expect(estimate.aggregateReducibleChars).toBeGreaterThan(0);
    expect(estimate.maxReducibleChars).toBe(
      estimate.oversizedReducibleChars + estimate.aggregateReducibleChars,
    );
  });

  it("lets explicit aggregate caps drive aggregate recovery estimates", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(600);
    const messages: AgentMessage[] = [
      makeToolResult(medium, "call_1"),
      makeToolResult(medium, "call_2"),
      makeToolResult(medium, "call_3"),
    ];

    const estimate = estimateToolResultReductionPotential({
      messages,
      contextWindowTokens: 128_000,
      maxCharsOverride: 120,
      aggregateMaxCharsOverride: 120,
    });

    expect(estimate.maxChars).toBe(120);
    expect(estimate.aggregateBudgetChars).toBe(120);
    expect(estimate.oversizedCount).toBe(3);
    expect(estimate.aggregateReducibleChars).toBeGreaterThan(0);
  });
});

describe("truncateOversizedToolResultsInMessages", () => {
  it("returns unchanged messages when nothing is oversized", () => {
    const messages = [
      makeUserMessage("hello"),
      makeAssistantMessage("using tool"),
      makeToolResult("small result"),
    ];
    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      200_000,
    );
    expect(truncatedCount).toBe(0);
    expect(result).toEqual(messages);
  });

  it("truncates oversized tool results", () => {
    const bigContent = "x".repeat(500_000);
    const messages: AgentMessage[] = [
      makeUserMessage("hello"),
      makeAssistantMessage("reading file"),
      makeToolResult(bigContent),
    ];
    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      128_000,
    );
    expect(truncatedCount).toBe(1);
    const toolResult = result[2];
    expect(toolResult?.role).toBe("toolResult");
    const text = toolResult ? getFirstToolResultText(toolResult) : "";
    expect(text.length).toBeLessThan(bigContent.length);
    expect(text).toContain("truncated");
  });

  it("preserves non-toolResult messages", () => {
    const messages = [
      makeUserMessage("hello"),
      makeAssistantMessage("reading file"),
      makeToolResult("x".repeat(500_000)),
    ];
    const { messages: result } = truncateOversizedToolResultsInMessages(messages, 128_000);
    expect(result[0]).toBe(messages[0]); // Same reference
    expect(result[1]).toBe(messages[1]); // Same reference
  });

  it("handles multiple oversized tool results", () => {
    const messages: AgentMessage[] = [
      makeUserMessage("hello"),
      makeAssistantMessage("reading files"),
      makeToolResult("x".repeat(500_000), "call_1"),
      makeToolResult("y".repeat(500_000), "call_2"),
    ];
    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      128_000,
    );
    expect(truncatedCount).toBe(2);
    for (const msg of result.slice(2)) {
      expect(msg.role).toBe("toolResult");
      const text = getFirstToolResultText(msg);
      expect(text.length).toBeLessThan(500_000);
    }
  });

  it("bounds aggregate tool-result text in prompt history without rewriting callers", () => {
    // Live replay truncates cloned tool-result messages; the source array keeps
    // full content for UI and transcript persistence.
    const medium = "alpha beta gamma delta epsilon ".repeat(800);
    const messages: AgentMessage[] = [
      makeUserMessage("hello"),
      makeAssistantMessage("calling tools"),
      makeToolResult(medium, "call_1"),
      makeToolResult(medium, "call_2"),
      makeToolResult(medium, "call_3"),
    ];

    const { messages: result, truncatedCount } = truncateOversizedToolResultsInMessages(
      messages,
      128_000,
      12_000,
      12_000,
    );

    const totalChars = result.reduce(
      (sum, message) =>
        sum + (message.role === "toolResult" ? getToolResultTextLength(message) : 0),
      0,
    );
    expect(truncatedCount).toBeGreaterThan(0);
    expect(totalChars).toBeLessThanOrEqual(12_000);
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[1]);
    expect(messages.reduce((sum, message) => sum + getToolResultTextLength(message), 0)).toBe(
      medium.length * 3,
    );
  });

  it("keeps prompt projections stable while enforcing aggregate recovery as history grows", () => {
    const prefix = [
      makeToolResult("p".repeat(15_000), "prefix_1"),
      makeToolResult("q".repeat(15_000), "prefix_2"),
    ];
    const suffix = [
      makeToolResult("x".repeat(15_000), "current_1"),
      makeToolResult("y".repeat(15_000), "current_2"),
    ];
    const messages = [...prefix, ...suffix];
    const projectionState = createToolResultPromptProjectionState();

    const first = truncateOversizedToolResultsInMessages(
      messages,
      128_000,
      12_000,
      12_000,
      projectionState,
    );
    const second = truncateOversizedToolResultsInMessages(
      [...messages, makeToolResult("z".repeat(15_000), "current_3")],
      128_000,
      12_000,
      12_000,
      projectionState,
    );

    expect(first.truncatedCount).toBe(4);
    expect(second.truncatedCount).toBe(1);
    expect(second.messages.every((message) => getToolResultTextLength(message) <= 12_000)).toBe(
      true,
    );
    expect(messages).toEqual([...prefix, ...suffix]);

    const stableState = createToolResultPromptProjectionState();
    const stableHistory = [
      makeToolResult("a".repeat(4_000), "stable_1"),
      makeToolResult("b".repeat(4_000), "stable_2"),
    ];
    const stableFirst = truncateOversizedToolResultsInMessages(
      stableHistory,
      128_000,
      12_000,
      12_000,
      stableState,
    );
    const stableSecond = truncateOversizedToolResultsInMessages(
      [...stableHistory, makeToolResult("c".repeat(3_000), "stable_3")],
      128_000,
      12_000,
      12_000,
      stableState,
    );
    expect(stableFirst.truncatedCount).toBe(0);
    expect(stableSecond.messages.slice(0, stableHistory.length)).toEqual(stableFirst.messages);
    const stableThird = truncateOversizedToolResultsInMessages(
      [
        ...stableHistory,
        makeToolResult("c".repeat(3_000), "stable_3"),
        makeToolResult("d".repeat(15_000), "stable_4"),
      ],
      128_000,
      12_000,
      12_000,
      stableState,
    );
    expect(stableThird.messages).toHaveLength(4);
    const stableFourth = truncateOversizedToolResultsInMessages(
      [
        ...stableHistory,
        makeToolResult("c".repeat(3_000), "stable_3"),
        makeToolResult("d".repeat(15_000), "stable_4"),
        makeToolResult("e".repeat(15_000), "stable_5"),
      ],
      128_000,
      12_000,
      12_000,
      stableState,
    );
    const lastText = stableFourth.messages.at(-1);
    expect(lastText && getToolResultTextLength(lastText)).toBeLessThanOrEqual(12_000);
  });

  it("keeps #99495 historical bytes stable across attempts sharing session state", () => {
    const state = getEmbeddedSessionPromptState("session-99495").toolResults;
    const history = [
      makeToolResult("a".repeat(4_000), "history_1"),
      makeToolResult("b".repeat(4_000), "history_2"),
    ];
    const first = truncateOversizedToolResultsInMessages(history, 128_000, 5_000, 20_000, state);
    const secondAttemptState = getEmbeddedSessionPromptState("session-99495").toolResults;
    const second = truncateOversizedToolResultsInMessages(
      [...history, makeToolResult("c".repeat(12_000), "current")],
      128_000,
      5_000,
      20_000,
      secondAttemptState,
    );

    expect(secondAttemptState).toBe(state);
    expect(second.messages.slice(0, history.length)).toEqual(first.messages);
  });

  it("shrinks #99495 frozen bytes monotonically only under a tighter hard cap", () => {
    const state = getEmbeddedSessionPromptState("session-99495-shrink").toolResults;
    const history = [
      makeToolResult("a".repeat(8_000), "history_1"),
      makeToolResult("b".repeat(8_000), "history_2"),
    ];
    const first = truncateOversizedToolResultsInMessages(history, 128_000, 6_000, 20_000, state);
    const shrunk = truncateOversizedToolResultsInMessages(history, 128_000, 3_000, 20_000, state);
    const relaxed = truncateOversizedToolResultsInMessages(history, 128_000, 7_000, 20_000, state);
    const lengths = (messages: AgentMessage[]) => messages.map(getToolResultTextLength);

    expect(
      lengths(shrunk.messages).every((length, index) => length <= lengths(first.messages)[index]!),
    ).toBe(true);
    expect(relaxed.messages).toEqual(shrunk.messages);
  });

  it("preserves fresh trailing tool results when aggregate history is already saturated", () => {
    const projectionState = createToolResultPromptProjectionState();
    const history: AgentMessage[] = [];
    for (let index = 0; index < 50; index++) {
      history.push(makeAssistantMessage(`call ${index}`));
      history.push(makeToolResult("x".repeat(4_000), `history_${index}`));
    }
    history.push(makeUserMessage("run echo"));

    const first = truncateOversizedToolResultsInMessages(
      history,
      1_000_000,
      8_000,
      32_000,
      projectionState,
    );
    expect(first.truncatedCount).toBeGreaterThan(0);

    const freshOutput = "ABC";
    const second = truncateOversizedToolResultsInMessages(
      [...history, makeAssistantMessage("running exec"), makeToolResult(freshOutput, "fresh_exec")],
      1_000_000,
      8_000,
      32_000,
      projectionState,
    );

    const freshResult = second.messages.at(-1);
    const totalChars = second.messages.reduce(
      (sum, message) =>
        sum + (message.role === "toolResult" ? getToolResultTextLength(message) : 0),
      0,
    );
    expect(freshResult?.role).toBe("toolResult");
    expect(freshResult && getFirstToolResultText(freshResult)).toBe(freshOutput);
    expect(totalChars).toBeLessThanOrEqual(32_000);
  });

  it("preserves fresh tool results through a trailing runtime context carrier", () => {
    const projectionState = createToolResultPromptProjectionState();
    const history: AgentMessage[] = [];
    for (let index = 0; index < 50; index++) {
      history.push(makeAssistantMessage(`call ${index}`));
      history.push(makeToolResult("x".repeat(4_000), `history_${index}`));
    }
    history.push(makeUserMessage("run echo with extra context"));

    const first = truncateOversizedToolResultsInMessages(
      history,
      1_000_000,
      8_000,
      32_000,
      projectionState,
    );
    expect(first.truncatedCount).toBeGreaterThan(0);

    const freshOutput = "OC99756_EXEC_MARKER_".padEnd(4_000, "x");
    const runtimeContextMessage = buildRuntimeContextCustomMessage("runtime context refresh");
    if (!runtimeContextMessage) {
      throw new Error("expected runtime context message");
    }
    const providerMessages = convertToLlm([
      ...history,
      makeAssistantMessage("running exec"),
      makeToolResult(freshOutput, "fresh_exec"),
      runtimeContextMessage,
    ] as AgentMessage[]) as AgentMessage[];
    const providerCarrier = providerMessages.at(-1) as
      | (AgentMessage & { runtimeContextCarrier?: boolean })
      | undefined;
    expect(providerCarrier?.runtimeContextCarrier).toBe(true);

    const second = truncateOversizedToolResultsInMessages(
      providerMessages,
      1_000_000,
      8_000,
      32_000,
      projectionState,
    );

    const freshResult = second.messages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === "fresh_exec",
    );
    const historicalResults = second.messages.filter(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId.startsWith("history_"),
    );
    const firstHistoricalLengths = new Map(
      first.messages.flatMap((message) =>
        message.role === "toolResult" && message.toolCallId.startsWith("history_")
          ? [[message.toolCallId, getToolResultTextLength(message)] as const]
          : [],
      ),
    );
    const totalChars = second.messages.reduce(
      (sum, message) =>
        sum + (message.role === "toolResult" ? getToolResultTextLength(message) : 0),
      0,
    );
    expect(freshResult && getFirstToolResultText(freshResult)).toBe(freshOutput);
    expect(
      historicalResults.some(
        (message) =>
          getToolResultTextLength(message) <
          (firstHistoricalLengths.get(message.toolCallId) ?? Number.POSITIVE_INFINITY),
      ),
    ).toBe(true);
    expect(second.aggregateTruncatedCount).toBeGreaterThan(0);
    expect(second.aggregatePressureEngaged).toBe(true);
    expect(totalChars).toBeLessThanOrEqual(32_000);
  });

  it("preserves multiple fresh tool results before queued steering", () => {
    const projectionState = createToolResultPromptProjectionState();
    const history: AgentMessage[] = [];
    for (let index = 0; index < 50; index++) {
      history.push(makeAssistantMessage(`call ${index}`));
      history.push(makeToolResult("x".repeat(4_000), `history_${index}`));
    }
    history.push(makeUserMessage("run several commands"));

    const first = truncateOversizedToolResultsInMessages(
      history,
      1_000_000,
      8_000,
      32_000,
      projectionState,
    );
    expect(first.truncatedCount).toBeGreaterThan(0);

    const freshOutputs = [
      "OC99241_SHORT_SENTINEL_".padEnd(234, "s"),
      "OC99241_LONG_SENTINEL_".padEnd(4_000, "l"),
    ];
    const second = truncateOversizedToolResultsInMessages(
      [
        ...history,
        makeAssistantMessage("running tools"),
        makeToolResult(freshOutputs[0]!, "fresh_short"),
        makeToolResult(freshOutputs[1]!, "fresh_long"),
        makeUserMessage("queued steering after tool execution"),
      ],
      1_000_000,
      8_000,
      32_000,
      projectionState,
    );

    const freshResults = second.messages.filter(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId.startsWith("fresh_"),
    );
    const historicalResults = second.messages.filter(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId.startsWith("history_"),
    );
    const firstHistoricalLengths = new Map(
      first.messages.flatMap((message) =>
        message.role === "toolResult" && message.toolCallId.startsWith("history_")
          ? [[message.toolCallId, getToolResultTextLength(message)] as const]
          : [],
      ),
    );
    const totalChars = second.messages.reduce(
      (sum, message) =>
        sum + (message.role === "toolResult" ? getToolResultTextLength(message) : 0),
      0,
    );

    expect(freshResults.map(getFirstToolResultText)).toEqual(freshOutputs);
    expect(
      historicalResults.some(
        (message) =>
          getToolResultTextLength(message) <
          (firstHistoricalLengths.get(message.toolCallId) ?? Number.POSITIVE_INFINITY),
      ),
    ).toBe(true);
    expect(second.aggregateTruncatedCount).toBeGreaterThan(0);
    expect(second.aggregatePressureEngaged).toBe(true);
    expect(totalChars).toBeLessThanOrEqual(32_000);
  });

  it("shrinks deferred fresh results when frozen history cannot satisfy the hard cap", () => {
    const projectionState = createToolResultPromptProjectionState();
    const history: AgentMessage[] = [
      makeToolResult("a".repeat(4_000), "history_a"),
      makeToolResult("b".repeat(4_000), "history_b"),
      makeUserMessage("establish a frozen projection baseline"),
    ];
    const first = truncateOversizedToolResultsInMessages(
      history,
      1_000_000,
      8_000,
      100,
      projectionState,
    );
    expect(first.aggregatePressureEngaged).toBe(true);

    const freshOutput = "OC99241_HARD_CAP_SENTINEL_".padEnd(4_000, "f");
    const runtimeContextMessage = buildRuntimeContextCustomMessage("hard-cap runtime context");
    if (!runtimeContextMessage) {
      throw new Error("expected runtime context message");
    }
    const providerMessages = convertToLlm([
      ...history,
      makeToolResult(freshOutput, "fresh_hard_cap"),
      runtimeContextMessage,
    ] as AgentMessage[]) as AgentMessage[];
    expect(
      (providerMessages.at(-1) as { runtimeContextCarrier?: boolean } | undefined)
        ?.runtimeContextCarrier,
    ).toBe(true);
    const second = truncateOversizedToolResultsInMessages(
      providerMessages,
      1_000_000,
      8_000,
      100,
      projectionState,
    );
    const freshResult = second.messages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === "fresh_hard_cap",
    );
    const freshText = freshResult ? getFirstToolResultText(freshResult) : "";
    const totalChars = second.messages.reduce(
      (sum, message) =>
        sum + (message.role === "toolResult" ? getToolResultTextLength(message) : 0),
      0,
    );

    expect(freshText.length).toBeGreaterThan(0);
    expect(freshText.length).toBeLessThan(freshOutput.length);
    expect(second.aggregateTruncatedCount).toBeGreaterThan(0);
    expect(second.aggregatePressureEngaged).toBe(true);
    expect(totalChars).toBeLessThanOrEqual(100);
  });

  it("caps oversized fresh trailing tool results without clearing them for aggregate recovery", () => {
    const projectionState = createToolResultPromptProjectionState();
    const history: AgentMessage[] = [];
    for (let index = 0; index < 50; index++) {
      history.push(makeAssistantMessage(`call ${index}`));
      history.push(makeToolResult("x".repeat(4_000), `history_${index}`));
    }
    history.push(makeUserMessage("run large command"));

    truncateOversizedToolResultsInMessages(history, 1_000_000, 8_000, 32_000, projectionState);

    const second = truncateOversizedToolResultsInMessages(
      [
        ...history,
        makeAssistantMessage("running exec"),
        makeToolResult("z".repeat(20_000), "fresh_large_exec"),
      ],
      1_000_000,
      8_000,
      32_000,
      projectionState,
    );

    const freshResult = second.messages.at(-1);
    const freshText = freshResult ? getFirstToolResultText(freshResult) : "";
    const totalChars = second.messages.reduce(
      (sum, message) =>
        sum + (message.role === "toolResult" ? getToolResultTextLength(message) : 0),
      0,
    );
    expect(freshResult?.role).toBe("toolResult");
    expect(freshText.length).toBeGreaterThan(0);
    expect(freshText.length).toBeLessThanOrEqual(8_000);
    expect(freshText).toContain("truncated");
    expect(totalChars).toBeLessThanOrEqual(32_000);
  });

  it("leaves fresh trailing batches intact when only they exceed the aggregate budget", () => {
    const projectionState = createToolResultPromptProjectionState();
    const messages: AgentMessage[] = [makeUserMessage("run several tools")];
    for (let index = 0; index < 5; index++) {
      messages.push(makeToolResult(String(index).repeat(8_000), `fresh_${index}`));
    }

    const result = truncateOversizedToolResultsInMessages(
      messages,
      1_000_000,
      8_000,
      32_000,
      projectionState,
    );
    const toolResults = result.messages.filter((message) => message.role === "toolResult");
    const totalChars = toolResults.reduce(
      (sum, message) => sum + getToolResultTextLength(message),
      0,
    );

    expect(result.truncatedCount).toBe(0);
    expect(result.aggregatePressureEngaged).toBe(true);
    expect(totalChars).toBeGreaterThan(32_000);
    expect(toolResults.every((message) => getFirstToolResultText(message).length > 0)).toBe(true);
  });

  it("keeps aggregate elision markers inside tiny explicit budgets", () => {
    const messages: AgentMessage[] = [
      makeToolResult("a".repeat(100), "tiny_1"),
      makeToolResult("b".repeat(100), "tiny_2"),
      makeToolResult("c".repeat(100), "tiny_3"),
    ];

    const result = truncateOversizedToolResultsInMessages(messages, 128_000, 100, 8);
    const totalChars = result.messages.reduce(
      (sum, message) =>
        sum + (message.role === "toolResult" ? getToolResultTextLength(message) : 0),
      0,
    );

    expect(result.truncatedCount).toBeGreaterThan(0);
    expect(totalChars).toBeLessThanOrEqual(8);
  });

  it("points aggregate elision at live spill files", async () => {
    const spillPath = path.join(await createShortTmpDir(), "o");
    await fs.writeFile(spillPath, "complete command output", { mode: 0o600 });
    const messages: AgentMessage[] = [
      makeToolResult(textWithFullOutputFooter("a".repeat(100), spillPath), "spill_1", {
        fullOutputPath: spillPath,
      }),
      makeToolResult("b".repeat(100), "spill_2"),
      makeToolResult("c".repeat(100), "spill_3"),
    ];

    const result = truncateOversizedToolResultsInMessages(messages, 128_000, 500, 100);
    const text = getFirstToolResultText(result.messages[0] ?? makeToolResult(""));

    expect(text).toContain("read");
    expect(text).toContain(spillPath);
    await fs.rm(spillPath, { force: true });
  });

  it("keeps capped spill markers distinct during aggregate elision", async () => {
    const spillPath = path.join(await createShortTmpDir(), "p");
    await fs.writeFile(spillPath, "partial web output", { mode: 0o600 });
    const messages: AgentMessage[] = [
      makeToolResult(textWithFullOutputFooter("a".repeat(100), spillPath), "partial_spill_1", {
        fullOutputPath: spillPath,
        spilledChars: 2_000_000,
        spillTruncated: true,
      }),
      makeToolResult("b".repeat(100), "partial_spill_2"),
      makeToolResult("c".repeat(100), "partial_spill_3"),
    ];

    const result = truncateOversizedToolResultsInMessages(messages, 128_000, 300, 100);
    const text = getFirstToolResultText(result.messages[0] ?? makeToolResult(""));

    expect(text).toContain("partial");
    expect(text).toContain(spillPath);
    expect(text).not.toContain("full output preserved");
    await fs.rm(spillPath, { force: true });
  });

  it("detects spill footers escaped inside JSON tool results", async () => {
    const spillPath = path.join(await createShortTmpDir(), "C:\\s");
    await fs.writeFile(spillPath, "json wrapped output", { mode: 0o600 });
    const messages: AgentMessage[] = [
      makeToolResult(
        JSON.stringify({ text: textWithFullOutputFooter("a".repeat(100), spillPath) }, null, 2),
        "escaped_spill_1",
        { fullOutputPath: spillPath },
      ),
      makeToolResult("b".repeat(100), "escaped_spill_2"),
      makeToolResult("c".repeat(100), "escaped_spill_3"),
    ];

    const result = truncateOversizedToolResultsInMessages(messages, 128_000, 300, 100);
    const text = getFirstToolResultText(result.messages[0] ?? makeToolResult(""));

    expect(text).toContain("read");
    expect(text).toContain(spillPath);
    await fs.rm(spillPath, { force: true });
  });

  it("falls back to rerun guidance when the spill file is gone", async () => {
    const dir = await createTmpDir();
    const spillPath = path.join(dir, "deleted-output.log");
    await fs.writeFile(spillPath, "complete command output", { mode: 0o600 });
    await fs.rm(spillPath);
    const messages: AgentMessage[] = [
      makeToolResult(textWithFullOutputFooter("a".repeat(100), spillPath), "deleted_spill_1", {
        fullOutputPath: spillPath,
      }),
      makeToolResult("b".repeat(100), "deleted_spill_2"),
      makeToolResult("c".repeat(100), "deleted_spill_3"),
    ];

    const result = truncateOversizedToolResultsInMessages(messages, 128_000, 100, 100);
    const text = getFirstToolResultText(result.messages[0] ?? makeToolResult(""));

    expect(text).toContain("[tool result elided");
    expect(text).not.toContain(spillPath);
  });

  it("keeps plain aggregate elision behavior without a spill pointer", () => {
    const messages: AgentMessage[] = [
      makeToolResult("a".repeat(100), "plain_1"),
      makeToolResult("b".repeat(100), "plain_2"),
      makeToolResult("c".repeat(100), "plain_3"),
    ];

    const result = truncateOversizedToolResultsInMessages(messages, 128_000, 100, 100);
    const text = getFirstToolResultText(result.messages[0] ?? makeToolResult(""));

    expect(text).toContain("[tool result elided");
    expect(text).not.toContain("full output preserved at");
  });

  it("does not disclose details-only spill paths during aggregate elision", async () => {
    const spillPath = path.join(await createTmpDir(), "private-output.log");
    await fs.writeFile(spillPath, "private output", { mode: 0o600 });
    const messages: AgentMessage[] = [
      makeToolResult("a".repeat(100), "private_spill_1", { fullOutputPath: spillPath }),
      makeToolResult("b".repeat(100), "private_spill_2"),
      makeToolResult("c".repeat(100), "private_spill_3"),
    ];

    const result = truncateOversizedToolResultsInMessages(messages, 128_000, 100, 100);
    const text = getFirstToolResultText(result.messages[0] ?? makeToolResult(""));

    expect(text).toContain("[tool result elided");
    expect(text).not.toContain(spillPath);
    await fs.rm(spillPath, { force: true });
  });

  it("floors tiny aggregate elision budgets at compact spill markers", async () => {
    const dir = await createTmpDir();
    const spillPath = path.join(dir, "budget-output.log");
    await fs.writeFile(spillPath, "complete command output", { mode: 0o600 });
    const messages: AgentMessage[] = [
      makeToolResult(textWithFullOutputFooter("a".repeat(100), spillPath), "budget_1", {
        fullOutputPath: spillPath,
      }),
      makeToolResult("b".repeat(100), "budget_2"),
      makeToolResult("c".repeat(100), "budget_3"),
    ];

    const result = truncateOversizedToolResultsInMessages(messages, 128_000, 1_000, 8);
    const text = getFirstToolResultText(result.messages[0] ?? makeToolResult(""));

    expect(text).toBe(`[read ${spillPath}]`);
  });

  it("keeps pointerless near-zero aggregate budgets sliced", () => {
    const messages: AgentMessage[] = [
      makeToolResult("a".repeat(100), "sliced_plain_1"),
      makeToolResult("b".repeat(100), "sliced_plain_2"),
      makeToolResult("c".repeat(100), "sliced_plain_3"),
    ];

    const result = truncateOversizedToolResultsInMessages(messages, 128_000, 1_000, 94);
    const texts = result.messages.map((message) => getFirstToolResultText(message));

    expect(
      texts.some((text) => text.startsWith("[tool result elided:") && !text.includes("rerun")),
    ).toBe(true);
  });

  it("keeps realistic spill pointers intact in near-zero aggregate elision budgets", async () => {
    const dir = await createTmpDir();
    const spillPath = realisticSpillPath(dir, "realistic");
    await fs.writeFile(spillPath, "complete command output", { mode: 0o600 });
    const messages: AgentMessage[] = [
      makeToolResult(textWithFullOutputFooter("a".repeat(2_000), spillPath), "realistic_1", {
        fullOutputPath: spillPath,
      }),
      makeToolResult("b".repeat(2_000), "realistic_2"),
      makeToolResult("c".repeat(2_000), "realistic_3"),
    ];

    const result = truncateOversizedToolResultsInMessages(messages, 128_000, 5_000, 1);
    const text = getFirstToolResultText(result.messages[0] ?? makeToolResult(""));

    expect(text).toBe(`[read ${spillPath}]`);
  });

  it("uses spill-aware aggregate truncation suffixes with realistic paths", async () => {
    const dir = await createTmpDir();
    const spillPath = realisticSpillPath(dir, "suffix");
    await fs.writeFile(spillPath, "complete command output", { mode: 0o600 });
    const messages: AgentMessage[] = [
      makeToolResult(textWithFullOutputFooter("a".repeat(5_000), spillPath), "suffix_1", {
        fullOutputPath: spillPath,
      }),
      makeToolResult("b".repeat(5_000), "suffix_2"),
    ];

    const result = truncateOversizedToolResultsInMessages(messages, 128_000, 8_000, 9_000);
    const text = getFirstToolResultText(result.messages[0] ?? makeToolResult(""));

    expect(text).toContain(`full output at ${spillPath}`);
    expect(text).not.toContain("narrow args");
  });

  it("does not restore filtered image blocks when reusing a projection", () => {
    const projectionState = createToolResultPromptProjectionState();
    const source = makeToolResult("x".repeat(15_000), "image_call");
    source.content = [
      { type: "image", data: "filtered-after-conversion" },
      { type: "text", text: "x".repeat(15_000) },
    ] as never;
    truncateOversizedToolResultsInMessages([source], 128_000, 12_000, 12_000, projectionState);

    const providerMessage: ToolResultMessage = {
      ...source,
      content: [
        { type: "text" as const, text: "Image reading is disabled." },
        { type: "text" as const, text: "x".repeat(15_000) },
      ],
    };
    const result = truncateOversizedToolResultsInMessages(
      [providerMessage],
      128_000,
      12_000,
      12_000,
      projectionState,
    ).messages[0] as ToolResultMessage | undefined;

    expect(result?.content?.[0]).toEqual({
      type: "text",
      text: "Image reading is disabled.",
    });
    expect(
      result?.content?.[1] && "text" in result.content[1] ? result.content[1].text.length : 0,
    ).toBeLessThan(15_000);
  });

  it("freezes #99495 ambiguous-key projections across filtered history", () => {
    const projectionState = createToolResultPromptProjectionState();
    const duplicate = (text: string) => ({
      role: "toolResult" as const,
      toolCallId: "duplicate-call",
      toolName: "duplicate",
      isError: false,
      timestamp: 1,
      content: [{ type: "text" as const, text }],
    });
    const first = truncateOversizedToolResultsInMessages(
      [duplicate("a".repeat(100)), duplicate("b".repeat(100))],
      128_000,
      100,
      100,
      projectionState,
    );
    const filtered = truncateOversizedToolResultsInMessages(
      [duplicate("b".repeat(100))],
      128_000,
      100,
      100,
      projectionState,
    );

    expect(first.messages[0]).not.toEqual(first.messages[1]);
    expect(filtered.messages[0]).toEqual(first.messages[1]);
  });
});

describe("truncateOversizedToolResultsInSession", () => {
  it("truncates SQLite runtime transcripts without treating the marker as a file", async () => {
    const dir = await createTmpDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "runtime-sqlite-tool-truncation";
    const sessionKey = "agent:main:test";
    const sessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await replaceSessionEntry({ sessionKey, storePath }, {
      sessionFile,
      sessionId,
      updatedAt: 10,
    } as SessionStoreEntry);
    await appendTranscriptMessage(scope, {
      message: makeUserMessage("run tools"),
    });
    const medium = "alpha beta gamma delta epsilon ".repeat(600);
    await appendTranscriptMessage(scope, {
      message: makeToolResult(medium, "call_1"),
    });
    await appendTranscriptMessage(scope, {
      message: makeToolResult(medium, "call_2"),
    });
    await appendTranscriptMessage(scope, {
      message: makeToolResult(medium, "call_3"),
    });

    const listener = vi.fn();
    const cleanup = onInternalSessionTranscriptUpdate(listener);
    const result = await truncateOversizedToolResultsInRuntimeTranscript({
      scope: { ...scope, sessionFile },
      contextWindowTokens: 100,
    });
    cleanup();

    expect(result.truncated).toBe(true);
    expect(result.truncatedCount).toBeGreaterThan(0);
    expect(listener).toHaveBeenCalledWith({
      sessionFile,
      sessionKey,
      agentId: "main",
      sessionId,
      target: { agentId: "main", sessionId, sessionKey },
    });

    const toolResultTexts = (await loadTranscriptEvents(scope))
      .filter(
        (entry): entry is { message: AgentMessage; type: "message" } =>
          typeof entry === "object" &&
          entry !== null &&
          "message" in entry &&
          "type" in entry &&
          entry.type === "message",
      )
      .map((entry) => entry.message)
      .filter((message): message is ToolResultMessage => message.role === "toolResult")
      .map(getFirstToolResultText);

    expect(toolResultTexts.some((text) => text.includes("truncated"))).toBe(true);
    expect(toolResultTexts.join("").length).toBeLessThan(medium.length * 3);
  });

  it("dispatches explicit file transcript targets to file-backed truncation", async () => {
    const dir = await createTmpDir();
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage(makeUserMessage("hello"));
    sm.appendMessage(makeAssistantMessage("calling tools"));
    sm.appendMessage(makeToolResult("x".repeat(500_000), "call_1"));
    const sessionFile = sm.getSessionFile()!;

    const result = await truncateOversizedToolResultsInActiveTarget({
      scope: {
        agentId: "main",
        sessionFile,
        sessionId: "explicit-file-session",
        sessionKey: "agent:main:explicit-file",
      },
      contextWindowTokens: 100,
    });

    expect(result.truncated).toBe(true);
    expect(result.truncatedCount).toBeGreaterThan(0);
    const toolResult = SessionManager.open(sessionFile)
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "toolResult");
    expect(
      toolResult?.type === "message" ? getFirstToolResultText(toolResult.message) : "",
    ).toContain("truncated");
  });

  it("honors SQLite leaf controls when truncating runtime transcripts", async () => {
    const dir = await createTmpDir();
    const storePath = path.join(dir, "sessions.json");
    const sessionId = "runtime-sqlite-leaf-tool-truncation";
    const sessionKey = "agent:main:test";
    const sessionFile = formatSqliteSessionFileMarker({
      agentId: "main",
      sessionId,
      storePath,
    });
    const scope = { agentId: "main", sessionId, sessionKey, storePath };
    await replaceSessionEntry({ sessionKey, storePath }, {
      sessionFile,
      sessionId,
      updatedAt: 10,
    } as SessionStoreEntry);
    const activeLarge = "selected branch tool output ".repeat(700);
    const inactiveLarge = "inactive branch tool output ".repeat(700);
    await replaceTranscriptEvents(scope, [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: dir,
      },
      {
        type: "message",
        id: "root-user",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: makeUserMessage("run tools"),
      },
      {
        type: "message",
        id: "selected-tool",
        parentId: "root-user",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: makeToolResult(activeLarge, "call_selected"),
      },
      {
        type: "message",
        id: "inactive-tool",
        parentId: "root-user",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: makeToolResult(inactiveLarge, "call_inactive"),
      },
      {
        type: "leaf",
        id: "selected-leaf",
        parentId: "inactive-tool",
        timestamp: "2026-01-01T00:00:04.000Z",
        targetId: "selected-tool",
      },
    ]);

    const result = await truncateOversizedToolResultsInRuntimeTranscript({
      scope: { ...scope, sessionFile },
      contextWindowTokens: 100,
    });

    expect(result.truncated).toBe(true);
    const messages = (await loadTranscriptEvents(scope))
      .filter(
        (entry): entry is { message: AgentMessage; type: "message" } =>
          typeof entry === "object" &&
          entry !== null &&
          "message" in entry &&
          "type" in entry &&
          entry.type === "message",
      )
      .map((entry) => entry.message);
    const selectedTool = messages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === "call_selected",
    );
    const inactiveTool = messages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === "call_inactive",
    );

    expect(selectedTool ? getFirstToolResultText(selectedTool) : "").toContain("truncated");
    expect(inactiveTool ? getFirstToolResultText(inactiveTool) : "").toBe(inactiveLarge);
  });

  it("readably truncates aggregate medium tool results in a session file", async () => {
    // Persisted truncation rewrites JSONL directly and emits the transcript
    // update event instead of reopening through SessionManager internals.
    const dir = await createTmpDir();
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage(makeUserMessage("hello"));
    sm.appendMessage(makeAssistantMessage("calling tools"));
    const medium = "alpha beta gamma delta epsilon ".repeat(600);
    sm.appendMessage(makeToolResult(medium, "call_1"));
    sm.appendMessage(makeToolResult(medium, "call_2"));
    sm.appendMessage(makeToolResult(medium, "call_3"));
    const sessionFile = sm.getSessionFile()!;

    const beforeBranch = SessionManager.open(sessionFile).getBranch();
    const beforeLengths = beforeBranch
      .filter((entry) => entry.type === "message")
      .map((entry) =>
        entry.type === "message" && entry.message.role === "toolResult"
          ? getToolResultTextLength(entry.message)
          : 0,
      )
      .filter((length) => length > 0);

    const openSpy = vi.spyOn(SessionManager, "open").mockImplementation(() => {
      throw new Error("SessionManager.open should not be used for persisted truncation");
    });
    const listener = vi.fn();
    const cleanup = onInternalSessionTranscriptUpdate(listener);
    const result = await truncateOversizedToolResultsInSession({
      sessionFile,
      sessionKey: "agent:main:test",
      contextWindowTokens: 100,
    });
    cleanup();
    openSpy.mockRestore();

    expect(result.truncated).toBe(true);
    expect(result.truncatedCount).toBeGreaterThan(0);
    expect(listener).toHaveBeenCalledWith({ sessionFile, sessionKey: "agent:main:test" });

    const afterBranch = SessionManager.open(sessionFile).getBranch();
    const afterToolResults = afterBranch.filter(
      (entry) => entry.type === "message" && entry.message.role === "toolResult",
    );
    const afterLengths = afterToolResults.map((entry) =>
      entry.type === "message" ? getToolResultTextLength(entry.message) : 0,
    );

    expect(afterLengths.reduce((sum, value) => sum + value, 0)).toBeLessThan(
      beforeLengths.reduce((sum, value) => sum + value, 0),
    );
    expect(
      afterToolResults.some((entry) =>
        entry.type === "message"
          ? getFirstToolResultText(entry.message).includes("truncated")
          : false,
      ),
    ).toBe(true);
    expect(
      afterToolResults.some((entry) =>
        entry.type === "message"
          ? getFirstToolResultText(entry.message).includes("[compacted:")
          : false,
      ),
    ).toBe(false);
  });

  it("prefers truncating older aggregate tool-result entries before newer results", async () => {
    // Newer tool results are more likely to matter to the current turn, so
    // aggregate recovery spends the cut on older results first.
    const dir = await createTmpDir();
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage(makeUserMessage("hello"));
    sm.appendMessage(makeAssistantMessage("calling tools"));
    const olderLarge = "older-large ".repeat(1_000);
    const newerEnough = "newer-enough ".repeat(500);
    sm.appendMessage(makeToolResult(olderLarge, "call_1"));
    sm.appendMessage(makeToolResult(newerEnough, "call_2"));
    const sessionFile = sm.getSessionFile()!;

    const beforeBranch = SessionManager.open(sessionFile).getBranch();
    const beforeToolResults = beforeBranch.filter(
      (entry) => entry.type === "message" && entry.message.role === "toolResult",
    );
    const beforeTexts = beforeToolResults.map((entry) =>
      entry.type === "message" ? getFirstToolResultText(entry.message) : "",
    );

    const result = await truncateOversizedToolResultsInSession({
      sessionFile,
      contextWindowTokens: 128_000,
      maxCharsOverride: DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
      aggregateMaxCharsOverride: DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
    });

    expect(result.truncated).toBe(true);
    expect(result.truncatedCount).toBe(1);

    const afterBranch = SessionManager.open(sessionFile).getBranch();
    const afterToolResults = afterBranch.filter(
      (entry) => entry.type === "message" && entry.message.role === "toolResult",
    );
    const afterTexts = afterToolResults.map((entry) =>
      entry.type === "message" ? getFirstToolResultText(entry.message) : "",
    );

    expect(afterTexts[0]).not.toBe(beforeTexts[0]);
    expect(afterTexts[0]).toContain("truncated");
    expect(afterTexts[1]).toBe(beforeTexts[1]);
  });

  it("allows persisted-session recovery truncation to shrink below the old 2k floor", async () => {
    const dir = await createTmpDir();
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage(makeUserMessage("hello"));
    sm.appendMessage(makeAssistantMessage("calling tools"));
    sm.appendMessage(makeToolResult("x".repeat(500_000), "call_1"));
    const sessionFile = sm.getSessionFile()!;

    const result = await truncateOversizedToolResultsInSession({
      sessionFile,
      contextWindowTokens: 100,
    });

    expect(result.truncated).toBe(true);
    const afterBranch = SessionManager.open(sessionFile).getBranch();
    const toolResult = afterBranch.find(
      (entry) => entry.type === "message" && entry.message.role === "toolResult",
    );
    expect(toolResult?.type).toBe("message");
    if (!toolResult || toolResult.type !== "message") {
      throw new Error("expected truncated tool result");
    }
    const text = getFirstToolResultText(toolResult.message);
    expect(text.length).toBeLessThan(2_000);
    expect(text).toContain("truncated");
  });

  it("leaves protected trailing batches intact during persisted aggregate recovery", async () => {
    const dir = await createTmpDir();
    const sm = SessionManager.create(dir, dir);
    const firstKeptEntryId = sm.appendMessage(makeUserMessage("hello"));
    sm.appendMessage(makeAssistantMessage("calling tools"));
    const beforeTexts = Array.from({ length: 5 }, (_, index) => String(index).repeat(8_000));
    for (const [index, text] of beforeTexts.entries()) {
      sm.appendMessage(makeToolResult(text, `fresh_${index}`));
    }
    sm.appendCompaction("summary", firstKeptEntryId, 10);
    const sessionFile = sm.getSessionFile()!;

    const result = await truncateOversizedToolResultsInSession({
      sessionFile,
      contextWindowTokens: 1_000_000,
      maxCharsOverride: 8_000,
      aggregateMaxCharsOverride: 32_000,
      protectTrailingToolResults: true,
    });

    expect(result.truncated).toBe(false);
    const afterBranch = SessionManager.open(sessionFile).getBranch();
    const afterTexts = afterBranch
      .filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
      .map((entry) => (entry.type === "message" ? getFirstToolResultText(entry.message) : ""));

    expect(afterTexts).toEqual(beforeTexts);
  });

  it("combines oversized and aggregate recovery truncation in the same session rewrite", async () => {
    const dir = await createTmpDir();
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage(makeUserMessage("hello"));
    sm.appendMessage(makeAssistantMessage("calling tools"));
    sm.appendMessage(makeToolResult("x".repeat(500_000), "call_1"));
    const medium = "alpha beta gamma delta epsilon ".repeat(800);
    sm.appendMessage(makeToolResult(medium, "call_2"));
    sm.appendMessage(makeToolResult(medium, "call_3"));
    const sessionFile = sm.getSessionFile()!;

    const result = await truncateOversizedToolResultsInSession({
      sessionFile,
      contextWindowTokens: 100,
    });

    expect(result.truncated).toBe(true);
    expect(result.truncatedCount).toBe(3);

    const afterBranch = SessionManager.open(sessionFile).getBranch();
    const toolResults = afterBranch.filter(
      (entry) => entry.type === "message" && entry.message.role === "toolResult",
    );
    const toolTexts = toolResults.map((entry) =>
      entry.type === "message" ? getFirstToolResultText(entry.message) : "",
    );

    expect(toolTexts[0]).toContain("truncated");
    expect(toolTexts[1].length).toBeGreaterThan(0);
    expect(toolTexts[2].length).toBeGreaterThan(0);
  });

  it("lets aggregate recovery honor a tiny explicit cap during persisted rewrite", async () => {
    const dir = await createTmpDir();
    const sm = SessionManager.create(dir, dir);
    sm.appendMessage(makeUserMessage("hello"));
    sm.appendMessage(makeAssistantMessage("calling tools"));
    const medium = "alpha beta gamma delta epsilon ".repeat(800);
    sm.appendMessage(makeToolResult(medium, "call_1"));
    sm.appendMessage(makeToolResult(medium, "call_2"));
    sm.appendMessage(makeToolResult(medium, "call_3"));
    const sessionFile = sm.getSessionFile()!;

    const result = await truncateOversizedToolResultsInSession({
      sessionFile,
      contextWindowTokens: 128_000,
      maxCharsOverride: 120,
      aggregateMaxCharsOverride: 120,
    });

    expect(result.truncated).toBe(true);
    const afterBranch = SessionManager.open(sessionFile).getBranch();
    const toolResults = afterBranch.filter(
      (entry) => entry.type === "message" && entry.message.role === "toolResult",
    );
    const totalChars = toolResults.reduce(
      (sum, entry) => sum + (entry.type === "message" ? getToolResultTextLength(entry.message) : 0),
      0,
    );

    expect(totalChars).toBeLessThanOrEqual(120);
    expect(
      toolResults.some((entry) =>
        entry.type === "message"
          ? getFirstToolResultText(entry.message).includes("truncated")
          : false,
      ),
    ).toBe(true);
  });
});

describe("truncateToolResultText head+tail strategy", () => {
  it("preserves error content at the tail when present", () => {
    const head = "Line 1\n".repeat(500);
    const middle = "data data data\n".repeat(500);
    const tail = "\nError: something failed\nStack trace: at foo.ts:42\n";
    const text = head + middle + tail;
    const result = truncateToolResultText(text, 5000);
    // Should contain both the beginning and the error at the end
    expect(result).toContain("Line 1");
    expect(result).toContain("Error: something failed");
    expect(result).toContain("middle content omitted");
  });

  it("uses simple head truncation when tail has no important content", () => {
    const text = "normal line\n".repeat(1000);
    const result = truncateToolResultText(text, 5000);
    expect(result).toContain("normal line");
    expect(result).not.toContain("middle content omitted");
    expect(result).toContain("truncated");
  });
});
