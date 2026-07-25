/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { TaskSuggestion } from "../../../../packages/gateway-protocol/src/index.js";
import { renderChatTaskSuggestions } from "./components/chat-task-suggestions.ts";

const suggestion: TaskSuggestion = {
  id: "task_123",
  title: "Remove stale adapter",
  prompt: "Delete the stale adapter and update tests.",
  tldr: "The adapter is unreachable and adds maintenance cost.",
  cwd: "/repo",
  sessionKey: "agent:main:main",
  agentId: "main",
  createdAt: 1,
};

describe("chat task suggestions", () => {
  it("renders an actionable chip", () => {
    const container = document.createElement("div");
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    render(
      renderChatTaskSuggestions({
        suggestions: [suggestion],
        busyIds: new Set(),
        canAccept: true,
        canDismiss: true,
        onAccept,
        onDismiss,
      }),
      container,
    );

    expect(container.textContent).toContain("Remove stale adapter");
    expect(container.textContent).toContain("The adapter is unreachable");
    expect(container.textContent).toContain("/repo");
    expect(container.textContent).toContain("Delete the stale adapter and update tests.");
    container.querySelector<HTMLButtonElement>(".task-suggestion__start")?.click();
    container.querySelector<HTMLButtonElement>(".task-suggestion__dismiss")?.click();
    expect(onAccept).toHaveBeenCalledWith(suggestion);
    expect(onDismiss).toHaveBeenCalledWith(suggestion);
  });

  it("hides dismissal without write access and requires admin access to start", () => {
    const container = document.createElement("div");
    render(
      renderChatTaskSuggestions({
        suggestions: [suggestion],
        busyIds: new Set(),
        canAccept: false,
        canDismiss: false,
        onAccept: vi.fn(),
        onDismiss: vi.fn(),
      }),
      container,
    );

    expect(container.querySelector<HTMLButtonElement>(".task-suggestion__start")?.disabled).toBe(
      true,
    );
    expect(container.querySelector(".task-suggestion__dismiss")).toBeNull();
  });
});
