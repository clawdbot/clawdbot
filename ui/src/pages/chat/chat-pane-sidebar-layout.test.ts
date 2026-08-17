/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import { renderSidebarRegion, resolveSidebarLayoutForBoard } from "./chat-pane-sidebar-layout.ts";
import "./components/chat-sidebar-region.runtime.ts";
import { openSlot, setSidebarOpen, type SidebarLayout } from "./sidebar-layout.ts";

function board(dock: ResolvedBoardView["dock"], face: ResolvedBoardView["face"] = "dashboard") {
  return { hasBoard: true, face, dock } as ResolvedBoardView;
}

const containers: HTMLElement[] = [];

function callbacks() {
  return {
    activatePanel: vi.fn(),
    closeSlot: vi.fn(),
    openSlot: vi.fn(),
    reorderPanel: vi.fn(),
    resizePanel: vi.fn(),
    setDock: vi.fn(),
    setExpanded: vi.fn(),
    setOpen: vi.fn(),
  };
}

async function renderLayout(container: HTMLElement, layout: SidebarLayout, narrow = false) {
  render(
    renderSidebarRegion({
      availableWidth: narrow ? 620 : 1_400,
      availableSlots: ["detail", "terminal", "workspace"],
      callbacks: callbacks(),
      layout,
      narrow,
      panelActions: {},
      panelTemplates: { detail: html`<aside data-detail>Details</aside>` },
      primary: html`<main data-primary>Primary</main>`,
    }),
    container,
  );
  await customElements.whenDefined("openclaw-chat-sidebar-region");
  await container.querySelector("openclaw-chat-sidebar-region")?.updateComplete;
}

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

describe("chat pane sidebar layout", () => {
  it("preserves the primary DOM across open, minimize, reopen, and mobile", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const open = openSlot({ columns: [] }, "detail");

    await renderLayout(container, { columns: [], open: false });
    const primary = container.querySelector("[data-primary]");
    await renderLayout(container, open);
    expect(container.querySelector("[data-primary]")).toBe(primary);
    expect(container.querySelector(".sidebar-region__right-runtime .side-panel")).not.toBeNull();
    await renderLayout(container, setSidebarOpen(open, false));
    expect(container.querySelector("[data-primary]")).toBe(primary);
    expect(container.querySelector(".side-panel")).toBeNull();
    await renderLayout(container, open, true);
    expect(container.querySelector("[data-primary]")).toBe(primary);
    expect(container.querySelector(".sidebar-region--narrow")).not.toBeNull();
  });

  it("keeps an unmeasured shell in the wide layout", async () => {
    const container = document.createElement("div");
    containers.push(container);
    render(
      renderSidebarRegion({
        availableWidth: 0,
        availableSlots: ["detail"],
        callbacks: callbacks(),
        layout: openSlot({ columns: [] }, "detail"),
        narrow: false,
        panelActions: {},
        panelTemplates: { detail: html`<aside>Details</aside>` },
        primary: html`<main>Primary</main>`,
      }),
      container,
    );
    expect(container.querySelector(".sidebar-region--narrow")).toBeNull();
  });

  it("places the unified panel below the conversation when bottom-docked", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const layout = { ...openSlot({ columns: [] }, "detail"), dock: "bottom" as const };

    await renderLayout(container, layout);

    expect(container.querySelector(".sidebar-region--bottom")).not.toBeNull();
    expect(container.querySelector(".side-panel--bottom")).not.toBeNull();
    expect(container.querySelector("resizable-divider")?.orientation).toBe("horizontal");
  });

  it("puts side-docked board chat in the canonical panel regardless of legacy dock edge", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board("left"),
      layout: { columns: [] },
      paneWidth: 1_400,
    });
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]?.side).toBe("right");
    expect(layout.columns[0]?.panels[0]?.slot).toBe("chat");
  });

  it("keeps bottom and hidden board chat outside the side panel", () => {
    for (const dock of ["bottom", "hidden"] as const) {
      const layout = resolveSidebarLayoutForBoard({
        board: board(dock),
        layout: openSlot(openSlot({ columns: [] }, "chat"), "detail"),
        paneWidth: 1_400,
      });
      expect(layout.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["detail"]);
    }
  });

  it("keeps the detail tab when its transient content is no longer available", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board("hidden", "chat"),
      layout: openSlot(openSlot({ columns: [] }, "workspace"), "detail"),
      paneWidth: 1_400,
    });
    expect(layout.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["workspace", "detail"]);
  });

  it("fits only the one canonical panel width", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board("hidden", "chat"),
      layout: openSlot(openSlot({ columns: [] }, "detail"), "discussion"),
      paneWidth: 1_000,
    });
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]?.width).toBe(360);
  });
});
