import { describe, expect, it } from "vitest";
import { resolveClaudeCliThinkingEnv } from "./cli-shared.js";

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
