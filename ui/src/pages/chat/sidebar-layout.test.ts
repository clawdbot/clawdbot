import { describe, expect, it } from "vitest";
import {
  SIDEBAR_MIN_WIDTH_PX,
  activatePanel,
  closeSlot,
  ensureSidebarConversation,
  fitSidebarLayout,
  isSidebarSlotVisible,
  normalizeSidebarLayout,
  openSlot,
  promoteSidebarPanel,
  reorderPanel,
  resizeSidebarPanel,
  setSidebarDock,
  setSidebarExpanded,
  setSidebarOpen,
  sidebarActivePanel,
  sidebarMainPanel,
  sidebarSidePanels,
  type SidebarLayout,
} from "./sidebar-layout.ts";

function openAll(): SidebarLayout {
  return openSlot(openSlot(openSlot({ columns: [] }, "discussion"), "dashboard"), "detail");
}

describe("sidebar layout", () => {
  it("opens every slot as a tab in one right-side column", () => {
    const layout = openAll();
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      "discussion",
      "dashboard",
      "detail",
    ]);
    expect(layout.columns[0]?.activePanelId).toBe("detail");
    expect(layout.columns[0]?.height).toBe(360);
    expect(layout.columns[0]?.width).toBe(480);
    expect(layout.open).toBe(true);
  });

  it("activates an existing tab without changing its persisted order", () => {
    const layout = openAll();
    const dashboard = layout.columns[0]!.panels[1]!;
    const reopened = openSlot(layout, "dashboard");
    expect(reopened.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      "discussion",
      "dashboard",
      "detail",
    ]);
    expect(reopened.columns[0]?.activePanelId).toBe(dashboard.id);
    expect(activatePanel(layout, dashboard.id).columns[0]?.activePanelId).toBe(dashboard.id);
  });

  it("closes one tab and selects its nearest remaining neighbor", () => {
    const layout = openAll();
    const withoutDetail = closeSlot(layout, "detail");
    expect(withoutDetail.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      "discussion",
      "dashboard",
    ]);
    expect(withoutDetail.columns[0]?.activePanelId).toBe("dashboard");
  });

  it("reorders tabs without changing the active surface", () => {
    const layout = openAll();
    const [discussion, dashboard, detail] = layout.columns[0]!.panels;
    const reordered = reorderPanel(layout, discussion!.id, detail!.id, "after");

    expect(reordered.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      "dashboard",
      "detail",
      "discussion",
    ]);
    expect(reordered.columns[0]?.activePanelId).toBe(detail!.id);
    expect(layout.columns[0]?.panels[0]?.id).toBe(discussion!.id);
    expect(dashboard?.slot).toBe("dashboard");
  });

  it("collapses the panel after its final tab closes", () => {
    const closed = closeSlot(openSlot({ columns: [] }, "detail"), "detail");
    expect(closed).toEqual({
      columns: [
        {
          id: "side-panel-column",
          side: "right",
          panels: [],
          activePanelId: "",
          height: 360,
          width: 480,
        },
      ],
      open: false,
    });
  });

  it("does not reopen a minimized panel when another tab remains", () => {
    const minimized = { ...openAll(), open: false };
    const closed = closeSlot(minimized, "detail");
    expect(closed.open).toBe(false);
    expect(closed.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      "discussion",
      "dashboard",
    ]);
  });

  it("minimizes and expands without discarding tabs", () => {
    const layout = openAll();
    expect(setSidebarOpen(layout, false)).toMatchObject({ columns: layout.columns, open: false });
    expect(setSidebarExpanded(layout, true)).toMatchObject({
      columns: layout.columns,
      expanded: true,
    });
  });

  it("swaps main content with the selected side tab without changing content identity or geometry", () => {
    const original = openAll();
    const dashboardMain = promoteSidebarPanel(original, "dashboard");
    const conversation = dashboardMain.columns[0]!.panels.find(
      (panel) => panel.slot === "conversation",
    )!;
    expect(sidebarMainPanel(dashboardMain)?.slot).toBe("dashboard");
    expect(sidebarActivePanel(dashboardMain)).toBe(conversation);
    expect(sidebarSidePanels(dashboardMain).map((panel) => panel.slot)).toEqual([
      "discussion",
      "detail",
      "conversation",
    ]);

    const detailMain = promoteSidebarPanel(dashboardMain, "detail");
    expect(sidebarMainPanel(detailMain)?.slot).toBe("detail");
    expect(sidebarActivePanel(detailMain)?.slot).toBe("dashboard");
    expect(detailMain.columns[0]?.panels).toEqual(dashboardMain.columns[0]?.panels);
    expect(detailMain.columns[0]?.width).toBe(original.columns[0]?.width);
    expect(detailMain.columns[0]?.height).toBe(original.columns[0]?.height);

    const conversationMain = promoteSidebarPanel(detailMain, conversation.id);
    expect(sidebarMainPanel(conversationMain)?.slot).toBe("conversation");
    expect(sidebarActivePanel(conversationMain)?.slot).toBe("detail");
    expect(conversationMain.columns[0]?.panels).toEqual(dashboardMain.columns[0]?.panels);
    expect(original.columns[0]?.panels).toHaveLength(3);
  });

  it("focuses main independently and restores the side selection when reopened", () => {
    const layout = promoteSidebarPanel(openAll(), "dashboard");
    const focused = setSidebarExpanded(layout, true);
    expect(isSidebarSlotVisible(focused, "dashboard")).toBe(true);
    expect(isSidebarSlotVisible(focused, "conversation")).toBe(false);
    expect(openSlot(focused, "dashboard")).toEqual(focused);

    const minimized = setSidebarOpen(focused, false);
    expect(isSidebarSlotVisible(minimized, "dashboard")).toBe(true);
    const reopened = setSidebarOpen(minimized, true);
    expect(isSidebarSlotVisible(reopened, "conversation")).toBe(true);
    expect(sidebarMainPanel(reopened)?.slot).toBe("dashboard");
    const openedDetail = openSlot(focused, "detail");
    expect(isSidebarSlotVisible(openedDetail, "detail")).toBe(true);
    expect(sidebarMainPanel(openedDetail)?.slot).toBe("dashboard");
    expect(promoteSidebarPanel(focused, "detail").expanded).toBe(false);
  });

  it("restores conversation when main closes and retains the other side tabs", () => {
    const layout = promoteSidebarPanel(openAll(), "dashboard");
    const withoutConversation = closeSlot(layout, "conversation");
    expect(withoutConversation.open).toBe(false);
    expect(withoutConversation.columns[0]?.panels).toEqual(layout.columns[0]?.panels);

    const closed = closeSlot(layout, "dashboard");
    expect(sidebarMainPanel(closed)?.slot).toBe("conversation");
    expect(sidebarSidePanels(closed).map((panel) => panel.slot)).toEqual(["discussion", "detail"]);
    expect(sidebarActivePanel(closed)?.slot).toBe("discussion");
    expect(closed.open).toBe(true);
    expect(closeSlot(closed, "conversation")).toEqual(closed);

    const finalPanel = closeSlot(
      promoteSidebarPanel(openSlot({ columns: [] }, "dashboard"), "dashboard"),
      "dashboard",
    );
    expect(isSidebarSlotVisible(finalPanel, "conversation")).toBe(true);
    expect(finalPanel.open).toBe(false);
  });

  it("selects the nearest remaining side tab while excluding the main panel", () => {
    const layout = activatePanel(promoteSidebarPanel(openAll(), "discussion"), "dashboard");
    const closed = closeSlot(layout, "dashboard");
    expect(sidebarActivePanel(closed)?.slot).toBe("detail");
    expect(sidebarMainPanel(closed)?.slot).toBe("discussion");
  });

  it("round-trips focused conversation without interpreting it as legacy dashboard focus", () => {
    const focused = setSidebarExpanded(ensureSidebarConversation(openAll()), true);
    const saved = JSON.stringify(focused);
    const loaded = normalizeSidebarLayout(JSON.parse(saved));
    expect(sidebarMainPanel(loaded)?.slot).toBe("conversation");
    expect(sidebarActivePanel(loaded)?.slot).toBe("detail");
    expect(isSidebarSlotVisible(loaded, "conversation")).toBe(true);
    expect(isSidebarSlotVisible(loaded, "detail")).toBe(false);
    expect(normalizeSidebarLayout(loaded)).toEqual(loaded);
  });

  it("repairs a stale main reference without confusing a saved panel ID with conversation", () => {
    const layout = normalizeSidebarLayout({
      mainPanelId: "removed-panel",
      columns: [
        {
          id: "column",
          side: "right",
          activePanelId: "conversation",
          panels: [{ id: "conversation", slot: "dashboard" }],
        },
      ],
    });
    expect(sidebarMainPanel(layout)).toEqual({ id: "conversation-2", slot: "conversation" });
    expect(sidebarActivePanel(layout)).toEqual({ id: "conversation", slot: "dashboard" });
    expect(normalizeSidebarLayout(layout)).toEqual(layout);
  });

  it("clamps and fits the single inherited resizable column", () => {
    const layout = openAll();
    const columnId = layout.columns[0]!.id;
    expect(resizeSidebarPanel(layout, columnId, 1).columns[0]?.width).toBe(SIDEBAR_MIN_WIDTH_PX);
    expect(resizeSidebarPanel(layout, columnId, Number.MAX_VALUE).columns[0]?.width).toBe(1_200);
    expect(
      fitSidebarLayout(resizeSidebarPanel(layout, columnId, 1_000), 1_200)?.columns[0]?.width,
    ).toBe(720);
    expect(fitSidebarLayout(layout, 560)).toBeNull();
  });

  it("persists and resizes the same panel at the bottom", () => {
    const layout = setSidebarDock(openAll(), "bottom");
    const columnId = layout.columns[0]!.id;
    const resized = resizeSidebarPanel(layout, columnId, 480);

    expect(resized.dock).toBe("bottom");
    expect(resized.columns[0]?.height).toBe(480);
    expect(resized.columns[0]?.width).toBe(480);
    expect(fitSidebarLayout(resized, 560)).toEqual(resized);
  });

  it.each(["left", "right", "bottom"] as const)(
    "persists the %s dock without changing main or side content",
    (dock) => {
      const layout = promoteSidebarPanel(openAll(), "dashboard");
      const docked = normalizeSidebarLayout(setSidebarDock(layout, dock));
      expect(docked.dock).toBe(dock);
      expect(sidebarMainPanel(docked)).toEqual(sidebarMainPanel(layout));
      expect(sidebarActivePanel(docked)).toEqual(sidebarActivePanel(layout));
      expect(docked.columns).toEqual(layout.columns);
    },
  );

  it("flattens legacy multi-column layouts in stable order", () => {
    expect(
      normalizeSidebarLayout({
        columns: [
          {
            id: "left",
            side: "left",
            panels: [{ id: "workspace", slot: "workspace" }],
            activePanelId: "workspace",
            width: 420,
          },
          {
            id: "right",
            side: "right",
            panels: [
              { id: "terminal", slot: "terminal" },
              { id: "detail", slot: "detail" },
            ],
            activePanelId: "detail",
            width: 500,
          },
        ],
      }),
    ).toEqual({
      columns: [
        {
          id: "left",
          side: "right",
          panels: [
            { id: "workspace", slot: "workspace" },
            { id: "terminal", slot: "terminal" },
            { id: "detail", slot: "detail" },
          ],
          activePanelId: "detail",
          height: 360,
          width: 500,
        },
      ],
      dock: "right",
      open: true,
      expanded: false,
    });
  });

  it.each([true, false])(
    "migrates a legacy expanded dashboard with open=%s without changing visible content",
    (open) => {
      const layout = normalizeSidebarLayout({
        columns: [
          {
            id: "side-panel-column",
            side: "right",
            panels: [
              { id: "chat", slot: "chat" },
              { id: "terminal", slot: "terminal" },
            ],
            activePanelId: "chat",
            height: 520,
            width: 640,
          },
        ],
        dock: "bottom",
        open,
        expanded: true,
      });
      expect(layout).toEqual({
        columns: [
          {
            id: "side-panel-column",
            side: "right",
            panels: [
              { id: "chat", slot: "dashboard" },
              { id: "terminal", slot: "terminal" },
              { id: "conversation", slot: "conversation" },
            ],
            activePanelId: open ? "conversation" : "chat",
            height: 520,
            width: 640,
          },
        ],
        mainPanelId: open ? "chat" : "conversation",
        dock: "bottom",
        open,
        expanded: true,
      });
      expect(isSidebarSlotVisible(layout, "dashboard")).toBe(open);
      expect(isSidebarSlotVisible(layout, "conversation")).toBe(!open);
      expect(normalizeSidebarLayout(layout)).toEqual(layout);
    },
  );

  it("deduplicates slots and repairs untrusted persisted values", () => {
    expect(normalizeSidebarLayout(null)).toEqual({ columns: [], open: false, expanded: false });
    expect(normalizeSidebarLayout({ columns: [], open: true })).toEqual({
      columns: [
        {
          id: "side-panel-column",
          side: "right",
          panels: [],
          activePanelId: "",
          height: 360,
          width: 480,
        },
      ],
      dock: "right",
      open: true,
      expanded: false,
    });
    expect(
      normalizeSidebarLayout({
        columns: [
          {
            id: "review",
            side: "right",
            panels: [{ id: "detail", slot: "detail" }],
          },
        ],
      }).columns[0]?.width,
    ).toBe(480);
    expect(normalizeSidebarLayout({ columns: "nope" })).toEqual({
      columns: [],
      open: false,
      expanded: false,
    });
    expect(
      normalizeSidebarLayout({
        columns: [
          {
            id: "same",
            side: "right",
            panels: [
              { id: "same-panel", slot: "detail" },
              { id: "unknown", slot: "unknown" },
            ],
            activePanelId: "missing",
            width: 20,
          },
          {
            id: "same",
            side: "left",
            panels: [
              { id: "same-panel", slot: "discussion" },
              { id: "duplicate-slot", slot: "detail" },
            ],
            activePanelId: "same-panel",
            width: 50_000,
          },
        ],
        open: false,
        expanded: true,
      }),
    ).toEqual({
      columns: [
        {
          id: "same",
          side: "right",
          panels: [
            { id: "same-panel", slot: "detail" },
            { id: "same-panel-2", slot: "discussion" },
            { id: "conversation", slot: "conversation" },
          ],
          activePanelId: "same-panel-2",
          height: 360,
          width: 1_200,
        },
      ],
      mainPanelId: "conversation",
      dock: "right",
      open: false,
      expanded: true,
    });
  });
});
