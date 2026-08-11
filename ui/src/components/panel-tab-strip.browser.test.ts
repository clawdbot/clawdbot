import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  panelTabStripStyles,
  renderPanelTabStrip,
  type PanelTabStripTab,
} from "./panel-tab-strip.ts";

type RenderedTab = HTMLElement & {
  active: boolean;
  panel: string;
};

type RenderedTabGroup = HTMLElement & {
  active: string;
};

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

function tab(id: string): PanelTabStripTab {
  return {
    id,
    domId: `browser-test-tab-${id}`,
    label: `Tab ${id.toUpperCase()}`,
    closeLabel: `Close tab ${id.toUpperCase()}`,
  };
}

function renderControlledStrip(params: {
  container: HTMLElement | DocumentFragment;
  tabs: PanelTabStripTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void | Promise<void>;
}) {
  render(
    renderPanelTabStrip({
      tabs: params.tabs,
      activeId: params.activeId,
      ariaControls: "browser-test-panel",
      onSelect: params.onSelect,
      onClose: params.onClose ?? vi.fn(),
      onNew: vi.fn(),
      newLabel: "New tab",
    }),
    params.container,
  );
}

function renderedTabs(container: ParentNode): RenderedTab[] {
  return [...container.querySelectorAll<RenderedTab>("wa-tab")];
}

async function expectControlledSelection(
  container: ParentNode,
  activeId: string,
): Promise<RenderedTab> {
  let active: RenderedTab | undefined;
  await vi.waitFor(() => {
    const tabs = renderedTabs(container);
    const selected = tabs.filter(
      (candidate) =>
        candidate.active ||
        candidate.hasAttribute("active") ||
        candidate.getAttribute("aria-selected") === "true",
    );
    active = tabs.find((candidate) => candidate.panel === activeId);
    expect(selected).toEqual([active]);
    expect(active?.tabIndex).toBe(0);
    expect(
      tabs
        .filter((candidate) => candidate.panel !== activeId)
        .every((candidate) => candidate.tabIndex === -1),
    ).toBe(true);
  });
  return active!;
}

afterEach(() => {
  document.body.replaceChildren();
  document.querySelector("#panel-tab-strip-browser-test-styles")?.remove();
});

describe.skipIf(!hasBrowserLayout)("panel tab strip browser lifecycle", () => {
  it("preserves the focused active element when tabs reorder", async () => {
    const host = document.createElement("div");
    const container = host.attachShadow({ mode: "open" });
    document.body.append(host);
    const tabs = [tab("a"), tab("b"), tab("c")];
    renderControlledStrip({ container, tabs, activeId: "b", onSelect: vi.fn() });
    const initialActive = await expectControlledSelection(container, "b");
    initialActive.focus();
    expect(document.activeElement).toBe(host);
    expect(container.activeElement).toBe(initialActive);

    queueMicrotask(() => initialActive.blur());
    renderControlledStrip({
      container,
      tabs: [tabs[2]!, { ...tabs[1]!, label: "Tab B navigated" }, tabs[0]!],
      activeId: "b",
      onSelect: vi.fn(),
    });
    const reorderedActive = await expectControlledSelection(container, "b");

    expect(reorderedActive).toBe(initialActive);
    await vi.waitFor(() => expect(container.activeElement).toBe(initialActive));

    renderControlledStrip({
      container,
      tabs: [tabs[2]!, tab("d"), tabs[1]!, tabs[0]!],
      activeId: "b",
      onSelect: vi.fn(),
    });
    const insertedActive = await expectControlledSelection(container, "b");
    expect(insertedActive).toBe(initialActive);
    expect(container.activeElement).toBe(initialActive);
  });

  it("keeps arrow and mouse activation controlled and the selected overflow tab visible", async () => {
    const style = document.createElement("style");
    style.id = "panel-tab-strip-browser-test-styles";
    style.textContent = panelTabStripStyles.cssText;
    document.head.append(style);
    const container = document.createElement("div");
    container.style.width = "220px";
    document.body.append(container);
    const tabs = Array.from({ length: 8 }, (_, index) => tab(String(index + 1)));
    let activeId = "4";
    const onSelect = vi.fn((nextId: string) => {
      activeId = nextId;
      renderControlledStrip({ container, tabs, activeId, onSelect });
    });
    renderControlledStrip({ container, tabs, activeId, onSelect });
    const initialActive = await expectControlledSelection(container, activeId);
    initialActive.focus();
    initialActive.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        composed: true,
      }),
    );
    await vi.waitFor(() => expect(activeId).toBe("5"));
    const arrowActive = await expectControlledSelection(container, activeId);
    expect(document.activeElement).toBe(arrowActive);

    const last = renderedTabs(container).find((candidate) => candidate.panel === "8");
    last?.click();
    await vi.waitFor(() => expect(activeId).toBe("8"));
    const lastActive = await expectControlledSelection(container, activeId);
    const group = container.querySelector<RenderedTabGroup>("wa-tab-group");
    const nav = group?.shadowRoot?.querySelector<HTMLElement>(".nav");
    if (!group || !nav) {
      throw new Error("expected rendered tab group navigation");
    }
    await new Promise(requestAnimationFrame);
    const navRect = nav.getBoundingClientRect();
    const activeRect = lastActive.getBoundingClientRect();

    expect(nav.scrollWidth).toBeGreaterThan(nav.clientWidth);
    expect(activeRect.left).toBeGreaterThanOrEqual(navRect.left - 1);
    expect(activeRect.right).toBeLessThanOrEqual(navRect.right + 1);
  });

  it("moves focus to the selected fallback when the focused tab is closed", async () => {
    let container = document.createElement("div");
    document.body.append(container);
    const close = createDeferred();
    let tabs = [tab("a"), tab("b")];
    let activeId = "a";
    const onSelect = vi.fn();
    const onClose = vi.fn((closedId: string) =>
      close.promise.then(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        tabs = tabs.filter((entry) => entry.id !== closedId);
        activeId = tabs[0]?.id ?? "";
        const replacement = document.createElement("div");
        container.replaceWith(replacement);
        container = replacement;
        renderControlledStrip({ container, tabs, activeId, onSelect, onClose });
      }),
    );
    renderControlledStrip({ container, tabs, activeId, onSelect, onClose });
    await expectControlledSelection(container, activeId);
    const closeButton = container.querySelector<HTMLButtonElement>(".tabstrip-tab__close");
    closeButton?.focus();
    expect(document.activeElement).toBe(closeButton);

    closeButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    closeButton?.blur();
    closeButton?.click();
    close.resolve();
    await close.promise;
    await Promise.resolve();

    const fallback = await expectControlledSelection(container, activeId);
    const group = container.querySelector<RenderedTabGroup & { updateComplete: Promise<boolean> }>(
      "wa-tab-group",
    );
    await group?.updateComplete;
    await new Promise(requestAnimationFrame);
    expect(document.activeElement).toBe(fallback);
  });
});
