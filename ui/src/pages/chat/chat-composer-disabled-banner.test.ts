/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderChatComposer, resetChatComposerState } from "./components/chat-composer.ts";

type ComposerProps = Parameters<typeof renderChatComposer>[0];

function renderComposer(overrides: Partial<ComposerProps>) {
  const container = document.createElement("div");
  render(
    renderChatComposer({
      paneId: crypto.randomUUID(),
      sessionKey: "main",
      currentAgentId: "main",
      connected: true,
      canSend: true,
      disabledReason: null,
      sending: false,
      messages: [],
      stream: null,
      queue: [],
      draft: "",
      sessions: null,
      assistantName: "OpenClaw",
      onDraftChange: vi.fn(),
      onSend: vi.fn(),
      onQueueRemove: vi.fn(),
      onNewSession: vi.fn(),
      ...overrides,
    }),
    container,
  );
  return container;
}

afterEach(() => {
  resetChatComposerState();
  document.body.replaceChildren();
});

describe("archived session composer banner", () => {
  it("disables its action with the mutation reason", () => {
    const onAction = vi.fn();
    const reason = "Operator write access is required.";
    const container = renderComposer({
      canSend: false,
      disabledBanner: {
        kind: "composer-replacement",
        text: "This session is archived. Unarchive it to continue the conversation.",
        actionLabel: "Unarchive",
        disabledReason: reason,
        onAction,
      },
    });

    const action = container.querySelector<HTMLButtonElement>(
      ".agent-chat__disabled-banner button",
    );
    expect(action?.disabled).toBe(true);
    expect(action?.title).toBe(reason);
    action?.click();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("renders a standard primary action with progress feedback", () => {
    const container = renderComposer({
      canSend: false,
      disabledBanner: {
        kind: "composer-replacement",
        title: "This session ended during a restart.",
        text: "Its transcript is safe.",
        tone: "neutral",
        icon: "warning",
        actionLabel: "Resume in new session",
        actionStyle: "primary",
        busy: true,
        busyLabel: "Resuming…",
        onAction: vi.fn(),
      },
    });

    const action = container.querySelector<HTMLButtonElement>(
      ".agent-chat__disabled-banner button",
    );
    const banner = container.querySelector(".agent-chat__disabled-banner");
    expect(banner?.classList.contains("info")).toBe(false);
    expect(banner?.classList.contains("agent-chat__disabled-banner--neutral")).toBe(true);
    expect(banner?.querySelector(".agent-chat__disabled-banner-icon")).not.toBeNull();
    expect(banner?.querySelector(".agent-chat__disabled-banner-title")?.textContent).toContain(
      "This session ended during a restart.",
    );
    expect(banner?.querySelector(".agent-chat__disabled-banner-detail")?.textContent).toContain(
      "Its transcript is safe.",
    );
    expect(action?.classList.contains("primary")).toBe(true);
    expect(action?.disabled).toBe(true);
    expect(action?.getAttribute("aria-busy")).toBe("true");
    expect(action?.textContent).toContain("Resuming…");
    expect(action?.querySelector(".btn__spinner")).not.toBeNull();
  });
});
