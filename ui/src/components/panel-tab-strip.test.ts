/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  panelTabStripStyles,
  renderPanelTabStrip,
  type PanelTabStripTab,
} from "./panel-tab-strip.ts";

const TAB: PanelTabStripTab = {
  id: "tab-1",
  domId: "test-tab-1",
  label: "First tab",
  closeLabel: "Close tab: First tab",
};

function renderStrip(options: {
  tabs?: PanelTabStripTab[];
  activeId?: string | null;
  onClose?: (id: string) => void;
  onNew?: () => void;
  onReorder?: (sourceId: string, targetId: string, placement: "before" | "after") => void;
  onSelect?: (id: string) => void;
  container?: HTMLDivElement;
}) {
  const container = options.container ?? document.createElement("div");
  render(
    renderPanelTabStrip({
      tabs: options.tabs ?? [],
      activeId: options.activeId ?? options.tabs?.[0]?.id ?? null,
      ariaControls: "test-tab-panel",
      onSelect: options.onSelect ?? vi.fn(),
      onClose: options.onClose ?? vi.fn(),
      onNew: options.onNew ?? vi.fn(),
      onReorder: options.onReorder,
      newLabel: "New tab",
    }),
    container,
  );
  return container;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("renderPanelTabStrip", () => {
  it("keeps the new-tab control from shrinking when the strip overflows", () => {
    expect(panelTabStripStyles.cssText).toMatch(/\.tabstrip-new\s*\{[^}]*flex:\s*none/u);
  });

  it("renders an unslotted new button without an empty tab group", () => {
    const onNew = vi.fn();
    const container = renderStrip({ onNew });

    expect(container.querySelector("wa-tab-group")).toBeNull();
    const button = container.querySelector<HTMLButtonElement>(".tabstrip-new");
    expect(button?.hasAttribute("slot")).toBe(false);
    button?.click();
    expect(onNew).toHaveBeenCalledOnce();
  });

  it("slots the new button into a nonempty tab group", () => {
    const container = renderStrip({ tabs: [TAB] });

    expect(container.querySelector("wa-tab-group")).not.toBeNull();
    expect(container.querySelector(".tabstrip-new")?.getAttribute("slot")).toBe("nav");
  });

  it("closes the requested tab from its labeled close button", () => {
    const onClose = vi.fn();
    const container = renderStrip({ tabs: [TAB], onClose });
    const closeButton = container.querySelector<HTMLButtonElement>(".tabstrip-tab__close");

    expect(closeButton?.getAttribute("aria-label")).toBe(TAB.closeLabel);
    closeButton?.click();
    expect(onClose).toHaveBeenCalledWith(TAB.id);
  });

  it("keeps only the active tab close action in the keyboard order", () => {
    const container = renderStrip({
      tabs: [TAB, { ...TAB, id: "tab-2", domId: "test-tab-2", label: "Second tab" }],
      activeId: "tab-2",
    });
    const closeButtons = [...container.querySelectorAll<HTMLButtonElement>(".tabstrip-tab__close")];

    expect(closeButtons.map((button) => button.tabIndex)).toEqual([-1, 0]);
  });

  it("closes a tab on middle click", () => {
    const onClose = vi.fn();
    const container = renderStrip({ tabs: [TAB], onClose });

    container.querySelector("wa-tab")?.dispatchEvent(new MouseEvent("auxclick", { button: 1 }));
    expect(onClose).toHaveBeenCalledWith(TAB.id);
  });

  it("reorders draggable tabs at the requested edge", () => {
    const onReorder = vi.fn();
    const container = renderStrip({
      tabs: [TAB, { ...TAB, id: "tab-2", domId: "test-tab-2", label: "Second tab" }],
      onReorder,
    });
    const [source, target] = [...container.querySelectorAll<HTMLElement>("wa-tab")];
    const values = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      getData: (type: string) => values.get(type) ?? "",
      setData: (type: string, value: string) => values.set(type, value),
    };
    const dispatchDrag = (element: HTMLElement, type: string, clientX: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      element.dispatchEvent(event);
    };
    vi.spyOn(target!, "getBoundingClientRect").mockReturnValue({
      left: 100,
      width: 80,
    } as DOMRect);

    dispatchDrag(source!, "dragstart", 0);
    dispatchDrag(target!, "dragover", 110);
    dispatchDrag(target!, "drop", 110);

    expect(source?.draggable).toBe(true);
    expect(onReorder).toHaveBeenCalledWith("tab-1", "tab-2", "before");
  });
});
