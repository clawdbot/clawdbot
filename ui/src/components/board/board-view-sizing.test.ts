import { afterEach, describe, expect, it, vi } from "vitest";
import { effectiveBoardWidgetRows } from "../../lib/board/grid.ts";
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
    expect(effectiveBoardWidgetRows(card, 100)).toBe(2);
    expect(effectiveBoardWidgetRows(card, 101)).toBe(3);
    expect(effectiveBoardWidgetRows({ ...card, presentation: "full-bleed" }, 124)).toBe(2);
    expect(effectiveBoardWidgetRows({ ...card, presentation: "frameless" }, 125)).toBe(3);
    expect(effectiveBoardWidgetRows(card, 1)).toBe(2);
    expect(effectiveBoardWidgetRows(card, 10_000)).toBe(20);
    expect(effectiveBoardWidgetRows({ ...card, heightMode: "fixed" }, 600)).toBe(6);
    expect(effectiveBoardWidgetRows(card, undefined)).toBe(6);
    expect(effectiveBoardWidgetRows({ ...card, contentKind: "mcp-app" }, 600)).toBe(6);
    // Coarse-pointer layouts keep the 38px bar in flow; the same report needs
    // more rows than the fine-pointer overlay layout.
    expect(effectiveBoardWidgetRows(card, 101, 38)).toBe(3);
    expect(effectiveBoardWidgetRows(card, 150, 38)).toBe(4);
    expect(effectiveBoardWidgetRows(card, 150, 0)).toBe(3);
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
