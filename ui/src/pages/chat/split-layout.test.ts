import { describe, expect, it } from "vitest";
import {
  applyUiCommandToSplitLayout,
  closePane,
  findPane,
  insertPane,
  normalizeChatSplitLayout,
  panesOf,
  resizeColumns,
  resizePanes,
  setActivePane,
  setPaneSession,
  type ChatSplitLayout,
} from "./split-layout.ts";

function createSinglePaneLayout(sessionKey: string): ChatSplitLayout {
  return {
    columns: [{ id: "c1", panes: [{ id: "p1", sessionKey }], paneWeights: [1] }],
    columnWeights: [1],
    activePaneId: "p1",
  };
}

function createSplitLayout(sessionKey: string): ChatSplitLayout {
  return insertPane(createSinglePaneLayout(sessionKey), "p1", sessionKey, "right");
}

function threePaneLayout(): ChatSplitLayout {
  return insertPane(createSplitLayout("main"), "p2", "agent:main:second", "down");
}

describe("chat split layout", () => {
  it("creates two equal columns with the second pane active", () => {
    expect(createSplitLayout("main")).toEqual({
      columns: [
        { id: "c1", panes: [{ id: "p1", sessionKey: "main" }], paneWeights: [1] },
        { id: "c2", panes: [{ id: "p2", sessionKey: "main" }], paneWeights: [1] },
      ],
      columnWeights: [0.5, 0.5],
      activePaneId: "p2",
    });
  });

  it("composes the split layout from an ephemeral single pane", () => {
    expect(createSinglePaneLayout("main")).toEqual({
      columns: [{ id: "c1", panes: [{ id: "p1", sessionKey: "main" }], paneWeights: [1] }],
      columnWeights: [1],
      activePaneId: "p1",
    });
    expect(insertPane(createSinglePaneLayout("main"), "p1", "dropped", "left")).toEqual({
      columns: [
        { id: "c2", panes: [{ id: "p2", sessionKey: "dropped" }], paneWeights: [1] },
        { id: "c1", panes: [{ id: "p1", sessionKey: "main" }], paneWeights: [1] },
      ],
      columnWeights: [0.5, 0.5],
      activePaneId: "p2",
    });
  });

  it("inserts columns immediately left or right and halves only the target weight", () => {
    const right = insertPane(createSplitLayout("main"), "p1", "right", "right");
    expect(right.columns.map((column) => column.id)).toEqual(["c1", "c3", "c2"]);
    expect(right.columns.map((column) => column.panes.map((pane) => pane.id))).toEqual([
      ["p1"],
      ["p3"],
      ["p2"],
    ]);
    expect(right.columnWeights).toEqual([0.25, 0.25, 0.5]);
    expect(right.activePaneId).toBe("p3");

    const left = insertPane(createSplitLayout("main"), "p2", "left", "left");
    expect(left.columns.map((column) => column.panes.at(0)?.sessionKey)).toEqual([
      "main",
      "left",
      "main",
    ]);
    expect(left.columnWeights).toEqual([0.5, 0.25, 0.25]);
    expect(left.activePaneId).toBe("p3");
  });

  it("inserts panes immediately up or down and halves only the target weight", () => {
    const down = insertPane(createSplitLayout("main"), "p1", "down", "down");
    expect(down.columns.at(0)?.panes).toEqual([
      { id: "p1", sessionKey: "main" },
      { id: "p3", sessionKey: "down" },
    ]);
    expect(down.columns.at(0)?.paneWeights).toEqual([0.5, 0.5]);
    expect(down.activePaneId).toBe("p3");

    const up = insertPane(createSplitLayout("main"), "p1", "up", "up");
    expect(up.columns.at(0)?.panes).toEqual([
      { id: "p3", sessionKey: "up" },
      { id: "p1", sessionKey: "main" },
    ]);
    expect(up.columns.at(0)?.paneWeights).toEqual([0.5, 0.5]);
    expect(up.activePaneId).toBe("p3");
  });

  it("closes panes, collapses columns, and chooses the specified adjacent active pane", () => {
    const layout = threePaneLayout();
    const previousInColumn = closePane(layout, "p3");
    expect(previousInColumn?.activePaneId).toBe("p2");
    expect(previousInColumn?.columns.at(1)?.paneWeights).toEqual([1]);

    const activeFirstInSecondColumn = setActivePane(layout, "p2");
    const previousColumn = closePane(activeFirstInSecondColumn, "p2");
    expect(previousColumn?.activePaneId).toBe("p1");
    expect(previousColumn?.columns.at(1)?.panes).toEqual([
      { id: "p3", sessionKey: "agent:main:second" },
    ]);

    const threeColumns = insertPane(createSplitLayout("main"), "p1", "third", "right");
    const collapsedColumn = closePane(threeColumns, "p3");
    expect(collapsedColumn?.columns.map((column) => column.id)).toEqual(["c1", "c2"]);
    expect(collapsedColumn?.columnWeights.at(0)).toBeCloseTo(1 / 3);
    expect(collapsedColumn?.columnWeights.at(1)).toBeCloseTo(2 / 3);
    expect(collapsedColumn?.activePaneId).toBe("p1");

    const collapsed = closePane(createSplitLayout("main"), "p1");
    expect(collapsed).toBeUndefined();
  });

  it("updates pane session and active pane without mutating the input", () => {
    const layout = createSplitLayout("main");
    const sessionChanged = setPaneSession(layout, "p1", "agent:main:new");
    const activeChanged = setActivePane(sessionChanged, "p1");
    expect(findPane(activeChanged, "p1")?.pane.sessionKey).toBe("agent:main:new");
    expect(activeChanged.activePaneId).toBe("p1");
    expect(layout.columns.at(0)?.panes.at(0)?.sessionKey).toBe("main");
    expect(panesOf(layout)).not.toBe(layout.columns.at(0)?.panes);
  });

  it("maps UI split, focus, and close commands onto pane state", () => {
    const initial = setActivePane(setPaneSession(createSplitLayout("main"), "p2", "source"), "p1");
    const split = applyUiCommandToSplitLayout(
      initial,
      {
        kind: "split",
        direction: "down",
        sessionKey: "agent:main:new",
      },
      "source",
    );
    expect(split && panesOf(split).map((pane) => pane.sessionKey)).toEqual([
      "main",
      "source",
      "agent:main:new",
    ]);
    expect(split?.activePaneId).toBe("p3");

    const focused = applyUiCommandToSplitLayout(split!, {
      kind: "focus",
      sessionKey: "main",
    });
    expect(focused?.activePaneId).toBe("p1");

    const closed = applyUiCommandToSplitLayout(focused!, {
      kind: "close-pane",
      sessionKey: "agent:main:new",
    });
    expect(closed && panesOf(closed).map((pane) => pane.sessionKey)).toEqual(["main", "source"]);
  });

  it("resizes only a boundary pair and clamps each side to fifteen percent", () => {
    const layout = insertPane(createSplitLayout("main"), "p1", "third", "right");
    const columns = resizeColumns(layout, 0, 0.8);
    expect(columns.columnWeights.at(0)).toBeCloseTo(0.4);
    expect(columns.columnWeights.at(1)).toBeCloseTo(0.1);
    expect(columns.columnWeights.at(2)).toBe(0.5);
    const clampedColumns = resizeColumns(layout, 0, 0.99).columnWeights;
    expect(clampedColumns.at(0)).toBeCloseTo(0.425);
    expect(clampedColumns.at(1)).toBeCloseTo(0.075);
    expect(clampedColumns.at(2)).toBe(0.5);

    const panes = resizePanes(threePaneLayout(), "c2", 0, 0.2);
    expect(panes.columns.at(1)?.paneWeights).toEqual([0.2, 0.8]);
    expect(resizePanes(threePaneLayout(), "c2", 0, -1).columns.at(1)?.paneWeights).toEqual([
      0.15, 0.85,
    ]);
  });

  it("normalizes recoverable input and repairs weights, ids, and active pane", () => {
    expect(
      normalizeChatSplitLayout({
        columns: [
          {
            id: "same",
            panes: [
              { id: "same", sessionKey: " main " },
              { id: "same", sessionKey: " second " },
              { id: "empty", sessionKey: " " },
            ],
            paneWeights: [2, 1, 1],
          },
          {
            id: "same",
            panes: [{ id: 4, sessionKey: "third" }],
            paneWeights: [0],
          },
        ],
        columnWeights: [0, 3],
        activePaneId: "missing",
      }),
    ).toEqual({
      columns: [
        {
          id: "same",
          panes: [
            { id: "same", sessionKey: "main" },
            { id: "p1", sessionKey: "second" },
          ],
          paneWeights: [2 / 3, 1 / 3],
        },
        {
          id: "c1",
          panes: [{ id: "p2", sessionKey: "third" }],
          paneWeights: [1],
        },
      ],
      columnWeights: [0.5, 0.5],
      activePaneId: "same",
    });
  });

  it("returns undefined for unrecoverable values and drops empty columns", () => {
    expect(normalizeChatSplitLayout(null)).toBeUndefined();
    expect(normalizeChatSplitLayout({ columns: "no" })).toBeUndefined();
    expect(normalizeChatSplitLayout({ columns: [] })).toBeUndefined();
    expect(
      normalizeChatSplitLayout({
        columns: [{ id: "c1", panes: [{ id: "p1", sessionKey: " " }] }],
      }),
    ).toBeUndefined();
    expect(
      normalizeChatSplitLayout({
        columns: [{ id: "c1", panes: [{ id: "p1", sessionKey: "main" }] }],
      }),
    ).toBeUndefined();
  });

  it("inserts after the highest restored pane and column suffix", () => {
    const layout: ChatSplitLayout = {
      columns: [
        {
          id: "c9",
          panes: [
            { id: "custom", sessionKey: "a" },
            { id: "p14", sessionKey: "b" },
          ],
          paneWeights: [0.5, 0.5],
        },
      ],
      columnWeights: [1],
      activePaneId: "custom",
    };

    const inserted = insertPane(layout, "custom", "c", "right");

    expect(inserted.columns.at(1)?.id).toBe("c10");
    expect(inserted.columns.at(1)?.panes.at(0)?.id).toBe("p15");
  });

  it("returns an unchanged clone when the target pane is unknown", () => {
    const layout = createSplitLayout("main");
    const unchanged = insertPane(layout, "missing", "new", "right");
    expect(unchanged).toEqual(layout);
    expect(unchanged).not.toBe(layout);
  });
});
