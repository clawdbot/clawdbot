import { describe, expect, it } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";

describe("Claude CLI context-window selection", () => {
  it("maps selectable windows to native model ids and process env", () => {
    const backend = buildAnthropicCliBackend();
    const resolveModelId = backend.resolveModelId;
    const prepareExecution = backend.prepareExecution;

    // Omitted selection must stay on the bare id: the CLI already defaults
    // Claude 5 to 1M, and suffixed argv would regress CLIs without [1m] support.
    expect(resolveModelId?.({ modelId: "claude-fable-5" })).toBe("claude-fable-5");
    expect(resolveModelId?.({ modelId: "claude-fable-5", contextWindow: "200k" })).toBe(
      "claude-fable-5",
    );
    expect(
      prepareExecution?.({
        workspaceDir: "/tmp/openclaw-claude-cli",
        provider: "claude-cli",
        modelId: "claude-fable-5",
        contextWindow: "200k",
        contextTokenBudget: 200_000,
      }),
    ).toEqual({
      env: {
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000",
        CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
      },
    });
    expect(resolveModelId?.({ modelId: "claude-fable-5", contextWindow: "1m" })).toBe(
      "claude-fable-5[1m]",
    );
    expect(
      prepareExecution?.({
        workspaceDir: "/tmp/openclaw-claude-cli",
        provider: "claude-cli",
        modelId: "claude-fable-5",
        contextWindow: "1m",
        contextTokenBudget: 1_000_000,
      }),
    ).toEqual({ env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000" } });
    expect(backend.config.clearEnv).toContain("CLAUDE_CODE_DISABLE_1M_CONTEXT");
    expect(resolveModelId?.({ modelId: "claude-opus-4-8" })).toBe("claude-opus-4-8");
  });
});
