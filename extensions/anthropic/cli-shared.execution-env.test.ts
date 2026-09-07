import { describe, expect, it } from "vitest";
import { resolveClaudeCliAutoCompactEnv, resolveClaudeCliThinkingEnv } from "./cli-shared.js";

describe("Claude CLI execution environment", () => {
  it.each([
    ["high", { CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1", MAX_THINKING_TOKENS: "16384" }],
    ["off", { MAX_THINKING_TOKENS: "0" }],
    ["adaptive", undefined],
  ] as const)("maps %s thinking to Claude Code's process environment", (level, expected) => {
    expect(resolveClaudeCliThinkingEnv(level, "claude-opus-4-8")).toEqual(expected);
  });

  it.each(["off", "high", "max"] as const)(
    "leaves mandatory-adaptive Fable thinking %s to Claude Code effort args",
    (level) => {
      expect(resolveClaudeCliThinkingEnv(level, "claude-fable-5")).toBeUndefined();
    },
  );
});

describe("resolveClaudeCliAutoCompactEnv", () => {
  it("maps the effective OpenClaw context budget into Claude Code compaction", () => {
    expect(resolveClaudeCliAutoCompactEnv(100_000.9)).toEqual({
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000",
    });
  });

  it.each([undefined, 0, 0.5, Number.NaN])("rejects an invalid context budget: %s", (budget) => {
    expect(resolveClaudeCliAutoCompactEnv(budget)).toBeUndefined();
  });
});
