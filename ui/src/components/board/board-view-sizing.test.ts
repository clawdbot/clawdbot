import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boardChromeRowPx,
  effectiveBoardWidgetRows,
  exactBoardWidgetHeightPx,
} from "../../lib/board/grid.ts";
// Side-effect import: test-support only type-imports the component, so the
// custom element must be registered here for mount() to render anything.
import "./board-view.ts";
import { boardWidget, callbacks, mount, snapshot } from "./board-view.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("board widget sizing", () => {
  it("snaps reported HTML heights to rows with card inset and fixed-mode fallbacks", () => {
    const card = boardWidget({ sizeH: 6 });
    expect(effectiveBoardWidgetRows(card, 98)).toBe(2);
    expect(effectiveBoardWidgetRows(card, 99)).toBe(3);
    expect(effectiveBoardWidgetRows({ ...card, presentation: "full-bleed" }, 122)).toBe(2);
    expect(effectiveBoardWidgetRows({ ...card, presentation: "frameless" }, 123)).toBe(3);
    expect(effectiveBoardWidgetRows(card, 1)).toBe(2);
    expect(effectiveBoardWidgetRows(card, 10_000)).toBe(20);
    expect(effectiveBoardWidgetRows(card, 10_000, 0, 240)).toBeGreaterThan(20);
    expect(effectiveBoardWidgetRows({ ...card, heightMode: "fixed" }, 600)).toBe(6);
    expect(effectiveBoardWidgetRows(card, undefined)).toBe(6);
    expect(effectiveBoardWidgetRows({ ...card, contentKind: "mcp-app" }, 600)).toBe(6);
    // Coarse-pointer layouts keep the 38px bar in flow; the same report needs
    // more rows than the fine-pointer overlay layout.
    expect(effectiveBoardWidgetRows(card, 101, 38)).toBe(3);
    expect(effectiveBoardWidgetRows(card, 150, 38)).toBe(4);
    expect(effectiveBoardWidgetRows(card, 150, 0)).toBe(3);
  });

  it("hugs auto cards to their exact content height inside the quantized cell", () => {
    const card = boardWidget({ sizeH: 6 });
    // Every presentation reserves its border; cards also add 12px per edge.
    expect(exactBoardWidgetHeightPx(card, 300)).toBe(326);
    expect(exactBoardWidgetHeightPx({ ...card, presentation: "frameless" }, 300)).toBe(302);
    // Short content hugs below the 2-row cell minimum: the cell keeps its
    // minimum span, only the card shrinks.
    expect(exactBoardWidgetHeightPx(card, 60)).toBe(86);
    // At the 20-row cap the card fills the cell exactly and the body clips.
    expect(exactBoardWidgetHeightPx(card, 10_000)).toBe(20 * 56 + 19 * 12);
    expect(exactBoardWidgetHeightPx(card, 10_000, 0, 240)).toBe(10_026);
    // Coarse-pointer layouts keep the 38px bar in flow, joining the height.
    expect(exactBoardWidgetHeightPx(card, 300, 38)).toBe(364);
    expect(exactBoardWidgetHeightPx({ ...card, heightMode: "fixed" }, 300)).toBeUndefined();
    expect(exactBoardWidgetHeightPx(card, undefined)).toBeUndefined();
    expect(exactBoardWidgetHeightPx({ ...card, contentKind: "mcp-app" }, 300)).toBeUndefined();
  });

  it("pins the exact reported height on the card and re-fills while dragging", async () => {
    const view = await mount();
    const cell = view.querySelector("openclaw-board-widget-cell");
    const frame = cell?.querySelector("iframe");
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame?.contentWindow ?? null,
        data: { type: "openclaw:widget-size", height: 300 },
      }),
    );
    const widget = boardWidget();
    const expected = exactBoardWidgetHeightPx(widget, 300, boardChromeRowPx());
    const section = () => cell?.querySelector<HTMLElement>(".board-widget");
    await vi.waitFor(() => {
      expect(section()?.getAttribute("style")).toContain(`height: ${expected}px`);
      expect(section()?.getAttribute("style")).toContain("align-self: start");
    });
    // Gestures manipulate the quantized cell, so the card fills it again.
    Reflect.set(cell ?? {}, "dragging", true);
    await cell?.updateComplete;
    expect(section()?.getAttribute("style")).not.toContain("align-self");
  });

  it("lets a dashboard document fit tall HTML content without an inner scroll viewport", async () => {
    const view = await mount();
    view.fitAutoContent = true;
    await view.updateComplete;
    const cell = view.querySelector("openclaw-board-widget-cell");
    const frame = cell?.querySelector("iframe");
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame?.contentWindow ?? null,
        data: { type: "openclaw:widget-size", height: 10_000 },
      }),
    );

    await vi.waitFor(() => {
      const section = cell?.querySelector<HTMLElement>(".board-widget");
      expect(section?.getAttribute("style")).toContain("height: 10026px");
      expect(section?.getAttribute("style")).toContain("span 148");
    });
  });

  it("pins preset resizing and toggles height mode from the menu", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount({ callbacks: callbacks({ applyOps }) });
    const menu = view.querySelector(".board-widget__menu");
    const preset = view.querySelector('wa-dropdown-item[value="resize:sm"]');
    menu?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: preset }, bubbles: true }));
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([
        {
          kind: "widget_resize",
          name: "alpha",
          sizeW: 3,
          sizeH: 3,
          heightMode: "fixed",
        },
      ]),
    );
    const cell = view.querySelector("openclaw-board-widget-cell");
    await vi.waitFor(() => expect(Reflect.get(cell ?? {}, "actionPending")).toBe(false));

    // The menu item is a checkbox toggle: an auto widget pins to its current
    // effective height, a fixed widget returns to auto.
    const auto = view.querySelector('wa-dropdown-item[value="height:auto"]');
    menu?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: auto }, bubbles: true }));
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenLastCalledWith([
        {
          kind: "widget_resize",
          name: "alpha",
          sizeW: 6,
          sizeH: 4,
          heightMode: "fixed",
        },
      ]),
    );
  });

  it("returns a pinned widget to automatic height from the menu", async () => {
    const applyOps = vi.fn(async () => undefined);
    const view = await mount({
      snapshot: snapshot({ widgets: [boardWidget({ heightMode: "fixed" })] }),
      callbacks: callbacks({ applyOps }),
    });
    const menu = view.querySelector(".board-widget__menu");
    const auto = view.querySelector('wa-dropdown-item[value="height:auto"]');
    expect(auto?.hasAttribute("checked")).toBe(false);
    menu?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: auto }, bubbles: true }));
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenLastCalledWith([
        {
          kind: "widget_resize",
          name: "alpha",
          sizeW: 6,
          sizeH: 4,
          heightMode: "auto",
        },
      ]),
    );
  });
});
