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
  window.history.replaceState({}, "", "/?mockBoard=1");
});

describe("board session shell", () => {
  it("delegates the optional Workboard chip to its lazy element", () => {
    const linked = createContainer();
    const unlinked = createContainer();
    const provider = boardProviderForSession("agent:main:workboard-link");
    const client = {
      request: vi.fn(async () => ({ cards: [] })),
      addEventListener: vi.fn(() => () => {}),
    } as never;
    const props = {
      snapshot: provider.snapshot$.value,
      activeTabId: "main",
      dock: "right" as const,
      reopenDock: "right" as const,
      dockSize: { height: 300 },
      chat: html`<div>chat</div>`,
      divider: html`<div></div>`,
      canMutate: true,
      canGrant: true,
      callbacks: {
        applyOps: (ops: Parameters<typeof provider.applyOps>[0]) => provider.applyOps(ops),
        grant: (...args: Parameters<typeof provider.grant>) => provider.grant(...args),
        selectTab: () => {},
      },
      widgetFrameUrl: (name: string, revision: number) => provider.widgetFrameUrl(name, revision),
      onDockChange: () => {},
    };

    render(
      renderBoardSessionSurface({
        ...props,
        workboardCardChip: {
          basePath: "",
          client,
          sessionKey: "agent:main:workboard-link",
        },
      }),
      linked,
    );
    render(renderBoardSessionSurface(props), unlinked);

    const chip = linked.querySelector<HTMLElementTagNameMap["openclaw-workboard-card-chip"]>(
      "openclaw-workboard-card-chip",
    );
    expect(chip?.sessionKey).toBe("agent:main:workboard-link");
    expect(chip?.client).toBe(client);
    expect(unlinked.querySelector("openclaw-workboard-card-chip")).toBeNull();
  });

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

  it.each(["left", "right", "bottom"] as const)("lays out the %s dock", (dock) => {
    const container = createContainer();
    const provider = boardProviderForSession("agent:main:main");
    render(
      renderBoardSessionSurface({
        snapshot: provider.snapshot$.value,
        activeTabId: "main",
        dock,
        reopenDock: "right",
        dockSize: { height: 300 },
        chat: html`<div data-test-chat>chat</div>`,
        divider: html`<div class="board-session-surface__divider" data-test-divider></div>`,
        canMutate: true,
        canGrant: true,
        callbacks: {
          applyOps: (ops) => provider.applyOps(ops),
          grant: (name, decision) => provider.grant(name, decision),
          selectTab: () => {},
        },
        widgetFrameUrl: (name, revision) => provider.widgetFrameUrl(name, revision),
        onDockChange: () => {},
      }),
      container,
    );

    expect(container.querySelector(`.board-session-surface--dock-${dock}`)).not.toBeNull();
    expect(container.querySelector("[data-test-divider]") !== null).toBe(dock === "bottom");
    expect(container.querySelector("[data-test-chat]") !== null).toBe(dock === "bottom");
    expect(container.querySelector("openclaw-board-view")).not.toBeNull();
  });

  it("collapses hidden chat to a reopen affordance", () => {
    const container = createContainer();
    const provider = boardProviderForSession("agent:main:main");
    const onDockChange = vi.fn<(dock: BoardTab["chatDock"]) => void>();
    render(
      renderBoardSessionSurface({
        snapshot: provider.snapshot$.value,
        activeTabId: "main",
        dock: "hidden",
        reopenDock: "left",
        dockSize: { height: 300 },
        chat: html`<div data-test-chat>chat</div>`,
        divider: html`<div class="board-session-surface__divider"></div>`,
        canMutate: true,
        canGrant: true,
        callbacks: {
          applyOps: (ops) => provider.applyOps(ops),
          grant: (name, decision) => provider.grant(name, decision),
          selectTab: () => {},
        },
        widgetFrameUrl: (name, revision) => provider.widgetFrameUrl(name, revision),
        onDockChange,
      }),
      container,
    );

    expect(container.querySelector("[data-test-chat]")).toBeNull();
    expect(container.querySelector(".board-session-surface--dock-hidden")).not.toBeNull();
    const reopen = container.querySelector<HTMLButtonElement>(".board-session-surface__reopen");
    reopen?.click();
    expect(onDockChange).toHaveBeenCalledWith("left");
  });

  it("preserves the board while the bottom chat mounts only for that dock", () => {
    const container = createContainer();
    const provider = boardProviderForSession("agent:main:main");
    const props = {
      snapshot: provider.snapshot$.value,
      activeTabId: "main",
      reopenDock: "left" as const,
      dockSize: { height: 300 },
      chat: html`<div data-test-chat>chat</div>`,
      divider: html`<div class="board-session-surface__divider"></div>`,
      canMutate: true,
      canGrant: true,
      callbacks: {
        applyOps: (ops: Parameters<typeof provider.applyOps>[0]) => provider.applyOps(ops),
        grant: (...args: Parameters<typeof provider.grant>) => provider.grant(...args),
        selectTab: () => {},
      },
      widgetFrameUrl: (name: string, revision: number) => provider.widgetFrameUrl(name, revision),
      onDockChange: () => {},
    };

    render(renderBoardSessionSurface({ ...props, dock: "right" }), container);
    const board = container.querySelector("openclaw-board-view");
    expect(container.querySelector("[data-test-chat]")).toBeNull();

    render(renderBoardSessionSurface({ ...props, dock: "left" }), container);
    expect(container.querySelector("openclaw-board-view")).toBe(board);
    expect(container.querySelector("[data-test-chat]")).toBeNull();

    render(renderBoardSessionSurface({ ...props, dock: "bottom" }), container);
    expect(container.querySelector("openclaw-board-view")).toBe(board);
    expect(container.querySelector("[data-test-chat]")).not.toBeNull();

    render(renderBoardSessionSurface({ ...props, dock: "hidden" }), container);
    expect(container.querySelector("openclaw-board-view")).toBe(board);
    expect(container.querySelector("[data-test-chat]")).toBeNull();
  });
});
