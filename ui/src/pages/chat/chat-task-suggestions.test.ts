/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { TaskSuggestion } from "../../../../packages/gateway-protocol/src/index.js";
import {
  renderChatTaskSuggestionTray,
  type ChatTaskSuggestionTrayProps,
} from "./components/chat-task-suggestions.ts";

const suggestion: TaskSuggestion = {
  id: "task_123",
  title: "Remove stale adapter",
  prompt: "Delete the stale adapter and update tests.",
  tldr: "The adapter is unreachable and adds maintenance cost.",
  cwd: "/repo/project",
  sessionKey: "agent:main:main",
  agentId: "main",
  createdAt: 1,
};

function renderSuggestion(overrides: Partial<ChatTaskSuggestionTrayProps> = {}) {
  const container = document.createElement("div");
  const onAccept = vi.fn();
  const onDismiss = vi.fn();
  const onCopyPrompt = vi.fn();
  render(
    renderChatTaskSuggestionTray({
      taskSuggestions: [suggestion],
      taskSuggestionBusyIds: new Set(),
      canAcceptTaskSuggestions: true,
      canDismissTaskSuggestions: true,
      onAcceptTaskSuggestion: onAccept,
      onDismissTaskSuggestion: onDismiss,
      onCopyTaskSuggestionPrompt: onCopyPrompt,
      taskSuggestionCopiedIds: new Set<string>(),
      ...overrides,
    }),
    container,
  );
  return { container, onAccept, onDismiss, onCopyPrompt };
}

