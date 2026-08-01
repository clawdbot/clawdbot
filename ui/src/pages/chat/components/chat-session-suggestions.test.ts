/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSuggestion } from "../../../../../packages/gateway-protocol/src/index.js";
import { renderChatSessionSuggestions } from "./chat-session-suggestions.ts";

const suggestion: SessionSuggestion = {
  id: "suggestion-1",
  sessionKey: "agent:main:main",
  agentId: "main",
  author: { type: "human", id: "alice", label: "Alice" },
  text: "Try the focused change",
  createdAt: 1,
  state: "pending",
};

let container: HTMLDivElement | undefined;

afterEach(() => {
  container?.remove();
  container = undefined;
});

function mount(role: "owner" | "viewer", row = suggestion, canResolve = true, archived = false) {
  const onResolve = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  render(
    renderChatSessionSuggestions({
      suggestions: [row],
      role,
      busyIds: new Set(),
      archived,
      canResolve,
      onResolve,
    }),
    container,
  );
  return { container, onResolve };
}

describe("chat session suggestions", () => {
  it("renders the four owner actions in send, queue, edit, dismiss order", () => {
    const view = mount("owner");
    const buttons = [...view.container.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Send Alice's suggestion now",
      "Queue Alice's suggestion",
      "Edit Alice's suggestion",
      "Dismiss Alice's suggestion",
    ]);
    buttons.forEach((button) => button.click());
    expect(view.onResolve.mock.calls.map((call) => call[1])).toEqual([
      "send",
      "queue",
      "edit",
      "dismiss",
    ]);
  });

  it("shows the author's resolved state without participant actions", () => {
    const view = mount("viewer", { ...suggestion, state: "accepted" });
    expect(view.container.querySelector("button")).toBeNull();
    expect(view.container.textContent).toContain("Accepted");
    expect(view.container.textContent).toContain("Try the focused change");
  });

  it("does not expose participant actions before the role is known", () => {
    const onResolve = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    render(
      renderChatSessionSuggestions({
        suggestions: [suggestion],
        role: undefined,
        busyIds: new Set(),
        archived: false,
        canResolve: true,
        onResolve,
      }),
      container,
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("Pending");
  });

  it("does not expose resolution actions to members", () => {
    const onResolve = vi.fn();
    container = document.createElement("div");
    document.body.append(container);
    render(
      renderChatSessionSuggestions({
        suggestions: [suggestion],
        role: "member",
        busyIds: new Set(),
        archived: false,
        canResolve: true,
        onResolve,
      }),
      container,
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("Pending");
  });

  it("hides owner actions when the resolve method is unavailable", () => {
    const view = mount("owner", suggestion, false);
    expect(view.container.querySelector("button")).toBeNull();
    expect(view.container.textContent).toContain("Pending");
  });

  it("keeps only dismiss available for an archived session", () => {
    const view = mount("owner", suggestion, true, true);
    const buttons = [...view.container.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Dismiss Alice's suggestion",
    ]);
    buttons[0]?.click();
    expect(view.onResolve).toHaveBeenCalledWith(suggestion, "dismiss");
  });
});
