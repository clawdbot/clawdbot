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
      canAcceptTaskSuggestionModes: true,
      canDismissTaskSuggestions: true,
      taskSuggestionCloudProfiles: [],
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

function selectMenuItem(container: HTMLElement, item: Element) {
  container.querySelector("wa-dropdown")?.dispatchEvent(
    new CustomEvent("wa-select", {
      bubbles: true,
      composed: true,
      detail: { item },
    }),
  );
}

describe("chat task suggestions", () => {
  it("renders a compact card with collapsed instructions and worktree primary action", () => {
    const { container, onAccept, onDismiss } = renderSuggestion();

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
    expect(onAccept).toHaveBeenCalledWith(suggestion, "worktree", undefined);
    expect(onDismiss).toHaveBeenCalledWith(suggestion);
  });

  it("forwards local, session, and per-profile cloud menu actions", () => {
    const { container, onAccept } = renderSuggestion({
      taskSuggestionCloudProfiles: [{ id: "build" }, { id: "review" }],
    });
    const local = container.querySelector('wa-dropdown-item[value="local"]');
    const session = container.querySelector('wa-dropdown-item[value="session"]');
    const cloud = [...container.querySelectorAll('wa-dropdown-item[value="cloud"]')];

    expect(cloud.map((item) => item.textContent?.trim())).toEqual([
      "Send to cloud · build",
      "Send to cloud · review",
    ]);
    expect(local).not.toBeNull();
    expect(session).not.toBeNull();
    selectMenuItem(container, local!);
    selectMenuItem(container, session!);
    selectMenuItem(container, cloud[0]!);
    selectMenuItem(container, cloud[1]!);

    expect(onAccept.mock.calls).toEqual([
      [suggestion, "local", undefined],
      [suggestion, "session", undefined],
      [suggestion, "cloud", "build"],
      [suggestion, "cloud", "review"],
    ]);
  });

  it("forwards copy-prompt without accepting, even without acceptance access", () => {
    const { container, onAccept, onCopyPrompt } = renderSuggestion({
      canAcceptTaskSuggestions: false,
      canAcceptTaskSuggestionModes: false,
    });
    const trigger = container.querySelector(".task-suggestion__menu-trigger");
    expect(trigger?.hasAttribute("disabled")).toBe(false);
    expect(container.querySelector('wa-dropdown-item[value="local"]')).toBeNull();
    const copy = container.querySelector('wa-dropdown-item[value="copy-prompt"]');
    expect(copy).not.toBeNull();
    selectMenuItem(container, copy!);
    expect(onCopyPrompt).toHaveBeenCalledWith(suggestion);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("shows copied feedback while the suggestion id is marked copied", () => {
    const { container } = renderSuggestion({
      taskSuggestionCopiedIds: new Set([suggestion.id]),
    });
    const copy = container.querySelector('wa-dropdown-item[value="copy-prompt"]');
    expect(copy?.textContent?.trim()).toBe("Copied");
  });

  it("offers no acceptance-mode actions when modes are not advertised", () => {
    const { container, onAccept } = renderSuggestion({
      canAcceptTaskSuggestionModes: false,
    });

    expect(container.querySelector(".task-suggestion__start")).not.toBeNull();
    // The menu itself stays: it carries the client-local Copy prompt action.
    expect(container.querySelector('wa-dropdown-item[value="local"]')).toBeNull();
    expect(container.querySelector('wa-dropdown-item[value="cloud"]')).toBeNull();
    expect(container.querySelector('wa-dropdown-item[value="session"]')).toBeNull();
    expect(container.querySelector('wa-dropdown-item[value="copy-prompt"]')).not.toBeNull();

    container.querySelector<HTMLButtonElement>(".task-suggestion__start")?.click();
    expect(onAccept).toHaveBeenCalledWith(suggestion, "worktree", undefined);
  });

  it("uses a generic single-cloud label and a disabled hint when none are configured", () => {
    const single = renderSuggestion({
      taskSuggestionCloudProfiles: [{ id: "build" }],
    }).container;
    expect(single.querySelector('wa-dropdown-item[value="cloud"]')?.textContent?.trim()).toBe(
      "Send to cloud",
    );

    const none = renderSuggestion().container;
    const item = none.querySelector('wa-dropdown-item[value="cloud"]');
    expect(item?.hasAttribute("disabled")).toBe(true);
    expect(item?.getAttribute("title")).toBe("No cloud environment configured");
  });

  it("keeps copy prompt available when acceptance and dismissal are unavailable", () => {
    const { container, onCopyPrompt } = renderSuggestion({
      canAcceptTaskSuggestions: false,
      canDismissTaskSuggestions: false,
    });
    expect(container.querySelector(".task-suggestion__dismiss")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".task-suggestion__start")?.disabled).toBe(
      true,
    );
    const copy = container.querySelector('wa-dropdown-item[value="copy-prompt"]');
    expect(copy).not.toBeNull();
    selectMenuItem(container, copy!);
    expect(onCopyPrompt).toHaveBeenCalledWith(suggestion);
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

  it("shows one suggestion at a time and preserves dismissal for the active task", () => {
    const secondSuggestion = { ...suggestion, id: "task_456", title: "Trim old fixtures" };
    const { container, onDismiss } = renderSuggestion({
      taskSuggestions: [suggestion, secondSuggestion],
    });

    const cards = [...container.querySelectorAll<HTMLElement>(".task-suggestion")];
    expect(cards.map((card) => card.hidden)).toEqual([false, true]);
    expect(cards[0]?.querySelector(".task-suggestion__position")?.textContent).toContain("1 / 2");

    cards[0]?.querySelector<HTMLButtonElement>("[data-task-next]")?.click();
    expect(cards.map((card) => card.hidden)).toEqual([true, false]);
    expect(cards[1]?.dataset.swapDirection).toBe("next");
    cards[1]?.querySelector<HTMLButtonElement>(".task-suggestion__dismiss")?.click();
    expect(onDismiss).toHaveBeenCalledWith(secondSuggestion);

    cards[1]?.querySelector<HTMLButtonElement>("[data-task-prev]")?.click();
    expect(cards.map((card) => card.hidden)).toEqual([false, true]);
    expect(cards[0]?.dataset.swapDirection).toBe("previous");
  });

  it("strips bidi controls from every displayed field", () => {
    const rawProfileId = "build\u202eprofile";
    const { container, onAccept } = renderSuggestion({
      taskSuggestions: [
        {
          ...suggestion,
          title: "safe\u202eevil",
          tldr: "why\u200f now",
          cwd: "/repo/\u2066project",
          prompt: "run\u202d exactly",
        },
      ],
      taskSuggestionCloudProfiles: [{ id: rawProfileId }, { id: "review" }],
    });

    expect(container.textContent).toContain("safeevil");
    expect(container.textContent).toContain("why now");
    expect(container.textContent).toContain("/repo/project");
    expect(container.textContent).toContain("run exactly");
    expect(container.textContent).toContain("buildprofile");
    expect(container.textContent).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    expect(container.querySelector(".task-suggestion__eyebrow")?.getAttribute("title")).toBe(
      "/repo/project",
    );

    const cloud = container.querySelector("wa-dropdown-item[data-cloud-profile]");
    expect(cloud).not.toBeNull();
    selectMenuItem(container, cloud!);
    expect(onAccept).toHaveBeenCalledWith(expect.anything(), "cloud", rawProfileId);
  });
});
