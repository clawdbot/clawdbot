/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedBoardView } from "./chat-pane-shared.ts";
import {
  renderSidebarRegion,
  resolveSidebarLayoutForBoard,
  sidebarRegionCallbacks,
} from "./chat-pane-sidebar-layout.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import "./components/chat-sidebar-region.runtime.ts";
import { openSlot, setSidebarOpen, type SidebarLayout } from "./sidebar-layout.ts";

function board(face: ResolvedBoardView["face"] = "dashboard") {
  return {
    hasBoard: true,
    face,
  } as ResolvedBoardView;
}

const containers: HTMLElement[] = [];
const requestUpdate = vi.fn();

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
      requestUpdate,
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
        requestUpdate,
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

  it("opens a dashboard route in the canonical right side panel", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board(),
      layout: { columns: [] },
      paneWidth: 1_400,
    });
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]?.side).toBe("right");
    expect(layout.columns[0]?.panels[0]?.slot).toBe("dashboard");
    expect(layout.open).toBe(true);
  });

  it("preserves a selected bottom dock when opening a dashboard route", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board(),
      layout: { ...openSlot({ columns: [] }, "terminal"), dock: "bottom" },
      paneWidth: 1_400,
    });

    expect(layout.dock).toBe("bottom");
    expect(layout.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["terminal", "dashboard"]);
  });

  it("does not reopen a dashboard panel the user explicitly closed", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board(),
      layout: { columns: [] },
      paneWidth: 1_400,
    });
    const closedDashboard = resolveSidebarLayoutForBoard({
      board: board(),
      layout: { ...layout, open: false },
      paneWidth: 1_400,
    });
    expect(closedDashboard.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["dashboard"]);
    expect(closedDashboard.open).toBe(false);

    const closed = resolveSidebarLayoutForBoard({
      board: board(),
      layout: { ...openSlot({ columns: [] }, "browser"), open: false },
      paneWidth: 1_400,
    });
    expect(closed.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["browser", "dashboard"]);
    expect(closed.open).toBe(false);
  });

  it("does not reactivate the dashboard over the selected side-panel tab", () => {
    const selectedSidePanel = openSlot(openSlot({ columns: [] }, "dashboard"), "companion");

    const layout = resolveSidebarLayoutForBoard({
      board: board(),
      layout: selectedSidePanel,
      paneWidth: 1_400,
    });

    expect(layout.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      "dashboard",
      "companion",
    ]);
    expect(layout.columns[0]?.activePanelId).toBe("companion");
  });

  it("persists a selected dashboard tab from the rendered projection", () => {
    const stored = openSlot({ columns: [] }, "terminal");
    const rendered = resolveSidebarLayoutForBoard({
      board: board(),
      layout: stored,
      paneWidth: 1_400,
    });
    const dashboardPanel = rendered.columns[0]?.panels.find((panel) => panel.slot === "dashboard");
    const updateSidebarLayout = vi.fn();
    const updateSidebarActivePanel = vi.fn();
    const state = {
      sidebarLayout: stored,
      updateSidebarLayout,
      updateSidebarActivePanel,
    } as unknown as ChatPageHost;

    sidebarRegionCallbacks({
      state,
      layout: rendered,
      closePanelSlot: vi.fn(),
      openPanelSlot: vi.fn(),
      forgetDiscussionUrl: vi.fn(),
      resizePanel: vi.fn(),
      setPanelOpen: vi.fn(),
    }).activatePanel(dashboardPanel!.id);

    expect(updateSidebarLayout).toHaveBeenCalledWith(
      expect.objectContaining({
        columns: [expect.objectContaining({ activePanelId: dashboardPanel!.id })],
      }),
    );
    expect(updateSidebarActivePanel).toHaveBeenCalledWith(dashboardPanel!.id);
  });

  it("collapses the dashboard tab without discarding its session association", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board(),
      layout: { columns: [] },
      paneWidth: 1_400,
    });
    const setPanelOpen = vi.fn();
    const state = {
      sidebarLayout: layout,
      updateSidebarLayout: vi.fn(),
      updateSidebarActivePanel: vi.fn(),
    } as unknown as ChatPageHost;

    sidebarRegionCallbacks({
      state,
      layout,
      closePanelSlot: vi.fn(),
      openPanelSlot: vi.fn(),
      forgetDiscussionUrl: vi.fn(),
      resizePanel: vi.fn(),
      setPanelOpen,
    }).closeSlot("dashboard");

    expect(setPanelOpen).toHaveBeenCalledWith(false);
    expect(state.updateSidebarLayout).not.toHaveBeenCalled();
  });

  it("preserves dashboard panel state on the owning chat route", () => {
    for (const open of [true, false]) {
      const dashboardOnly = resolveSidebarLayoutForBoard({
        board: board("chat"),
        layout: { ...openSlot({ columns: [] }, "dashboard"), open },
        paneWidth: 1_400,
      });
      expect(dashboardOnly.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["dashboard"]);
      expect(dashboardOnly.open).toBe(open);

      const withDetail = resolveSidebarLayoutForBoard({
        board: board("chat"),
        layout: { ...openSlot(openSlot({ columns: [] }, "dashboard"), "detail"), open },
        paneWidth: 1_400,
      });
      expect(withDetail.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
        "dashboard",
        "detail",
      ]);
      expect(withDetail.open).toBe(open);
    }
  });

  it("does not reinterpret restored state for chat", () => {
    const restored = openSlot({ columns: [] }, "detail");

    expect(
      resolveSidebarLayoutForBoard({
        board: board("chat"),
        layout: restored,
        paneWidth: 1_400,
      }).open,
    ).toBe(true);
  });

  it("keeps the detail tab when its transient content is no longer available", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board("chat"),
      layout: openSlot(openSlot({ columns: [] }, "workspace"), "detail"),
      paneWidth: 1_400,
    });
    expect(layout.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["workspace", "detail"]);
  });

  it("fits only the one canonical panel width", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board("chat"),
      layout: openSlot(openSlot({ columns: [] }, "detail"), "discussion"),
      paneWidth: 1_000,
    });
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]?.width).toBe(480);
  });
});
