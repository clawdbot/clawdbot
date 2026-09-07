/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
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
  document.documentElement.removeAttribute("dir");
  Reflect.deleteProperty(customElements.get("wa-tab-group")?.prototype ?? {}, "updateComplete");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  it("reports user selection without echoing controlled selection changes", () => {
    const onSelect = vi.fn();
    const tabs = [TAB, { ...TAB, id: "tab-2", domId: "test-tab-2" }];
    const container = renderStrip({ tabs, onSelect });
    const group = container.querySelector("wa-tab-group")!;
    const show = (name: string) =>
      group.dispatchEvent(new CustomEvent("wa-tab-show", { detail: { name } }));

    show(TAB.id);
    expect(onSelect).not.toHaveBeenCalled();
    show("tab-2");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("tab-2");
    renderStrip({ tabs, onSelect, container, activeId: "tab-2" });
    show("tab-2");
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("closes the requested tab from its labeled close button", () => {
    const onClose = vi.fn();
    const container = renderStrip({ tabs: [TAB], onClose });
    const closeButton = container.querySelector<HTMLButtonElement>(".tabstrip-tab__close");

    expect(closeButton?.hasAttribute("title")).toBe(false);
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

  // The scroll-edge ref installs its listener and observer after awaiting the
  // group's first render. Every render swaps the ref, so a swap inside that
  // window must cancel the pending install: otherwise each render leaves one
  // more live listener and observer that no cleanup can ever reach.
  it("keeps one live scroll-edge listener no matter how many renders race", async () => {
    const gate = createDeferred<boolean>();
    const groupPrototype = customElements.get("wa-tab-group")?.prototype;
    expect(groupPrototype).toBeDefined();
    Object.defineProperty(groupPrototype!, "updateComplete", {
      configurable: true,
      get: () => gate.promise,
    });

    const observers: { target: Element | null; live: boolean }[] = [];
    class CountingResizeObserver {
      private readonly record = { target: null as Element | null, live: true };
      constructor(_callback: ResizeObserverCallback) {
        observers.push(this.record);
      }
      observe(target: Element) {
        this.record.target = target;
      }
      unobserve() {}
      disconnect() {
        this.record.live = false;
      }
    }
    vi.stubGlobal("ResizeObserver", CountingResizeObserver);

    const container = document.createElement("div");
    document.body.append(container);
    const tabs = [TAB, { ...TAB, id: "tab-2", domId: "test-tab-2", label: "Second tab" }];
    const renderCount = 4;
    for (let index = 0; index < renderCount; index += 1) {
      renderStrip({ tabs, container });
    }

    const group = container.querySelector<
      HTMLElement & { getUpdateComplete?: () => Promise<unknown> }
    >("wa-tab-group");
    expect(group).not.toBeNull();
    await group?.getUpdateComplete?.();
    const scroller = group?.shadowRoot?.querySelector<HTMLElement>('[part~="tabs"]');
    expect(scroller).toBeDefined();
    const added = vi.spyOn(scroller!, "addEventListener");
    const removed = vi.spyOn(scroller!, "removeEventListener");

    gate.resolve(true);
    await gate.promise;
    await Promise.resolve();

    const scrollListeners = (spy: typeof added) =>
      spy.mock.calls.filter(([type]) => type === "scroll").length;
    expect(scrollListeners(added) - scrollListeners(removed)).toBe(1);
    expect(observers.filter((entry) => entry.live && entry.target === scroller)).toHaveLength(1);
  });

  // "before"/"after" are array order, so the physical half that means "before"
  // flips with the writing direction. Both rows exercise the same pointer x.
  it.each([
    { dir: "ltr", placement: "before" },
    { dir: "rtl", placement: "after" },
  ])("reorders draggable tabs at the requested edge ($dir)", ({ dir, placement }) => {
    document.documentElement.setAttribute("dir", dir);
    const onReorder = vi.fn();
    // Direction is inherited, so the strip has to be in the document for
    // getComputedStyle to report the writing direction under test.
    const host = document.createElement("div");
    document.body.append(host);
    const container = renderStrip({
      tabs: [TAB, { ...TAB, id: "tab-2", domId: "test-tab-2", label: "Second tab" }],
      onReorder,
      container: host,
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
    // The indicator must preview the same edge the drop will use; `drop` clears
    // it, so the class is read while the drag is still over the target.
    const previewed = target?.classList.contains(`is-drop-${placement}`);
    dispatchDrag(target!, "drop", 110);

    expect(source?.draggable).toBe(true);
    expect(previewed).toBe(true);
    expect(onReorder).toHaveBeenCalledWith("tab-1", "tab-2", placement);
  });
});
