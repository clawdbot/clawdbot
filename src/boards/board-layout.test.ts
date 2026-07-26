import { describe, expect, it } from "vitest";
import type { BoardLayout } from "./board-layout.js";
import { applyBoardOps, BoardValidationError, normalizeBoardLayout } from "./board-layout.js";

function layout(): BoardLayout {
  return {
    tabs: [
      { tabId: "one", title: "One", position: 4, chatDock: "right" },
      { tabId: "two", title: "Two", position: 8, chatDock: "bottom" },
    ],
    widgets: [
      {
        name: "alpha",
        tabId: "one",
        contentKind: "html",
        sizeW: 6,
        sizeH: 4,
        position: 3,
        grantState: "none",
        revision: 1,
      },
      {
        name: "beta",
        tabId: "one",
        contentKind: "html",
        sizeW: 6,
        sizeH: 4,
        position: 9,
        grantState: "none",
        revision: 1,
      },
      {
        name: "gamma",
        tabId: "two",
        contentKind: "html",
        sizeW: 6,
        sizeH: 4,
        position: 2,
        grantState: "none",
        revision: 1,
      },
    ],
  };
}

function widgetOrder(state: BoardLayout, tabId: string): string[] {
  return state.widgets
    .filter((widget) => widget.tabId === tabId)
    .toSorted((a, b) => a.position - b.position)
    .map((widget) => widget.name);
}

describe("board layout", () => {
  it("normalizes tab and per-tab widget positions without holes", () => {
    const normalized = normalizeBoardLayout(layout());
    expect(normalized.tabs.map((tab) => tab.position)).toEqual([0, 1]);
    expect(
      normalized.widgets
        .filter((widget) => widget.tabId === "one")
        .map((widget) => widget.position),
    ).toEqual([0, 1]);
    expect(normalized.widgets.find((widget) => widget.name === "gamma")?.position).toBe(0);
  });

  it("reorders widgets by position and after anchors, including cross-tab moves", () => {
    const reordered = applyBoardOps(layout(), [
      { kind: "widget_move", name: "beta", position: 0 },
      { kind: "widget_move", name: "gamma", tabId: "one", after: "beta" },
    ]);
    expect(widgetOrder(reordered, "one")).toEqual(["beta", "gamma", "alpha"]);
    expect(widgetOrder(reordered, "two")).toEqual([]);
  });

  it("rejects missing and self after anchors", () => {
    expect(() =>
      applyBoardOps(layout(), [{ kind: "widget_move", name: "alpha", after: "missing" }]),
    ).toThrow(BoardValidationError);
    expect(() =>
      applyBoardOps(layout(), [{ kind: "widget_move", name: "alpha", after: "alpha" }]),
    ).toThrow("after itself");
  });

  it("clamps widget sizes to the grid bounds", () => {
    const resized = applyBoardOps(layout(), [
      { kind: "widget_resize", name: "alpha", sizeW: 99, sizeH: -5 },
    ]);
    const widget = resized.widgets.find((candidate) => candidate.name === "alpha");
    expect(widget).toMatchObject({ sizeW: 12, sizeH: 1 });
  });

  it("moves deleted-tab widgets to the first remaining tab", () => {
    const next = applyBoardOps(layout(), [{ kind: "tab_delete", tabId: "one" }]);
    expect(next.tabs.map((tab) => tab.tabId)).toEqual(["two"]);
    expect(widgetOrder(next, "two")).toEqual(["gamma", "alpha", "beta"]);
  });

  it("allows deleting the last empty tab but rejects deleting it with widgets", () => {
    expect(
      applyBoardOps(
        { tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }], widgets: [] },
        [{ kind: "tab_delete", tabId: "main" }],
      ).tabs,
    ).toEqual([]);
    expect(() =>
      applyBoardOps({ ...layout(), tabs: [layout().tabs[0]!], widgets: [layout().widgets[0]!] }, [
        { kind: "tab_delete", tabId: "one" },
      ]),
    ).toThrow("last board tab");
  });

  it("requires tabs_reorder to be an exact permutation", () => {
    expect(
      applyBoardOps(layout(), [{ kind: "tabs_reorder", tabIds: ["two", "one"] }]).tabs.map(
        (tab) => tab.tabId,
      ),
    ).toEqual(["two", "one"]);
    expect(() =>
      applyBoardOps(layout(), [{ kind: "tabs_reorder", tabIds: ["one", "one"] }]),
    ).toThrow("every tab exactly once");
  });
});
