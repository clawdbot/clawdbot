/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
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
  onClose?: (id: string) => void;
  onNew?: () => void;
}) {
  const container = document.createElement("div");
  render(
    renderPanelTabStrip({
      tabs: options.tabs ?? [],
      activeId: options.tabs?.[0]?.id ?? null,
      ariaControls: "test-tab-panel",
      onSelect: vi.fn(),
      onClose: options.onClose ?? vi.fn(),
      onNew: options.onNew ?? vi.fn(),
      newLabel: "New tab",
    }),
    container,
  );
  return container;
}

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

  it("closes a tab on middle click", () => {
    const onClose = vi.fn();
    const container = renderStrip({ tabs: [TAB], onClose });

    container.querySelector("wa-tab")?.dispatchEvent(new MouseEvent("auxclick", { button: 1 }));
    expect(onClose).toHaveBeenCalledWith(TAB.id);
  });
});
