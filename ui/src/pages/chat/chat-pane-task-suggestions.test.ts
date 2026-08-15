/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type {
  TaskSuggestion,
  TaskSuggestionsAcceptResult,
  TaskSuggestionsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

const suggestion: TaskSuggestion = {
  id: "task_123",
  title: "Remove stale adapter",
  prompt: "Delete the stale adapter and update tests.",
  tldr: "The adapter is unreachable and adds maintenance cost.",
  cwd: "/repo",
  sessionKey: "agent:main:current",
  agentId: "main",
  createdAt: 1,
};

describe("chat pane task suggestion lifecycle", () => {
  it("surfaces clipboard failure through the pane error path", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const execCommand = vi.fn(() => false);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: {} as SessionCapability,
    });

    try {
      await pane.copyTaskSuggestionPrompt(suggestion);
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
      if (originalExecCommand) {
        Object.defineProperty(document, "execCommand", originalExecCommand);
      } else {
        Reflect.deleteProperty(document, "execCommand");
      }
    }

    expect(writeText).toHaveBeenCalledWith(suggestion.prompt);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(state.lastError).toBe("Couldn't copy the prompt to the clipboard");
    expect(state.chatError).toBe("Couldn't copy the prompt to the clipboard");
  });

  it("keeps accept ownership when the resolved event arrives before the response", async () => {
    const accepted = createDeferred<TaskSuggestionsAcceptResult>();
    const client = {
      request: vi.fn((method: string) =>
        method === "taskSuggestions.accept"
          ? accepted.promise
          : Promise.resolve({ suggestions: [] } satisfies TaskSuggestionsListResult),
      ),
    } as unknown as GatewayBrowserClient;
    const sessions = {} as SessionCapability;
    const { pane } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;

    const pending = pane.acceptTaskSuggestion(suggestion, "worktree");
    pane.handleTaskSuggestionEvent({
      action: "resolved",
      taskId: suggestion.id,
      resolution: "accepted",
    });
    accepted.resolve({ taskId: suggestion.id, key: "agent:main:task" });

    await pending;
    expect(navigate).toHaveBeenCalledWith("single", "agent:main:task");
  });

  it("drops an accept response after a same-client reconnect", async () => {
    const accepted = createDeferred<TaskSuggestionsAcceptResult>();
    const client = {
      request: vi.fn(() => accepted.promise),
    } as unknown as GatewayBrowserClient;
    const sessions = {} as SessionCapability;
    const { pane } = createTestChatPane({ client, sessions });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;

    const pending = pane.acceptTaskSuggestion(suggestion, "worktree");
    pane.connectionGeneration += 1;
    accepted.resolve({ taskId: suggestion.id, key: "agent:main:stale" });

    await pending;
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps session-mode acceptance in the source pane", async () => {
    const request = vi.fn().mockResolvedValue({ taskId: suggestion.id, key: "agent:main:task" });
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane } = createTestChatPane({ client, sessions: {} as SessionCapability });
    const navigate = vi.fn();
    pane.onPaneSessionChange = navigate;

    await pane.acceptTaskSuggestion(suggestion, "session");

    expect(request).toHaveBeenCalledWith("taskSuggestions.accept", {
      taskId: suggestion.id,
      mode: "session",
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("drops a list response after a same-client reconnect", async () => {
    const listed = createDeferred<TaskSuggestionsListResult>();
    const client = {
      request: vi.fn(() => listed.promise),
    } as unknown as GatewayBrowserClient;
    const sessions = {} as SessionCapability;
    const { pane } = createTestChatPane({ client, sessions });

    const pending = pane.refreshTaskSuggestions();
    pane.connectionGeneration += 1;
    listed.resolve({ suggestions: [suggestion] });

    await pending;
    expect(pane.taskSuggestions).toEqual([]);
  });
});
