import { describe, expect, it } from "vitest";
import {
  SIDEBAR_MIN_WIDTH_PX,
  activatePanel,
  closeSlot,
  fitSidebarLayout,
  normalizeSidebarLayout,
  openSlot,
  reorderPanel,
  resizeSidebarPanel,
  setSidebarDock,
  setSidebarExpanded,
  setSidebarOpen,
  type SidebarLayout,
} from "./sidebar-layout.ts";

function openAll(): SidebarLayout {
  return openSlot(openSlot(openSlot({ columns: [] }, "discussion"), "chat"), "detail");
}

describe("sidebar layout", () => {
  it("opens every slot as a tab in one right-side column", () => {
    const layout = openAll();
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      "discussion",
      "chat",
      "detail",
    ]);
    expect(layout.columns[0]?.activePanelId).toBe("detail");
    expect(layout.columns[0]?.height).toBe(360);
    expect(layout.columns[0]?.width).toBe(360);
    expect(layout.open).toBe(true);
  });

  it("activates an existing tab without changing its persisted order", () => {
    const layout = openAll();
    const chat = layout.columns[0]!.panels[1]!;
    const reopened = openSlot(layout, "chat");
    expect(reopened.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      "discussion",
      "chat",
      "detail",
    ]);
    expect(reopened.columns[0]?.activePanelId).toBe(chat.id);
    expect(activatePanel(layout, chat.id).columns[0]?.activePanelId).toBe(chat.id);
  });

  it("closes one tab and selects its nearest remaining neighbor", () => {
    const layout = openAll();
    const withoutDetail = closeSlot(layout, "detail");
    expect(withoutDetail.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      "discussion",
      "chat",
    ]);
    expect(withoutDetail.columns[0]?.activePanelId).toBe("chat");
  });

  it("reorders tabs without changing the active surface", () => {
    const layout = openAll();
    const [discussion, chat, detail] = layout.columns[0]!.panels;
    const reordered = reorderPanel(layout, discussion!.id, detail!.id, "after");

    expect(reordered.columns[0]?.panels.map((panel) => panel.slot)).toEqual([
      "chat",
      "detail",
      "discussion",
    ]);
    expect(reordered.columns[0]?.activePanelId).toBe(detail!.id);
    expect(layout.columns[0]?.panels[0]?.id).toBe(discussion!.id);
    expect(chat?.slot).toBe("chat");
  });

  it("keeps the panel open as a type selector after its final tab closes", () => {
    const closed = closeSlot(openSlot({ columns: [] }, "detail"), "detail");
    expect(closed).toEqual({ columns: [], open: true });
  });

  it("minimizes and expands without discarding tabs", () => {
    const layout = openAll();
    expect(setSidebarOpen(layout, false)).toMatchObject({ columns: layout.columns, open: false });
    expect(setSidebarExpanded(layout, true)).toMatchObject({
      columns: layout.columns,
      expanded: true,
    });
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
    expect(resized.columns[0]?.width).toBe(360);
    expect(fitSidebarLayout(resized, 560)).toEqual(resized);
  });

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

  it("deduplicates slots and repairs untrusted persisted values", () => {
    expect(normalizeSidebarLayout(null)).toEqual({ columns: [], open: false, expanded: false });
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
          ],
          activePanelId: "same-panel-2",
          height: 360,
          width: 1_200,
        },
      ],
      dock: "right",
      open: false,
      expanded: true,
    });
  });
});
