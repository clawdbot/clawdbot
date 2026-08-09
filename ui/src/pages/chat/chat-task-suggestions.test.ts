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

  it("renders nothing when no task actions are permitted", () => {
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

    expect(container.querySelector(".task-suggestions")).toBeNull();
  });

  it("allows dismissal while requiring admin access to start", () => {
    const container = document.createElement("div");
    render(
      renderChatTaskSuggestions({
        suggestions: [suggestion],
        busyIds: new Set(),
        canAccept: false,
        canDismiss: true,
        onAccept: vi.fn(),
        onDismiss: vi.fn(),
      }),
      container,
    );

    const start = container.querySelector<HTMLButtonElement>(".task-suggestion__start");
    expect(start?.disabled).toBe(true);
    expect(start?.title).toBe(
      "Administrator access is required to create a worktree from this project.",
    );
    expect(container.querySelector(".task-suggestion__dismiss")).not.toBeNull();
  });

  it("strips bidi controls from every displayed field", () => {
    const container = document.createElement("div");
    render(
      renderChatTaskSuggestions({
        suggestions: [
          {
            ...suggestion,
            title: "safe\u202eevil",
            tldr: "why\u200f now",
            cwd: "/repo/\u2066project",
            prompt: "run\u202d exactly",
          },
        ],
        busyIds: new Set(),
        canAccept: true,
        canDismiss: true,
        onAccept: vi.fn(),
        onDismiss: vi.fn(),
      }),
      container,
    );

    expect(container.textContent).toContain("safeevil");
    expect(container.textContent).toContain("why now");
    expect(container.textContent).toContain("/repo/project");
    expect(container.textContent).toContain("run exactly");
    expect(container.textContent).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
  });
});
