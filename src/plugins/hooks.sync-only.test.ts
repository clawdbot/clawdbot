import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { createHookRunner, type HookRunnerLogger } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-helpers.js";

function createToolResultMessage(text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    content: [{ type: "text", text }],
    isError: false,
  } as AgentMessage;
}

function createLogger(): HookRunnerLogger & {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn<(message: string) => void>();
  const error = vi.fn<(message: string) => void>();
  return {
    warn,
    error,
  };
}

describe("sync-only plugin hooks", () => {
  it("warns and ignores accidental async tool_result_persist handlers", () => {
    const logger = createLogger();
    const originalMessage = createToolResultMessage("original");
    const replacementMessage = createToolResultMessage("replacement");
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "tool_result_persist",
          pluginId: "async-tool-result",
          handler: async () => ({ message: replacementMessage }),
        },
      ]),
      { logger },
    );

    const result = runner.runToolResultPersist(
      { message: originalMessage },
      { agentId: "agent-1", sessionKey: "session-1" },
    );

    expect(result).toEqual({ message: originalMessage });
    expect(logger.warn.mock.calls).toEqual([
      [
        "[hooks] tool_result_persist handler from async-tool-result returned a Promise; this hook is synchronous and the result was ignored.",
      ],
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("warns and ignores accidental async before_message_write handlers", () => {
    const logger = createLogger();
    const originalMessage = createToolResultMessage("original");
    const runner = createHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          pluginId: "async-before-write",
          handler: async () => ({ block: true }),
        },
      ]),
      { logger },
    );

    const result = runner.runBeforeMessageWrite(
      { message: originalMessage, sessionKey: "session-1", agentId: "agent-1" },
      { agentId: "agent-1", sessionKey: "session-1" },
    );

    expect(result).toBeUndefined();
    expect(logger.warn.mock.calls).toEqual([
      [
        "[hooks] before_message_write handler from async-before-write returned a Promise; this hook is synchronous and the result was ignored.",
      ],
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
