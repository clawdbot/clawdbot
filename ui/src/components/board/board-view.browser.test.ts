import { afterEach, describe, expect, it, vi } from "vitest";
import { BOARD_GRID_GAP, BOARD_GRID_ROW_HEIGHT } from "../../lib/board/grid.ts";
import type { BoardSnapshot } from "../../lib/board/view-types.ts";
import "./board-view.ts";

type OpenClawBoardView = HTMLElementTagNameMap["openclaw-board-view"];

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

const source: BoardSnapshot = {
  sessionKey: "agent:main:browser-board",
  revision: 1,
  tabs: [
    { tabId: "main", title: "Main", position: 0, chatDock: "right" },
    { tabId: "ops", title: "Operations", position: 1, chatDock: "right" },
  ],
  widgets: [
    {
      name: "first",
      tabId: "main",
      title: "First",
      contentKind: "html",
      sizeW: 6,
      sizeH: 3,
      position: 0,
      grantState: "none",
      revision: 1,
    },
    {
      name: "second",
      tabId: "main",
      title: "Second",
      contentKind: "html",
      sizeW: 6,
      sizeH: 3,
      position: 1,
      grantState: "none",
      revision: 1,
    },
  ],
};

async function mount(applyOps = vi.fn(async () => undefined)): Promise<OpenClawBoardView> {
  const view = document.createElement("openclaw-board-view");
  view.snapshot = structuredClone(source);
  view.activeTabId = "main";
  view.widgetFrameUrl = () => "about:blank";
  view.callbacks = { applyOps, grant: vi.fn(async () => undefined), selectTab: vi.fn() };
  document.body.append(view);
  await view.updateComplete;
  await Promise.all(
    [...view.querySelectorAll("openclaw-board-widget-cell")].map((cell) => cell.updateComplete),
  );
  return view;
}

function pointer(
  target: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup",
  pointerId: number,
  clientX = 0,
  clientY = 0,
): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      pointerId,
      clientX,
      clientY,
      button: 0,
      bubbles: true,
      cancelable: true,
    }),
  );
}

afterEach(() => {
  document.body.replaceChildren();
});

