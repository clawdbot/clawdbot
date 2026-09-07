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
import {
  openSlot,
  promoteSidebarPanel,
  setSidebarDock,
  setSidebarExpanded,
  setSidebarOpen,
  sidebarActivePanel,
  sidebarMainPanel,
  type SidebarLayout,
} from "./sidebar-layout.ts";

function board(face: ResolvedBoardView["face"] = "dashboard") {
  return {
    available: true,
    hasBoard: true,
    face,
    provider: { hasLoadedSnapshot: true },
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
      panelTemplates: { detail: html`<aside data-detail>Details<input type="checkbox" /></aside>` },
      primary: html`<main data-primary>Primary<textarea></textarea></main>`,
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
  it("preserves drafts and panel state across swapping, docking, focus, minimize, and mobile", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    const open = openSlot({ columns: [] }, "detail");

    await renderLayout(container, { columns: [], open: false });
    const primary = container.querySelector("[data-primary]");
    const draft = primary!.querySelector("textarea")!;
    draft.value = "Keep this draft";
    await renderLayout(container, open);
    const detail = container.querySelector<HTMLElement>("[data-detail]")!;
    const checkbox = detail.querySelector("input")!;
    checkbox.checked = true;
    expect(container.querySelector("[data-primary]")).toBe(primary);
    const promoted = promoteSidebarPanel(open, "detail");
    for (const dock of ["left", "right", "bottom"] as const) {
      await renderLayout(container, setSidebarDock(promoted, dock));
      expect(detail.closest("[data-region]")?.getAttribute("data-region")).toBe("main");
      expect(primary?.closest("[data-region]")?.getAttribute("data-region")).toBe("side");
      expect(primary?.closest("[data-region]")?.hasAttribute("hidden")).toBe(false);
      expect(container.querySelector("[data-detail]")).toBe(detail);
      expect(container.querySelector("[data-primary]")).toBe(primary);
    }
    await renderLayout(container, setSidebarExpanded(promoted, true));
    expect(primary?.closest("[data-region]")?.hasAttribute("hidden")).toBe(true);
    expect(detail.closest("[data-region]")?.hasAttribute("hidden")).toBe(false);
    await renderLayout(container, setSidebarOpen(promoted, false));
    expect(primary?.closest("[data-region]")?.hasAttribute("hidden")).toBe(true);
    await renderLayout(container, setSidebarOpen(promoted, true), true);
    expect(primary?.closest("[data-region]")?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector(".sidebar-region--narrow")).not.toBeNull();
    const conversation = promoted.columns[0]!.panels.find(
      (panel) => panel.slot === "conversation",
    )!;
    await renderLayout(container, promoteSidebarPanel(promoted, conversation.id));
    expect(primary?.closest("[data-region]")?.getAttribute("data-region")).toBe("main");
    expect(container.querySelector("[data-detail]")).toBe(detail);
    expect(container.querySelector("[data-primary]")).toBe(primary);
    expect(draft.value).toBe("Keep this draft");
    expect(checkbox.checked).toBe(true);
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
    expect(container.querySelector('[data-panel-slot="detail"]')?.getAttribute("data-region")).toBe(
      "side",
    );
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

  it("preserves a saved bottom dock and panel selection on a dashboard route", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board(),
      layout: { ...openSlot({ columns: [] }, "terminal"), dock: "bottom" },
      paneWidth: 1_400,
    });

    expect(layout.dock).toBe("bottom");
    expect(layout.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["terminal"]);
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
    expect(closed.columns[0]?.panels.map((panel) => panel.slot)).toEqual(["browser"]);
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

  it("persists tab selection without changing the chosen main content", () => {
    const stored = promoteSidebarPanel(
      openSlot(openSlot({ columns: [] }, "terminal"), "dashboard"),
      "dashboard",
    );
    const rendered = resolveSidebarLayoutForBoard({
      board: board(),
      layout: stored,
      paneWidth: 1_400,
    });
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
    }).activatePanel("terminal");

    expect(updateSidebarLayout).toHaveBeenCalledWith(
      expect.objectContaining({
        mainPanelId: "dashboard",
        columns: [expect.objectContaining({ activePanelId: "terminal" })],
      }),
    );
    expect(updateSidebarActivePanel).toHaveBeenCalledWith("terminal");
  });

  it("closes dashboard presentation through its owner without minimizing unrelated tabs", () => {
    const layout = resolveSidebarLayoutForBoard({
      board: board(),
      layout: { columns: [] },
      paneWidth: 1_400,
    });
    const setPanelOpen = vi.fn();
    const closePanelSlot = vi.fn();
    const state = {
      sidebarLayout: layout,
      updateSidebarLayout: vi.fn(),
      updateSidebarActivePanel: vi.fn(),
    } as unknown as ChatPageHost;

    sidebarRegionCallbacks({
      state,
      layout,
      closePanelSlot,
      openPanelSlot: vi.fn(),
      forgetDiscussionUrl: vi.fn(),
      resizePanel: vi.fn(),
      setPanelOpen,
    }).closeSlot("dashboard");

    expect(closePanelSlot).toHaveBeenCalledWith("dashboard");
    expect(setPanelOpen).not.toHaveBeenCalled();
    expect(state.updateSidebarLayout).not.toHaveBeenCalled();
  });

  it("keeps an empty dashboard open and only removes it when dashboard support is unavailable", () => {
    const layout = promoteSidebarPanel(
      openSlot(openSlot({ columns: [] }, "dashboard"), "detail"),
      "dashboard",
    );
    const loading = { ...board(), hasBoard: false };
    const awaitingSnapshot = resolveSidebarLayoutForBoard({
      board: { ...loading, provider: { hasLoadedSnapshot: false } } as ResolvedBoardView,
      layout,
      paneWidth: 1_400,
    });
    expect(awaitingSnapshot).toEqual(layout);
    expect(resolveSidebarLayoutForBoard({ board: loading, layout, paneWidth: 1_400 })).toEqual(
      layout,
    );
    const removed = resolveSidebarLayoutForBoard({
      board: { ...loading, available: false },
      layout,
      paneWidth: 1_400,
    });
    expect(sidebarMainPanel(removed)?.slot).toBe("conversation");
    expect(sidebarActivePanel(removed)?.slot).toBe("detail");
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
