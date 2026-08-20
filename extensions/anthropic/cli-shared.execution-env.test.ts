import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { resolveClaudeCliThinkingEnv } from "./cli-shared.js";

describe("Claude CLI execution environment", () => {
  it("preserves the prepared launch environment for the same context budget", () => {
    const backend = buildAnthropicCliBackend();

    expect(
      backend.prepareExecution?.({
        workspaceDir: "/tmp/openclaw-claude-cli",
        provider: "claude-cli",
        modelId: "claude-opus-4-8",
        contextTokenBudget: 100_000,
      }),
    ).toEqual({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000" } });
  });

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
