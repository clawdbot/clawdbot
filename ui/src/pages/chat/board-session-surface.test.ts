/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boardProviderForSession } from "../../lib/board/provider.ts";
import type { BoardTab } from "../../lib/board/types.ts";
import { renderBoardFaceToggle, renderBoardSessionSurface } from "./board-session-surface.ts";

const containers: HTMLElement[] = [];

function createContainer() {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  return container;
}

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

beforeEach(() => {
  const marker = document.createElement("script");
  marker.dataset.openclawControlUiMockGateway = "";
  document.head.append(marker);
  containers.push(marker);
});

describe("board session shell", () => {
  it("shows the face toggle only when a board exists", () => {
    const withoutBoard = createContainer();
    const withBoard = createContainer();

    render(
      renderBoardFaceToggle(false, "chat", () => {}),
      withoutBoard,
    );
    render(
      renderBoardFaceToggle(true, "chat", () => {}),
      withBoard,
    );

    expect(withoutBoard.querySelector("wa-radio-group")).toBeNull();
    expect(withBoard.querySelectorAll("wa-radio")).toHaveLength(2);
  });

  it("supports keyboard face selection", () => {
    const container = createContainer();
    const onChange = vi.fn();
    render(renderBoardFaceToggle(true, "chat", onChange), container);

    const group = container.querySelector<HTMLElement & { value: string }>("wa-radio-group");
    if (group) {
      group.value = "dashboard";
      group.dispatchEvent(new Event("change", { bubbles: true }));
    }

    expect(onChange).toHaveBeenCalledWith("dashboard");
  });

  it.each(["left", "right", "bottom"] as const)("lays chat out on the %s edge", (dock) => {
    const container = createContainer();
    const provider = boardProviderForSession("agent:main:main");
    render(
      renderBoardSessionSurface({
        snapshot: provider.snapshot$.value,
        sessions: [],
        activeTabId: "main",
        dock,
        reopenDock: "right",
        dockSize: { height: 300, width: 420 },
        chat: html`<div data-test-chat>chat</div>`,
        divider: html`<div class="board-session-surface__divider" data-test-divider></div>`,
        callbacks: {
          applyOps: (ops) => provider.applyOps(ops),
          grant: (name, decision) => provider.grant(name, decision),
          selectTab: () => {},
        },
        onDockChange: () => {},
      }),
      container,
    );

    expect(container.querySelector(`.board-session-surface--dock-${dock}`)).not.toBeNull();
    expect(container.querySelector("[data-test-divider]")).not.toBeNull();
    expect(container.querySelector("[data-test-chat]")).not.toBeNull();
    expect(container.querySelector("openclaw-board-view")).not.toBeNull();
  });

  it("collapses hidden chat to a reopen affordance", () => {
    const container = createContainer();
    const provider = boardProviderForSession("agent:main:main");
    const onDockChange = vi.fn<(dock: BoardTab["chatDock"]) => void>();
    render(
      renderBoardSessionSurface({
        snapshot: provider.snapshot$.value,
        sessions: [],
        activeTabId: "main",
        dock: "hidden",
        reopenDock: "left",
        dockSize: { height: 300, width: 420 },
        chat: html`<div data-test-chat>chat</div>`,
        divider: html`<div class="board-session-surface__divider"></div>`,
        callbacks: {
          applyOps: (ops) => provider.applyOps(ops),
          grant: (name, decision) => provider.grant(name, decision),
          selectTab: () => {},
        },
        onDockChange,
      }),
      container,
    );

    expect(container.querySelector("[data-test-chat]")).not.toBeNull();
    expect(container.querySelector(".board-session-surface--dock-hidden")).not.toBeNull();
    const reopen = container.querySelector<HTMLButtonElement>(".board-session-surface__reopen");
    reopen?.click();
    expect(onDockChange).toHaveBeenCalledWith("left");
  });

  it("preserves board and chat nodes while changing dock state", () => {
    const container = createContainer();
    const provider = boardProviderForSession("agent:main:main");
    const props = {
      snapshot: provider.snapshot$.value,
      sessions: [],
      activeTabId: "main",
      reopenDock: "left" as const,
      dockSize: { height: 300, width: 420 },
      chat: html`<div data-test-chat>chat</div>`,
      divider: html`<div class="board-session-surface__divider"></div>`,
      callbacks: {
        applyOps: (ops: Parameters<typeof provider.applyOps>[0]) => provider.applyOps(ops),
        grant: (...args: Parameters<typeof provider.grant>) => provider.grant(...args),
        selectTab: () => {},
      },
      onDockChange: () => {},
    };

    render(renderBoardSessionSurface({ ...props, dock: "right" }), container);
    const board = container.querySelector("openclaw-board-view");
    const chat = container.querySelector("[data-test-chat]");

    render(renderBoardSessionSurface({ ...props, dock: "left" }), container);
    expect(container.querySelector("openclaw-board-view")).toBe(board);
    expect(container.querySelector("[data-test-chat]")).toBe(chat);

    render(renderBoardSessionSurface({ ...props, dock: "bottom" }), container);
    expect(container.querySelector("openclaw-board-view")).toBe(board);
    expect(container.querySelector("[data-test-chat]")).toBe(chat);

    render(renderBoardSessionSurface({ ...props, dock: "hidden" }), container);
    expect(container.querySelector("openclaw-board-view")).toBe(board);
    expect(container.querySelector("[data-test-chat]")).toBe(chat);
  });
});
