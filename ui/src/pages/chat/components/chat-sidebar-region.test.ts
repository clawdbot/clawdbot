/* @vitest-environment jsdom */

import { html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../components/resizable-divider.ts";
import { openSlot, setSidebarExpanded, type SidebarLayout } from "../sidebar-layout.ts";
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
    resizeColumn: vi.fn(),
    setExpanded: vi.fn(),
    setOpen: vi.fn(),
  };
  region.availableWidth = 1_200;
  const primary = document.createElement("div");
  primary.className = "sidebar-region__primary";
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
    const dropdown = root(region).querySelector("wa-dropdown");
    dropdown?.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        detail: { item: { value: "terminal" } },
      }),
    );

    expect(region.callbacks?.openSlot).toHaveBeenCalledWith("terminal");
    expect(
      Array.from(root(region).querySelectorAll(".side-panel-type-menu__shortcut"), (node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Ctrl+`", "⇧⌘B"]);
    const reviewLabel = Array.from(
      root(region).querySelectorAll(".side-panel-type-menu__label"),
    ).find((item) => item.textContent?.trim() === "Review");
    expect(reviewLabel?.closest("wa-dropdown-item")?.hasAttribute("disabled")).toBe(true);
  });

  it("opens into a type selector instead of restoring a previous tab", async () => {
    const region = await createRegion({ columns: [], open: true, expanded: false });

    expect(root(region).querySelector(".side-panel-empty--selector")).not.toBeNull();
    expect(root(region).querySelectorAll(".side-panel-empty__type")).toHaveLength(4);
    root(region).querySelector<HTMLButtonElement>(".side-panel-empty__type")?.click();
    expect(region.callbacks?.openSlot).toHaveBeenCalledWith("detail");
  });

  it("renders a type-specific empty state when a type has no content yet", async () => {
    const region = await createRegion(openSlot({ columns: [] }, "companion"));
    expect(root(region).querySelector(".side-panel-empty--type")?.textContent).toContain(
      "Side chat",
    );
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
      "chat",
    ];
    await region.updateComplete;

    expect(
      Array.from(root(region).querySelectorAll(".side-panel-type-menu__label"), (item) =>
        item.textContent?.trim(),
      ),
    ).toEqual([
      "Review",
      "Terminal",
      "Browser",
      "Files",
      "Side chat",
      "Tasks",
      "Desktop",
      "Discussion",
      "Board chat",
    ]);
  });

  it("expands, restores, and minimizes without closing tabs", async () => {
    const region = await createRegion();
    root(region).querySelector<HTMLButtonElement>(".side-panel__expand")?.click();
    root(region).querySelector<HTMLButtonElement>(".side-panel__minimize")?.click();
    expect(region.callbacks?.setExpanded).toHaveBeenCalledWith(true);
    expect(region.callbacks?.setOpen).toHaveBeenCalledWith(false);

    region.layout = setSidebarExpanded(region.layout, true);
    await region.updateComplete;
    root(region).querySelector<HTMLButtonElement>(".side-panel__expand")?.click();
    expect(region.callbacks?.setExpanded).toHaveBeenLastCalledWith(false);
  });

  it("offers expand and minimize controls in the no-tabs selector", async () => {
    const region = await createRegion({ columns: [], open: true });
    root(region).querySelector<HTMLButtonElement>(".side-panel__expand")?.click();
    root(region).querySelector<HTMLButtonElement>(".side-panel__minimize")?.click();
    expect(region.callbacks?.setExpanded).toHaveBeenCalledWith(true);
    expect(region.callbacks?.setOpen).toHaveBeenCalledWith(false);
  });

  it("uses one inherited divider and reports bounded panel width", async () => {
    const region = await createRegion();
    const primary = root(region).querySelector<HTMLElement>(".sidebar-region__primary")!;
    const panel = root(region).querySelector<HTMLElement>(".side-panel")!;
    const divider = root(region).querySelector<HTMLElement>("resizable-divider")!;
    primary.getBoundingClientRect = () => ({ width: 800 }) as DOMRect;
    panel.getBoundingClientRect = () => ({ width: 360 }) as DOMRect;
    divider.dispatchEvent(
      new CustomEvent("resize", { bubbles: true, detail: { splitRatio: 0.5 } }),
    );
    expect(region.callbacks?.resizeColumn).toHaveBeenCalledWith(region.layout.columns[0]!.id, 580);
  });

  it("hides the runtime completely when the persisted panel state is minimized", async () => {
    const region = await createRegion({ ...openSlot({ columns: [] }, "detail"), open: false });
    expect(root(region).querySelector(".side-panel")).toBeNull();
    expect(root(region).querySelector("[data-primary]")).not.toBeNull();
  });
});
