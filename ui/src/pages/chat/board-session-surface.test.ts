/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boardProviderForSession } from "../../lib/board/provider.ts";
import { installBrowserHistoryIsolation } from "../../test-helpers/browser-history.ts";
import { renderBoardSessionSurface, renderBoardViewSwitch } from "./board-session-surface.ts";

const containers: HTMLElement[] = [];

installBrowserHistoryIsolation();

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
    const provider = boardProviderForSession({ sessionKey: "agent:main:workboard-link" });
    const client = {
      request: vi.fn(async () => ({ cards: [] })),
      addEventListener: vi.fn(() => () => {}),
    } as never;
    const props = {
      active: true,
      snapshot: provider.snapshot$.value,
      activeTabId: "main",
      dock: "right" as const,
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
    };

    render(
      renderBoardSessionSurface({
        ...props,
        workboardCardChip: {
          active: true,
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
    expect(chip?.active).toBe(true);
    expect(unlinked.querySelector("openclaw-workboard-card-chip")).toBeNull();
  });

  it("renders nothing without a board", () => {
    const container = createContainer();
    render(
      renderBoardViewSwitch({
        hasBoard: false,
        face: "chat",
        dock: "right",
        canChangeDock: true,
        onSelectMode: () => {},
        onDockSideChange: () => {},
      }),
      container,
    );

    expect(container.querySelector(".chat-pane__face-switch")).toBeNull();
    expect(container.querySelector("wa-radio-group")).toBeNull();
    expect(container.querySelector("wa-dropdown")).toBeNull();
  });

  it.each([
    ["chat", "left", "chat"],
    ["chat", "right", "chat"],
    ["chat", "bottom", "chat"],
    ["chat", "hidden", "chat"],
    ["dashboard", "left", "split"],
    ["dashboard", "right", "split"],
    ["dashboard", "bottom", "split"],
    ["dashboard", "hidden", "dashboard"],
  ] as const)("maps %s with a %s dock to the %s mode", (face, dock, activeMode) => {
    const container = createContainer();
    render(
      renderBoardViewSwitch({
        hasBoard: true,
        face,
        dock,
        canChangeDock: true,
        onSelectMode: () => {},
        onDockSideChange: () => {},
      }),
      container,
    );

    expect(
      [...container.querySelectorAll("wa-radio")].map((radio) => radio.getAttribute("value")),
    ).toEqual(["chat", "split", "dashboard"]);
    expect(
      container.querySelector("wa-radio.settings-segmented__btn--active")?.getAttribute("value"),
    ).toBe(activeMode);
  });

  it("falls back to the two face options when dock changes are unavailable", () => {
    const container = createContainer();
    render(
      renderBoardViewSwitch({
        hasBoard: true,
        face: "dashboard",
        dock: "right",
        canChangeDock: false,
        onSelectMode: () => {},
        onDockSideChange: () => {},
      }),
      container,
    );

    expect(
      [...container.querySelectorAll("wa-radio")].map((radio) => radio.getAttribute("value")),
    ).toEqual(["chat", "dashboard"]);
    expect(
      container.querySelector("wa-radio.settings-segmented__btn--active")?.getAttribute("value"),
    ).toBe("dashboard");
    expect(container.querySelector("wa-dropdown")).toBeNull();
  });

  it.each([
    ["chat", "right", true, false],
    ["dashboard", "right", true, true],
    ["dashboard", "hidden", true, false],
    ["dashboard", "right", false, false],
  ] as const)(
    "shows the dock caret for face=%s dock=%s canChangeDock=%s: %s",
    (face, dock, canChangeDock, hasCaret) => {
      const container = createContainer();
      const onDockSideChange = vi.fn();
      render(
        renderBoardViewSwitch({
          hasBoard: true,
          face,
          dock,
          canChangeDock,
          onSelectMode: () => {},
          onDockSideChange,
        }),
        container,
      );

      const dropdown = container.querySelector("wa-dropdown.chat-pane__dock-caret");
      expect(dropdown !== null).toBe(hasCaret);
      if (!dropdown) {
        return;
      }
      const items = [...dropdown.querySelectorAll("wa-dropdown-item")];
      expect(items.map((item) => item.getAttribute("value"))).toEqual(["left", "right", "bottom"]);
      expect(items.find((item) => item.hasAttribute("checked"))?.getAttribute("value")).toBe(
        "right",
      );
      const left = dropdown.querySelector('wa-dropdown-item[value="left"]');
      Reflect.set(left ?? {}, "value", "left");
      dropdown.dispatchEvent(
        new CustomEvent("wa-select", { bubbles: true, detail: { item: left } }),
      );
      expect(onDockSideChange).toHaveBeenCalledWith("left");
    },
  );

  it("emits the selected view mode", () => {
    const container = createContainer();
    const onSelectMode = vi.fn();
    render(
      renderBoardViewSwitch({
        hasBoard: true,
        face: "chat",
        dock: "right",
        canChangeDock: true,
        onSelectMode,
        onDockSideChange: () => {},
      }),
      container,
    );

    const group = container.querySelector<HTMLElement & { value: string }>("wa-radio-group");
    if (group) {
      group.value = "split";
      group.dispatchEvent(new Event("change", { bubbles: true }));
    }

    expect(onSelectMode).toHaveBeenCalledWith("split");
  });

  it.each(["left", "right", "bottom"] as const)("lays out the %s dock", (dock) => {
    const container = createContainer();
    const provider = boardProviderForSession({ sessionKey: "agent:main:main" });
    render(
      renderBoardSessionSurface({
        active: true,
        snapshot: provider.snapshot$.value,
        activeTabId: "main",
        dock,
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
      }),
      container,
    );

    expect(container.querySelector(`.board-session-surface--dock-${dock}`)).not.toBeNull();
    expect(container.querySelector("[data-test-divider]") !== null).toBe(dock === "bottom");
    expect(container.querySelector("[data-test-chat]") !== null).toBe(dock === "bottom");
    expect(container.querySelector("openclaw-board-view")).not.toBeNull();
  });

  it("renders the hidden dock as board-only", () => {
    const container = createContainer();
    const provider = boardProviderForSession({ sessionKey: "agent:main:main" });
    render(
      renderBoardSessionSurface({
        active: true,
        snapshot: provider.snapshot$.value,
        activeTabId: "main",
        dock: "hidden",
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
      }),
      container,
    );

    expect(container.querySelector("[data-test-chat]")).toBeNull();
    expect(container.querySelector(".board-session-surface--dock-hidden")).not.toBeNull();
    expect(container.querySelector("openclaw-board-view")).not.toBeNull();
  });

  it("preserves the board while the bottom chat mounts only for that dock", () => {
    const container = createContainer();
    const provider = boardProviderForSession({ sessionKey: "agent:main:main" });
    const props = {
      active: true,
      snapshot: provider.snapshot$.value,
      activeTabId: "main",
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

    render(renderBoardSessionSurface({ ...props, active: false, dock: "bottom" }), container);
    const hiddenSurface = container.querySelector<HTMLElement>(".board-session-surface");
    expect(hiddenSurface?.hidden).toBe(true);
    expect(hiddenSurface?.hasAttribute("inert")).toBe(true);
    expect(container.querySelector("openclaw-board-view")).toBe(board);
    expect(board?.active).toBe(false);
    expect(container.querySelector("[data-test-chat]")).toBeNull();

    render(renderBoardSessionSurface({ ...props, dock: "right" }), container);
    expect(container.querySelector("openclaw-board-view")).toBe(board);
    expect(container.querySelector<HTMLElement>(".board-session-surface")?.hidden).toBe(false);
    expect(board?.active).toBe(true);
  });
});
