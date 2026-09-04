/* @vitest-environment jsdom */

import { html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../components/resizable-divider.ts";
import {
  openSlot,
  closeSlot,
  promoteSidebarPanel,
  setSidebarOpen,
  setSidebarDock,
  setSidebarExpanded,
  type SidebarLayout,
} from "../sidebar-layout.ts";
import "./chat-sidebar-region.runtime.ts";

type Region = HTMLElementTagNameMap["openclaw-chat-sidebar-region"] & {
  updateComplete: Promise<unknown>;
};

const regions: Region[] = [];

async function createRegion(layout: SidebarLayout = openSlot({ columns: [] }, "detail")) {
  const shell = document.createElement("div");
  shell.className = "sidebar-region";
  const region = document.createElement("openclaw-chat-sidebar-region") as Region;
  region.layout = layout;
  region.panelTemplates = {
    detail: html`<div data-panel="detail">Detail panel</div>`,
    terminal: html`<div data-panel="terminal">Terminal panel</div>`,
    workspace: html`<div data-panel="workspace">Workspace panel</div>`,
  };
  region.availableSlots = ["detail", "terminal", "workspace", "companion"];
  region.callbacks = {
    activatePanel: vi.fn(),
    closeSlot: vi.fn(),
    openSlot: vi.fn(),
    appendComposerText: vi.fn(),
    reorderPanel: vi.fn(),
    resizePanel: vi.fn(),
    setExpanded: vi.fn(),
    setOpen: vi.fn(),
  };
  region.availableWidth = 1_200;
  const primary = document.createElement("div");
  primary.className = "sidebar-region__primary";
  primary.dataset.region = "main";
  primary.innerHTML = "<main data-primary>Primary</main>";
  const rightRuntime = document.createElement("div");
  rightRuntime.className = "sidebar-region__right-runtime";
  shell.append(region, primary, rightRuntime);
  document.body.append(shell);
  regions.push(region);
  await region.updateComplete;
  return region;
}

function root(region: Region): HTMLElement {
  return region.parentElement!;
}

afterEach(() => {
  for (const region of regions.splice(0)) {
    region.parentElement?.remove();
  }
});

describe("chat sidebar region", () => {
  it("renders all open types as one tab strip and keeps inactive panels mounted", async () => {
    const layout = openSlot(openSlot(openSlot({ columns: [] }, "detail"), "terminal"), "workspace");
    const region = await createRegion(layout);

    expect(root(region).querySelectorAll(".side-panel")).toHaveLength(1);
    expect(
      Array.from(root(region).querySelectorAll(".tabstrip-tab__label"), (node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Review", "Terminal", "Files"]);
    expect(
      root(region).querySelector('[data-panel-slot="workspace"]')?.hasAttribute("hidden"),
    ).toBe(false);
    expect(root(region).querySelector('[data-panel-slot="detail"]')?.hasAttribute("hidden")).toBe(
      true,
    );
    expect(root(region).querySelector('[data-panel="detail"]')).not.toBeNull();
  });

  it("renders only the active panel's supplied header action", async () => {
    const onClear = vi.fn();
    const region = await createRegion(openSlot(openSlot({ columns: [] }, "detail"), "companion"));
    region.panelActions = {
      companion: html`<button class="chat-session-rail__clear" type="button" @click=${onClear}>
        Clear
      </button>`,
    };
    await region.updateComplete;

    const actions = root(region).querySelector(".side-panel__action-group--content");
    const clear = actions?.querySelector<HTMLButtonElement>("button.chat-session-rail__clear");
    expect(clear).not.toBeNull();
    clear?.click();
    expect(onClear).toHaveBeenCalledOnce();

    // Actions belong to the active panel only: the Side chat action must not
    // survive a switch to a tab that owns no header action.
    const detail = region.layout.columns[0]!.panels[0]!;
    region.layout = {
      ...region.layout,
      columns: [{ ...region.layout.columns[0]!, activePanelId: detail.id }],
    };
    await region.updateComplete;
    expect(root(region).querySelector("button.chat-session-rail__clear")).toBeNull();
  });

  it("routes tab selection and individual close through the canonical callbacks", async () => {
    const region = await createRegion(openSlot(openSlot({ columns: [] }, "detail"), "terminal"));
    const detail = region.layout.columns[0]!.panels[0]!;
    root(region)
      .querySelector(`wa-tab[panel="${detail.id}"]`)
      ?.dispatchEvent(
        new CustomEvent("wa-tab-show", { bubbles: true, detail: { name: detail.id } }),
      );
    root(region).querySelector<HTMLButtonElement>('button[aria-label="Close Review"]')?.click();

    expect(region.callbacks?.activatePanel).toHaveBeenCalledWith(detail.id);
    expect(region.callbacks?.closeSlot).toHaveBeenCalledWith("detail");
  });

  it("renders one separator per gap so the active tab never reflows the row", async () => {
    const region = await createRegion(
      openSlot(openSlot(openSlot({ columns: [] }, "detail"), "terminal"), "workspace"),
    );

    const separators = root(region).querySelectorAll(".tabstrip-separator");
    expect(separators).toHaveLength(2);
    for (const separator of separators) {
      expect(separator.previousElementSibling?.classList.contains("tabstrip-tab__close")).toBe(
        true,
      );
      expect(separator.nextElementSibling?.classList.contains("tabstrip-tab")).toBe(true);
    }
  });

  it("delivers typed requests to the mounted panel owner", async () => {
    const handleToggleRequest = vi.fn();
    const region = await createRegion(openSlot({ columns: [] }, "terminal"));
    region.panelTemplates = {
      terminal: html`<div .handleToggleRequest=${handleToggleRequest}>Terminal panel</div>`,
    };
    await region.updateComplete;
    const event = new CustomEvent("openclaw:terminal-toggle", {
      detail: { catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "thread-1" } },
    });

    expect(region.deliverPanelEvent("terminal", event)).toBe(true);
    expect(handleToggleRequest).toHaveBeenCalledWith(event);
  });

  it("opens a type from the plus menu and shows only established shortcuts", async () => {
    const region = await createRegion();
    const dropdown = root(region).querySelector(".side-panel-type-menu");
    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        detail: { item: { value: "terminal" } },
      }),
    );

    expect(region.callbacks?.openSlot).toHaveBeenCalledWith("terminal");
    expect(
      Array.from(root(region).querySelectorAll(".side-panel-type-option__shortcut"), (node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Ctrl+`", "Ctrl+Shift+B", "Ctrl+Shift+S"]);
    const reviewItem = Array.from(
      root(region).querySelectorAll<HTMLElement>("wa-dropdown-item"),
    ).find((item) => Reflect.get(item, "value") === "detail");
    expect(reviewItem).toBeUndefined();
    expect(root(region).querySelector("wa-dropdown-item[disabled]")).toBeNull();
  });

  it("keeps Browser available in the plus menu to start another browser tab", async () => {
    const handleToggleRequest = vi.fn();
    const region = await createRegion(openSlot({ columns: [] }, "browser"));
    region.panelTemplates = {
      browser: html`<div .handleToggleRequest=${handleToggleRequest}>Browser panel</div>`,
    };
    region.availableSlots = [...region.availableSlots, "browser"];
    await region.updateComplete;
    const browserItem = Array.from(
      root(region).querySelectorAll<HTMLElement>("wa-dropdown-item"),
    ).find((item) => Reflect.get(item, "value") === "browser");

    expect(browserItem).toBeDefined();
    root(region)
      .querySelector(".side-panel-type-menu")
      ?.dispatchEvent(
        new CustomEvent("wa-select", {
          bubbles: true,
          detail: { item: { value: "browser" } },
        }),
      );

    expect(region.callbacks?.openSlot).toHaveBeenCalledWith("browser");
    expect(handleToggleRequest).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { open: true, newTab: true } }),
    );
  });

  it("opens into a type selector instead of restoring a previous tab", async () => {
    const region = await createRegion(setSidebarOpen({ columns: [], expanded: false }, true));
    const selector = root(region).querySelector(".side-panel-empty--selector");

    expect(selector?.querySelector(".side-panel-empty__title")).toBeNull();
    expect(selector?.querySelector(".side-panel-empty__description")).toBeNull();
    expect(selector?.querySelector(":scope > .side-panel-empty__icon")).toBeNull();
    expect(
      Array.from(selector?.querySelectorAll(".side-panel-empty__type") ?? [], (item) =>
        item.textContent?.replace(/\s+/gu, " ").trim(),
      ),
    ).toEqual([
      "Review",
      "Terminal Ctrl+`",
      "Files Ctrl+Shift+B",
      "Side chat Ctrl+Shift+S",
      "Dashboard",
    ]);
    root(region).querySelector<HTMLButtonElement>(".side-panel-empty__type")?.click();
    expect(region.callbacks?.openSlot).toHaveBeenCalledWith("detail");

    const dashboard = Array.from(
      root(region).querySelectorAll<HTMLButtonElement>(".side-panel-empty__type"),
    ).find((button) => button.textContent?.trim() === "Dashboard");
    dashboard?.click();
    expect(region.callbacks?.appendComposerText).toHaveBeenCalledWith("/dashboard ");
    expect(region.callbacks?.openSlot).not.toHaveBeenCalledWith("dashboard");
  });

  it("gives every surface the shared icon, title, and description empty state", async () => {
    const region = await createRegion(openSlot({ columns: [] }, "companion"));
    region.panelTemplates = {};

    for (const [slot, label] of [
      ["detail", "Review"],
      ["browser", "Browser"],
      ["terminal", "Terminal"],
      ["workspace", "Files"],
      ["companion", "Side chat"],
      ["tasks", "Tasks"],
      ["discussion", "Discussion"],
    ] as const) {
      region.layout = openSlot({ columns: [] }, slot);
      await region.updateComplete;
      const empty = root(region).querySelector(".side-panel-empty--type");
      const state = empty?.querySelector("openclaw-panel-empty-state");
      await (state as HTMLElement & { updateComplete?: Promise<unknown> })?.updateComplete;
      expect(state?.querySelector("svg")).not.toBeNull();
      expect(state?.shadowRoot?.querySelector(".empty-state__title")?.textContent).toBe(label);
      expect(
        state?.shadowRoot?.querySelector(".empty-state__description")?.textContent?.trim(),
      ).not.toBe("");
    }
  });

  it("offers every chat-side content owner through the shared type menu", async () => {
    const region = await createRegion();
    region.availableSlots = [
      "detail",
      "terminal",
      "browser",
      "workspace",
      "companion",
      "tasks",
      "desktop",
      "discussion",
      "dashboard",
    ];
    await region.updateComplete;

    expect(
      Array.from(root(region).querySelectorAll(".side-panel-type-menu__item"), (item) =>
        item.textContent?.replace(/\s+/gu, " ").trim(),
      ),
    ).toEqual([
      "Terminal Ctrl+`",
      "Browser",
      "Files Ctrl+Shift+B",
      "Side chat Ctrl+Shift+S",
      "Tasks",
      "Desktop",
      "Discussion",
      "Dashboard",
    ]);

    const browserMenuItem = Array.from(
      root(region).querySelectorAll<HTMLElement>(".side-panel-type-menu__item"),
    ).find((item) => Reflect.get(item, "value") === "browser");
    expect(browserMenuItem?.querySelector('path[d="M2 12h20"]')).not.toBeNull();

    region.layout = openSlot({ columns: [] }, "browser");
    await region.updateComplete;
    expect(root(region).querySelector('.tabstrip-tab__icon path[d="M2 12h20"]')).not.toBeNull();

    region.layout = { columns: [], open: true };
    await region.updateComplete;
    const browserEmptyItem = Array.from(
      root(region).querySelectorAll<HTMLElement>(".side-panel-empty__type"),
    ).find((item) => item.textContent?.trim() === "Browser");
    expect(browserEmptyItem?.querySelector('path[d="M2 12h20"]')).not.toBeNull();
  });

  it("focuses or restores main and dismisses the side panel independently", async () => {
    const region = await createRegion();
    root(region).querySelector<HTMLButtonElement>(".side-panel__expand")?.click();
    root(region)
      .querySelector<HTMLButtonElement>('[data-region-header="side"] .side-panel__minimize')
      ?.click();
    expect(region.callbacks?.setExpanded).toHaveBeenCalledWith(true);
    expect(region.callbacks?.setOpen).toHaveBeenCalledWith(false);

    region.layout = setSidebarExpanded(promoteSidebarPanel(region.layout, "detail"), true);
    await region.updateComplete;
    const collapse = root(region).querySelector<HTMLButtonElement>(".side-panel__expand");
    expect(collapse?.getAttribute("aria-label")).toBe("Restore split");
    expect(root(region).querySelector('[data-region-header="main"]')?.textContent).toContain(
      "Review",
    );
    expect(
      Array.from(root(region).querySelectorAll(".tabstrip-tab__label"), (node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Chat"]);
    collapse?.click();
    expect(region.callbacks?.setExpanded).toHaveBeenLastCalledWith(false);
    root(region)
      .querySelector<HTMLButtonElement>('[data-region-header="main"] .side-panel__minimize')
      ?.click();
    expect(region.callbacks?.setOpen).toHaveBeenLastCalledWith(true);
    region.layout = setSidebarExpanded(region.layout, false);
    await region.updateComplete;
    root(region)
      .querySelector<HTMLButtonElement>('[data-region-header="main"] .side-panel__minimize')
      ?.click();
    expect(region.callbacks?.setOpen).toHaveBeenLastCalledWith(false);
  });

  it("offers main focus and side dismissal while the tab selector is empty", async () => {
    const region = await createRegion(setSidebarOpen({ columns: [] }, true));
    expect(root(region).querySelector("resizable-divider")).not.toBeNull();
    root(region).querySelector<HTMLButtonElement>(".side-panel__expand")?.click();
    root(region)
      .querySelector<HTMLButtonElement>('[data-region-header="side"] .side-panel__minimize')
      ?.click();
    expect(region.callbacks?.setExpanded).toHaveBeenCalledWith(true);
    expect(region.callbacks?.setOpen).toHaveBeenCalledWith(false);
  });

  it("uses one inherited divider and reports bounded panel width", async () => {
    const region = await createRegion();
    const primary = root(region).querySelector<HTMLElement>(".sidebar-region__primary")!;
    const panel = root(region).querySelector<HTMLElement>('[data-region="side"]:not([hidden])')!;
    const divider = root(region).querySelector<HTMLElement>("resizable-divider")!;
    primary.getBoundingClientRect = () => ({ width: 800 }) as DOMRect;
    panel.getBoundingClientRect = () => ({ width: 360 }) as DOMRect;
    divider.dispatchEvent(
      new CustomEvent("resize", { bubbles: true, detail: { splitRatio: 0.5 } }),
    );
    expect(region.callbacks?.resizePanel).toHaveBeenCalledWith(region.layout.columns[0]!.id, 580);
  });

  it("docks and resizes the same panel across left, right, and bottom layouts", async () => {
    const region = await createRegion(
      setSidebarDock(openSlot({ columns: [] }, "detail"), "bottom"),
    );
    const primary = root(region).querySelector<HTMLElement>(".sidebar-region__primary")!;
    const panel = root(region).querySelector<HTMLElement>('[data-region="side"]:not([hidden])')!;
    const divider = root(region).querySelector<HTMLElement & { orientation: string }>(
      "resizable-divider",
    )!;
    primary.getBoundingClientRect = () => ({ height: 440 }) as DOMRect;
    panel.getBoundingClientRect = () => ({ height: 360 }) as DOMRect;
    root(region).getBoundingClientRect = () => ({ height: 800 }) as DOMRect;

    expect(divider.orientation).toBe("horizontal");
    divider.dispatchEvent(
      new CustomEvent("resize", { bubbles: true, detail: { splitRatio: 0.5 } }),
    );
    expect(region.callbacks?.resizePanel).toHaveBeenCalledWith(region.layout.columns[0]!.id, 400);
    region.layout = setSidebarDock(region.layout, "left");
    await region.updateComplete;
    primary.getBoundingClientRect = () => ({ width: 800 }) as DOMRect;
    panel.getBoundingClientRect = () => ({ width: 400 }) as DOMRect;
    const leftDivider = root(region).querySelector<HTMLElement & { orientation: string }>(
      "resizable-divider",
    )!;
    expect(leftDivider.orientation).toBe("vertical");
    leftDivider.dispatchEvent(
      new CustomEvent("resize", { bubbles: true, detail: { splitRatio: 0.25 } }),
    );
    expect(region.callbacks?.resizePanel).toHaveBeenLastCalledWith(
      region.layout.columns[0]!.id,
      300,
    );
  });

  it("retains hidden side content and main controls when the side panel is minimized", async () => {
    const layout = promoteSidebarPanel(
      openSlot(openSlot({ columns: [] }, "detail"), "terminal"),
      "detail",
    );
    const region = await createRegion(setSidebarOpen(layout, false));
    expect(root(region).querySelector('[data-panel-slot="terminal"]')?.hasAttribute("hidden")).toBe(
      true,
    );
    expect(root(region).querySelector('[data-panel="terminal"]')).not.toBeNull();
    expect(root(region).querySelector('[data-panel-slot="detail"]')?.hasAttribute("hidden")).toBe(
      false,
    );
    expect(root(region).querySelector("resizable-divider")).toBeNull();
    expect(root(region).querySelector('[data-region-header="main"]')).not.toBeNull();
    expect(root(region).querySelector("[data-primary]")).not.toBeNull();
  });

  it("retains app input and terminal content while minimizing until their tabs close", async () => {
    const region = await createRegion(
      setSidebarOpen(openSlot(openSlot({ columns: [] }, "terminal"), "dashboard"), false),
    );
    region.panelTemplates = {
      ...region.panelTemplates,
      dashboard: html`<input aria-label="Unsaved app input" />`,
    };
    await region.updateComplete;
    expect(root(region).querySelector('[data-panel-slot="dashboard"]')).toBeNull();
    region.layout = setSidebarOpen(region.layout, true);
    await region.updateComplete;
    const input = root(region).querySelector<HTMLInputElement>("input")!;
    input.value = "Unsaved note";
    const terminal = root(region).querySelector('[data-panel="terminal"]')!;

    region.layout = setSidebarOpen(region.layout, false);
    await region.updateComplete;
    const panel = root(region).querySelector<HTMLElement>('[data-panel-slot="dashboard"]')!;
    expect(panel.hidden).toBe(true);
    expect(root(region).querySelector("resizable-divider")).toBeNull();
    expect(input.isConnected).toBe(true);
    expect(terminal.isConnected).toBe(true);
    expect(root(region).querySelector<HTMLElement>('[data-panel-slot="terminal"]')?.hidden).toBe(
      true,
    );

    region.layout = setSidebarOpen(region.layout, true);
    await region.updateComplete;
    expect(root(region).querySelector("input")).toBe(input);
    expect(input.value).toBe("Unsaved note");
    expect(panel.hidden).toBe(false);
    expect(root(region).querySelector('[data-panel="terminal"]')).toBe(terminal);

    region.layout = closeSlot(region.layout, "dashboard");
    await region.updateComplete;
    expect(input.isConnected).toBe(false);
    expect(root(region).querySelector('[data-panel="terminal"]')).toBe(terminal);
    expect(root(region).querySelector<HTMLElement>('[data-panel-slot="terminal"]')?.hidden).toBe(
      false,
    );
  });
});