describe("chat task suggestions", () => {
  it("starts a new session without asking for an execution mode", () => {
    const { container, onAccept, onDismiss } = renderSuggestion();

    expect(container.querySelector(".task-suggestion__start")?.textContent).toContain(
      "Start in a new session",
    );
    expect(container.querySelector("wa-dropdown")).toBeNull();

    expect(container.querySelector(".task-suggestion__eyebrow")?.textContent).toContain(
      "Suggested task · in project",
    );
    expect(container.querySelector(".task-suggestion__eyebrow")?.getAttribute("title")).toBe(
      "/repo/project",
    );
    expect(container.querySelector(".task-suggestion__title")?.textContent).toContain(
      "Remove stale adapter",
    );
    expect(container.querySelector(".task-suggestion__summary")?.textContent).toContain(
      "The adapter is unreachable",
    );

    const details = container.querySelector<HTMLDetailsElement>(".task-suggestion__instructions");
    expect(details?.open).toBe(false);
    details?.querySelector("summary")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(details?.open).toBe(true);
    expect(details?.textContent).toContain("Delete the stale adapter and update tests.");

    container.querySelector<HTMLButtonElement>(".task-suggestion__start")?.click();
    container.querySelector<HTMLButtonElement>(".task-suggestion__dismiss")?.click();
    expect(onAccept).toHaveBeenCalledWith(suggestion);
    expect(onDismiss).toHaveBeenCalledWith(suggestion);
  });

  it("shows copied feedback while the suggestion id is marked copied", () => {
    const { container } = renderSuggestion({
      taskSuggestionCopiedIds: new Set([suggestion.id]),
    });
    const copy = container.querySelector(".task-suggestion__copy");
    expect(copy?.getAttribute("aria-label")).toBe("Copied");
  });

  it("keeps copy prompt available when acceptance and dismissal are unavailable", () => {
    const { container, onAccept, onCopyPrompt } = renderSuggestion({
      canAcceptTaskSuggestions: false,
      canDismissTaskSuggestions: false,
    });
    expect(container.querySelector(".task-suggestion__dismiss")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".task-suggestion__start")?.disabled).toBe(
      true,
    );
    const copy = container.querySelector<HTMLButtonElement>(".task-suggestion__copy");
    expect(copy?.disabled).toBe(false);
    copy?.click();
    expect(onCopyPrompt).toHaveBeenCalledWith(suggestion);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("allows dismissal while requiring admin access to start", () => {
    const { container } = renderSuggestion({
      canAcceptTaskSuggestions: false,
      canDismissTaskSuggestions: true,
    });

    const start = container.querySelector<HTMLButtonElement>(".task-suggestion__start");
    expect(start?.disabled).toBe(true);
    expect(start?.title).toBe("Administrator access is required to start suggested tasks.");
    expect(container.querySelector(".task-suggestion__dismiss")).not.toBeNull();
  });

  it("keeps reactive navigation active across rerenders and restarts repeated animations", () => {
    const secondSuggestion = { ...suggestion, id: "task_456", title: "Trim old fixtures" };
    const container = document.createElement("div");
    document.body.append(container);
    let activeId = suggestion.id;
    let direction: "next" | "previous" | undefined;
    let generation = 0;
    const draw = () =>
      render(
        renderChatTaskSuggestionTray({
          taskSuggestions: [suggestion, secondSuggestion],
          activeTaskSuggestionId: activeId,
          taskSuggestionSwapDirection: direction,
          taskSuggestionSwapGeneration: generation,
          onNavigateTaskSuggestion: (taskId, nextDirection) => {
            const current = taskId === suggestion.id ? 0 : 1;
            activeId = [suggestion, secondSuggestion][
              (current + (nextDirection === "next" ? 1 : -1) + 2) % 2
            ]!.id;
            direction = nextDirection;
            generation += 1;
            draw();
            container
              .querySelector<HTMLElement>(
                `.task-suggestion:not([hidden]) [data-task-${nextDirection === "next" ? "next" : "prev"}]`,
              )
              ?.focus();
          },
        }),
        container,
      );
    draw();

    let cards = [...container.querySelectorAll<HTMLElement>(".task-suggestion")];
    expect(cards.map((card) => card.hidden)).toEqual([false, true]);
    expect(cards[0]?.querySelector(".task-suggestion__position")?.textContent).toContain("1 / 2");

    cards[0]?.querySelector<HTMLButtonElement>("[data-task-next]")?.click();
    cards = [...container.querySelectorAll<HTMLElement>(".task-suggestion")];
    expect(cards.map((card) => card.hidden)).toEqual([true, false]);
    expect(cards[1]?.dataset.swapDirection).toBe("next");
    expect(document.activeElement).toBe(cards[1]?.querySelector("[data-task-next]"));

    // An unrelated Lit update must render the owner-selected card, not card zero.
    draw();
    cards = [...container.querySelectorAll<HTMLElement>(".task-suggestion")];
    expect(cards.map((card) => card.hidden)).toEqual([true, false]);

    cards[1]?.querySelector<HTMLButtonElement>("[data-task-next]")?.click();
    cards = [...container.querySelectorAll<HTMLElement>(".task-suggestion")];
    expect(cards.map((card) => card.hidden)).toEqual([false, true]);
    expect(cards[0]?.dataset.swapDirection).toBe("next");
    const firstVisit = cards[0];

    cards[0]?.querySelector<HTMLButtonElement>("[data-task-next]")?.click();
    cards = [...container.querySelectorAll<HTMLElement>(".task-suggestion")];
    cards[1]?.querySelector<HTMLButtonElement>("[data-task-next]")?.click();
    cards = [...container.querySelectorAll<HTMLElement>(".task-suggestion")];
    expect(cards[0]).not.toBe(firstVisit);
    expect(cards[0]?.dataset.swapDirection).toBe("next");

    cards[0]?.querySelector<HTMLButtonElement>("[data-task-prev]")?.click();
    cards = [...container.querySelectorAll<HTMLElement>(".task-suggestion")];
    expect(document.activeElement).toBe(cards[1]?.querySelector("[data-task-prev]"));
    container.remove();
  });

  it("dismisses the currently active task", () => {
    const secondSuggestion = { ...suggestion, id: "task_456", title: "Trim old fixtures" };
    const { container, onDismiss } = renderSuggestion({
      taskSuggestions: [suggestion, secondSuggestion],
      activeTaskSuggestionId: secondSuggestion.id,
    });

    const active = container.querySelector<HTMLElement>(".task-suggestion:not([hidden])");
    active?.querySelector<HTMLButtonElement>(".task-suggestion__dismiss")?.click();
    expect(onDismiss).toHaveBeenCalledWith(secondSuggestion);
  });

  it("strips bidi controls from every displayed field", () => {
    const { container } = renderSuggestion({
      taskSuggestions: [
        {
          ...suggestion,
          title: "safe\u202eevil",
          tldr: "why\u200f now",
          cwd: "/repo/\u2066project",
          prompt: "run\u202d exactly",
        },
      ],
    });

    expect(container.textContent).toContain("safeevil");
    expect(container.textContent).toContain("why now");
    expect(container.textContent).toContain("/repo/project");
    expect(container.textContent).toContain("run exactly");
    expect(container.textContent).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    expect(container.querySelector(".task-suggestion__eyebrow")?.getAttribute("title")).toBe(
      "/repo/project",
    );
  });
});
