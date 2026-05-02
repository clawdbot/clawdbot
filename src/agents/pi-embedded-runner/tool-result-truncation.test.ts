import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";

let truncateToolResultText: typeof import("./tool-result-truncation.js").truncateToolResultText;
let truncateToolResultMessage: typeof import("./tool-result-truncation.js").truncateToolResultMessage;
let calculateMaxToolResultChars: typeof import("./tool-result-truncation.js").calculateMaxToolResultChars;
let calculateMaxToolResultCharsWithCap: typeof import("./tool-result-truncation.js").calculateMaxToolResultCharsWithCap;
let getToolResultTextLength: typeof import("./tool-result-truncation.js").getToolResultTextLength;
let truncateOversizedToolResultsInMessages: typeof import("./tool-result-truncation.js").truncateOversizedToolResultsInMessages;
let truncateOversizedToolResultsInSession: typeof import("./tool-result-truncation.js").truncateOversizedToolResultsInSession;
let isOversizedToolResult: typeof import("./tool-result-truncation.js").isOversizedToolResult;
let sessionLikelyHasOversizedToolResults: typeof import("./tool-result-truncation.js").sessionLikelyHasOversizedToolResults;
let estimateToolResultReductionPotential: typeof import("./tool-result-truncation.js").estimateToolResultReductionPotential;
let DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS: typeof import("./tool-result-truncation.js").DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS;
let HARD_MAX_TOOL_RESULT_CHARS: typeof import("./tool-result-truncation.js").HARD_MAX_TOOL_RESULT_CHARS;
let resolveLiveToolResultMaxChars: typeof import("./tool-result-truncation.js").resolveLiveToolResultMaxChars;
let tmpDir: string | undefined;

async function loadFreshToolResultTruncationModuleForTest() {
  ({
    truncateToolResultText,
    truncateToolResultMessage,
    calculateMaxToolResultChars,
    calculateMaxToolResultCharsWithCap,
    getToolResultTextLength,
    truncateOversizedToolResultsInMessages,
    truncateOversizedToolResultsInSession,
    isOversizedToolResult,
    sessionLikelyHasOversizedToolResults,
    estimateToolResultReductionPotential,
    DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS,
    HARD_MAX_TOOL_RESULT_CHARS,
    resolveLiveToolResultMaxChars,
  } = await import("./tool-result-truncation.js"));
}

let testTimestamp = 1;
const nextTimestamp = () => testTimestamp++;

beforeEach(async () => {
  testTimestamp = 1;
  await loadFreshToolResultTruncationModuleForTest();
});

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    tmpDir = undefined;
  }
});

function makeToolResult(text: string, toolCallId = "call_1"): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: nextTimestamp(),
  };
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
});

describe("calculateMaxToolResultChars", () => {
  it("scales with context window size", () => {
    const small = calculateMaxToolResultChars(8_000);
    const large = calculateMaxToolResultChars(200_000);
    expect(large).toBeGreaterThan(small);
  });

  it("exports the live cap through both constant names", () => {
    expect(DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS).toBe(16_000);
    expect(HARD_MAX_TOOL_RESULT_CHARS).toBe(DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS);
  });

  it("caps at HARD_MAX_TOOL_RESULT_CHARS for very large windows", () => {
    const result = calculateMaxToolResultChars(2_000_000); // 2M token window
    expect(result).toBeLessThanOrEqual(HARD_MAX_TOOL_RESULT_CHARS);
  });

  it("caps 128K contexts at the live tool-result ceiling", () => {
    const result = calculateMaxToolResultChars(128_000);
    expect(result).toBe(DEFAULT_MAX_LIVE_TOOL_RESULT_CHARS);
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
});

describe("isOversizedToolResult", () => {
  it("returns false for small tool results", () => {
    const msg = makeToolResult("small content");
    expect(isOversizedToolResult(msg, 200_000)).toBe(false);
  });

  it("returns true for oversized tool results", () => {
    const msg = makeToolResult("x".repeat(500_000));
    expect(isOversizedToolResult(msg, 128_000)).toBe(true);
  });

  it("honors an explicit higher maxChars override", () => {
    const msg = makeToolResult("x".repeat(20_000));
    expect(isOversizedToolResult(msg, 128_000, 24_000)).toBe(false);
  });

  it("returns false for non-toolResult messages", () => {
    const msg = makeUserMessage("x".repeat(500_000));
    expect(isOversizedToolResult(msg, 128_000)).toBe(false);
  });
});

describe("sessionLikelyHasOversizedToolResults", () => {
  it("returns true for individually oversized tool results", () => {
    const messages: AgentMessage[] = [makeToolResult("x".repeat(500_000))];
    expect(sessionLikelyHasOversizedToolResults({ messages, contextWindowTokens: 128_000 })).toBe(
      true,
    );
  });

  it("returns true for aggregate medium tool results that exceed the shared budget", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(600);
    const messages: AgentMessage[] = [
      makeToolResult(medium, "call_1"),
      makeToolResult(medium, "call_2"),
      makeToolResult(medium, "call_3"),
    ];
    expect(sessionLikelyHasOversizedToolResults({ messages, contextWindowTokens: 128_000 })).toBe(
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
    ];

    const estimate = estimateToolResultReductionPotential({
      messages,
      contextWindowTokens: 128_000,
    });

    expect(estimate.toolResultCount).toBe(3);
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
    });

    expect(estimate.oversizedCount).toBeGreaterThan(0);
    expect(estimate.oversizedReducibleChars).toBeGreaterThan(0);
    expect(estimate.aggregateReducibleChars).toBeGreaterThan(0);
    expect(estimate.maxReducibleChars).toBe(
      estimate.oversizedReducibleChars + estimate.aggregateReducibleChars,
    );
  });

  it("lets tiny caps drive aggregate recovery estimates without the old floor", () => {
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
});

describe("truncateOversizedToolResultsInSession", () => {
  it("readably truncates aggregate medium tool results in a session file", async () => {
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
    const result = await truncateOversizedToolResultsInSession({
      sessionFile,
      contextWindowTokens: 100,
    });
    openSpy.mockRestore();

    expect(result.truncated).toBe(true);
    expect(result.truncatedCount).toBeGreaterThan(0);

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

  it("prefers truncating newer aggregate tool-result entries before older larger ones", async () => {
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

    expect(afterTexts[0]).toBe(beforeTexts[0]);
    expect(afterTexts[1]).not.toBe(beforeTexts[1]);
    expect(afterTexts[1]).toContain("truncated");
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