describe.skipIf(!hasBrowserLayout)("openclaw-board-view browser layout", () => {
  it("lays out adjacent first-fit cells without pixel overlap", async () => {
    const view = await mount();
    const cells = [...view.querySelectorAll<HTMLElement>('[data-test-id="board-widget"]')];
    expect(cells).toHaveLength(2);
    const [first, second] = cells.map((cell) => cell.getBoundingClientRect());
    expect(first?.width).toBeGreaterThan(0);
    expect(second?.left).toBeGreaterThanOrEqual((first?.right ?? 0) + BOARD_GRID_GAP - 1);
    expect(Math.round(first?.height ?? 0)).toBe(BOARD_GRID_ROW_HEIGHT * 3 + BOARD_GRID_GAP * 2);
  });

  it("snaps pointer resize to columns and rows before committing", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount(applyOps);
    const grid = view.querySelector<HTMLElement>(".board-grid");
    const handle = view.querySelector<HTMLElement>(".board-widget__resize-handle");
    expect(grid).not.toBeNull();
    expect(handle).not.toBeNull();
    const gridBounds = grid!.getBoundingClientRect();
    const columnUnit = (gridBounds.width - BOARD_GRID_GAP * 11) / 12 + BOARD_GRID_GAP;
    pointer(handle!, "pointerdown", 19, 100, 100);
    pointer(
      window,
      "pointermove",
      19,
      100 + columnUnit,
      100 + BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP,
    );
    pointer(
      window,
      "pointerup",
      19,
      100 + columnUnit * 2,
      100 + (BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP) * 2,
    );

    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([
        { kind: "widget_resize", name: "first", sizeW: 8, sizeH: 5 },
      ]),
    );
  });

  it("does not commit pointer gestures that never change placement", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount(applyOps);
    const handle = view.querySelector<HTMLElement>(".board-widget__resize-handle");
    pointer(handle!, "pointerdown", 23, 100, 100);
    pointer(window, "pointerup", 23, 100, 100);
    const dragHandle = view.querySelector<HTMLElement>(".board-widget__drag-handle");
    pointer(dragHandle!, "pointerdown", 24, 100, 100);
    pointer(window, "pointerup", 24, 100, 100);
    await Promise.resolve();
    expect(applyOps).not.toHaveBeenCalled();
  });

  it("keeps an active gesture owned by its initiating pointer", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount(applyOps);
    const grid = view.querySelector<HTMLElement>(".board-grid");
    const handles = view.querySelectorAll<HTMLElement>(".board-widget__resize-handle");
    const gridBounds = grid!.getBoundingClientRect();
    const columnUnit = (gridBounds.width - BOARD_GRID_GAP * 11) / 12 + BOARD_GRID_GAP;
    pointer(handles[0]!, "pointerdown", 31, 100, 100);
    pointer(handles[1]!, "pointerdown", 32, 200, 100);
    pointer(
      window,
      "pointermove",
      32,
      200 + columnUnit,
      100 + BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP,
    );
    pointer(window, "pointerup", 32);
    expect(applyOps).not.toHaveBeenCalled();

    pointer(
      window,
      "pointermove",
      31,
      100 + columnUnit,
      100 + BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP,
    );
    pointer(
      window,
      "pointerup",
      31,
      100 + columnUnit,
      100 + BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP,
    );
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([
        { kind: "widget_resize", name: "first", sizeW: 7, sizeH: 4 },
      ]),
    );
  });

  it("rejects tab drop targets owned by another board", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount(applyOps);

    const other = await mount();
    other.snapshot = {
      ...structuredClone(source),
      tabs: [
        { tabId: "foreign-a", title: "Foreign A", position: 0, chatDock: "right" },
        { tabId: "foreign-b", title: "Foreign B", position: 1, chatDock: "right" },
      ],
      widgets: [],
    };
    other.activeTabId = "foreign-a";
    await other.updateComplete;

    const handle = view.querySelector<HTMLElement>(".board-widget__drag-handle");
    const foreignTab = other.querySelector<HTMLElement>('[data-board-tab-id="foreign-b"]');
    const target = foreignTab!.getBoundingClientRect();
    pointer(handle!, "pointerdown", 41, 100, 100);
    pointer(
      window,
      "pointermove",
      41,
      target.left + target.width / 2,
      target.top + target.height / 2,
    );
    pointer(
      window,
      "pointerup",
      41,
      target.left + target.width / 2,
      target.top + target.height / 2,
    );
    await Promise.resolve();
    expect(applyOps).not.toHaveBeenCalled();
  });

  it("rejects widget drops outside the board grid", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount(applyOps);
    const handle = view.querySelector<HTMLElement>(".board-widget__drag-handle");
    pointer(handle!, "pointerdown", 51, 100, 100);
    pointer(window, "pointermove", 51, 0, 10_000);
    pointer(window, "pointerup", 51, 0, 10_000);
    await Promise.resolve();
    expect(applyOps).not.toHaveBeenCalled();
  });

  it("offers an append drop zone after the final widget", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount(applyOps);
    view.snapshot = {
      ...structuredClone(source),
      widgets: source.widgets.map((widget) => ({ ...widget, sizeW: 12 })),
    };
    await view.updateComplete;
    const cells = view.querySelectorAll("openclaw-board-widget-cell");
    await Promise.all([...cells].map((cell) => cell.updateComplete));
    const handle = view.querySelector<HTMLElement>(".board-widget__drag-handle");
    pointer(handle!, "pointerdown", 61, 100, 100);
    await view.updateComplete;
    const appendZone = view.querySelector<HTMLElement>(".board-grid__append-zone");
    const target = appendZone!.getBoundingClientRect();
    const targetX = target.left + target.width / 2;
    const targetY = target.top + target.height / 2;
    pointer(window, "pointermove", 61, targetX, targetY);
    pointer(window, "pointerup", 61, targetX, targetY);
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([{ kind: "widget_move", name: "first", position: 1 }]),
    );
  });

  it("keeps approval controls scrollable in a one-row widget", async () => {
    const view = await mount();
    view.snapshot = {
      ...structuredClone(source),
      widgets: [{ ...source.widgets[0]!, sizeH: 1, grantState: "pending" }],
    };
    await view.updateComplete;
    const cell = view.querySelector("openclaw-board-widget-cell");
    await cell?.updateComplete;
    const body = view.querySelector<HTMLElement>(".board-widget__body--scrollable");
    const allow = view.querySelector<HTMLButtonElement>('[data-test-id="board-grant-allow"]');
    expect(getComputedStyle(body!).overflowY).toBe("auto");
    expect(body!.scrollHeight).toBeGreaterThan(body!.clientHeight);
    allow?.focus();
    expect(document.activeElement).toBe(allow);
  });

  it("keeps contained errors scrollable in a one-row widget", async () => {
    const view = await mount();
    view.snapshot = {
      ...structuredClone(source),
      widgets: [{ ...source.widgets[0]!, sizeH: 1 }],
    };
    view.widgetFrameUrl = () => {
      throw new Error("one-row resolver failed");
    };
    await view.updateComplete;
    const cell = view.querySelector("openclaw-board-widget-cell");
    await cell?.updateComplete;
    const body = view.querySelector<HTMLElement>(".board-widget__body--scrollable");
    expect(getComputedStyle(body!).overflowY).toBe("auto");
    expect(body!.scrollHeight).toBeGreaterThan(body!.clientHeight);
    expect(body?.textContent).toContain("one-row resolver failed");
  });
});
