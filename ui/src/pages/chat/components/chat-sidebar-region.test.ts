/* @vitest-environment jsdom */

import { html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../../components/resizable-divider.ts";
import {
  mergePanelIntoColumn,
  openSlot,
  type SidebarSide,
  type SidebarSlotId,
} from "../sidebar-layout.ts";
import "./chat-sidebar-region.runtime.ts";

type Region = HTMLElementTagNameMap["openclaw-chat-sidebar-region"] & {
  updateComplete: Promise<unknown>;
};

const regions: Region[] = [];

async function createRegion(
  narrow: boolean,
  panelMutationEnabled: Partial<Record<SidebarSlotId, boolean>> = {},
) {
  const shell = document.createElement("div");
  shell.className = `sidebar-region ${narrow ? "sidebar-region--narrow" : ""}`;
  const region = document.createElement("openclaw-chat-sidebar-region") as Region;
  region.layout = openSlot(openSlot(openSlot({ columns: [] }, "discussion"), "chat"), "detail");
  region.panelTemplates = {
    chat: html`<div data-panel="chat">Chat panel</div>`,
    detail: html`<div data-panel="detail">Detail panel</div>`,
    discussion: html`<div data-panel="discussion">Discussion panel</div>`,
  };
  region.panelMutationEnabled = panelMutationEnabled;
  region.callbacks = {
    activatePanel: vi.fn(),
    closeSlot: vi.fn(),
    detachPanel: vi.fn(),
    mergePanel: vi.fn(),
    resizeColumn: vi.fn(),
  };
  region.narrow = narrow;
  region.availableWidth = narrow ? 620 : 1_600;
  const primary = document.createElement("div");
  primary.className = "sidebar-region__primary";
  primary.innerHTML = "<main data-primary>Primary</main>";
  const rightRuntime = document.createElement("div");
  rightRuntime.className = "sidebar-region__right-runtime";
  const panelsRuntime = document.createElement("div");
  panelsRuntime.className = "sidebar-region__panels-runtime";
  shell.append(region, primary, rightRuntime, panelsRuntime);
  document.body.append(shell);
  regions.push(region);
  await region.updateComplete;
  return region;
}

function regionRoot(region: Region): HTMLElement {
  return region.parentElement!;
}

function startPanelDrag(source: HTMLElement) {
  const values = new Map<string, string>();
  const dataTransfer = {
    effectAllowed: "none",
    dropEffect: "none",
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => values.set(type, value),
  };
  const start = new Event("dragstart", { bubbles: true }) as DragEvent;
  Object.defineProperty(start, "dataTransfer", { value: dataTransfer });
  source.dispatchEvent(start);
  return dataTransfer;
}

function dropPanel(target: HTMLElement, dataTransfer: object, clientX: number) {
  const drop = new Event("drop", { bubbles: true }) as DragEvent;
  Object.defineProperties(drop, {
    clientX: { value: clientX },
    clientY: { value: 50 },
    dataTransfer: { value: dataTransfer },
  });
  target.dispatchEvent(drop);
}

afterEach(() => {
  for (const region of regions.splice(0)) {
    region.parentElement?.remove();
  }
});

describe("chat sidebar region", () => {
  it("renders independent columns in rank order on wide panes", async () => {
    const region = await createRegion(false);
    expect(regionRoot(region).querySelectorAll(".sidebar-column")).toHaveLength(3);
    expect(
      Array.from(regionRoot(region).querySelectorAll(".sidebar-column__tab"), (tab) =>
        tab.textContent?.trim(),
      ),
    ).toEqual(["Chat", "Details", "Discussion"]);
    expect(regionRoot(region).querySelectorAll(".sidebar-column__tabs")).toHaveLength(0);
    expect(
      Array.from(regionRoot(region).querySelectorAll(".rail-header__title"), (title) =>
        title.textContent?.trim(),
      ),
    ).toEqual(["Chat", "Details", "Discussion"]);
    expect(regionRoot(region).querySelector("[data-primary]")).not.toBeNull();
  });

  it("collapses every open panel into one tabbed column on narrow panes", async () => {
    const region = await createRegion(true);
    expect(regionRoot(region).querySelectorAll(".sidebar-column")).toHaveLength(1);
    expect(regionRoot(region).querySelectorAll(".sidebar-column__tab")).toHaveLength(3);
    expect(
      Array.from(
        regionRoot(region).querySelectorAll<HTMLButtonElement>(".sidebar-column__tab"),
      ).every((tab) => !tab.draggable),
    ).toBe(true);

    regionRoot(region).querySelectorAll<HTMLButtonElement>(".sidebar-column__tab")[1]?.click();
    await region.updateComplete;

    expect(regionRoot(region).querySelector('[data-panel="detail"]')).not.toBeNull();
    expect(regionRoot(region).querySelector('[data-panel="chat"]')).not.toBeNull();
    expect(region.callbacks?.activatePanel).toHaveBeenCalled();
  });

  it("activates a panel opened after the narrow region is already visible", async () => {
    const region = await createRegion(true);
    region.layout = openSlot({ columns: [] }, "chat");
    await region.updateComplete;

    region.layout = openSlot(region.layout, "discussion");
    await region.updateComplete;

    expect(regionRoot(region).querySelector('[data-panel="discussion"]')).not.toBeNull();
  });

  it("foregrounds an already-mounted panel from a focus request", async () => {
    const region = await createRegion(true);
    const discussion = region.layout.columns[2]!.panels[0]!;

    region.focusPanelId = discussion.id;
    region.focusVersion += 1;
    await region.updateComplete;

    expect(
      regionRoot(region).querySelector('[data-panel="discussion"]')?.parentElement?.hidden,
    ).toBe(false);
    expect(regionRoot(region).querySelector('[data-panel="chat"]')?.parentElement?.hidden).toBe(
      true,
    );
  });

  it("routes native header drops through the merge callback", async () => {
    const region = await createRegion(false);
    const tabs = regionRoot(region).querySelectorAll<HTMLElement>(".sidebar-column__tab");
    const source = tabs[0];
    const target = tabs[1];
    expect(source).toBeDefined();
    expect(target).toBeDefined();
    const values = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      getData: (type: string) => values.get(type) ?? "",
      setData: (type: string, value: string) => values.set(type, value),
    };
    const start = new Event("dragstart", { bubbles: true }) as DragEvent;
    Object.defineProperty(start, "dataTransfer", { value: dataTransfer });
    source!.dispatchEvent(start);
    const drop = new Event("drop", { bubbles: true }) as DragEvent;
    Object.defineProperties(drop, {
      clientX: { value: 1 },
      clientY: { value: 1 },
      dataTransfer: { value: dataTransfer },
    });
    target!.dispatchEvent(drop);

    expect(region.callbacks?.mergePanel).toHaveBeenCalledWith(
      region.layout.columns[0]?.panels[0]?.id,
      region.layout.columns[1]?.id,
      1,
    );
  });

  it("gates chat close while keeping non-chat close controls functional", async () => {
    const region = await createRegion(false, { chat: false });
    const closeButtons = () =>
      Array.from(
        regionRoot(region).querySelectorAll<HTMLButtonElement>(".sidebar-column__actions button"),
      );
    const closeButton = (panel: string) =>
      closeButtons().find((button) => button.getAttribute("aria-label") === `Close ${panel}`);

    expect(closeButton("Chat")).toBeUndefined();
    closeButton("Details")?.click();
    closeButton("Discussion")?.click();
    expect(region.callbacks?.closeSlot).toHaveBeenCalledWith("detail");
    expect(region.callbacks?.closeSlot).toHaveBeenCalledWith("discussion");

    region.panelMutationEnabled = { chat: true };
    await region.updateComplete;

    closeButton("Chat")?.click();
    closeButton("Details")?.click();
    closeButton("Discussion")?.click();
    expect(region.callbacks?.closeSlot).toHaveBeenCalledWith("chat");
    expect(region.callbacks?.closeSlot).toHaveBeenCalledWith("detail");
    expect(region.callbacks?.closeSlot).toHaveBeenCalledWith("discussion");
  });

  it("gates chat dragging while keeping non-chat panels draggable", async () => {
    const region = await createRegion(false, { chat: false });
    const tabs = () =>
      Array.from(regionRoot(region).querySelectorAll<HTMLElement>(".sidebar-column__tab"));
    const tab = (panel: string) =>
      tabs().find((candidate) => candidate.textContent?.trim() === panel);

    expect(tab("Chat")?.draggable).toBe(false);
    expect(tab("Details")?.draggable).toBe(true);
    expect(tab("Discussion")?.draggable).toBe(true);

    region.panelMutationEnabled = { chat: true };
    await region.updateComplete;

    expect(tab("Chat")?.draggable).toBe(true);
    expect(tab("Details")?.draggable).toBe(true);
    expect(tab("Discussion")?.draggable).toBe(true);
  });

  it.each([
    { sourceSide: "left", targetSide: "right", boundaryX: 100, dropX: 124 },
    { sourceSide: "right", targetSide: "left", boundaryX: 48, dropX: 24 },
  ] satisfies Array<{
    sourceSide: SidebarSide;
    targetSide: SidebarSide;
    boundaryX: number;
    dropX: number;
  }>)(
    "detaches a panel into the empty $targetSide side at index zero",
    async ({ sourceSide, targetSide, boundaryX, dropX }) => {
      const region = await createRegion(false);
      region.layout = openSlot({ columns: [] }, "detail", sourceSide);
      await region.updateComplete;
      const source = regionRoot(region).querySelector<HTMLElement>(".sidebar-column__tab")!;
      const dataTransfer = startPanelDrag(source);
      await region.updateComplete;
      const target = regionRoot(region).querySelector<HTMLElement>(
        `.sidebar-empty-side-drop-zone--${targetSide}`,
      );
      expect(target).not.toBeNull();
      expect(target?.getAttribute("aria-label")).toBe(
        `Move Details to the empty ${targetSide} sidebar`,
      );
      const boundary = target!.querySelector<HTMLElement>(
        ".sidebar-empty-side-drop-zone__boundary",
      )!;
      boundary.getBoundingClientRect = () =>
        ({ left: boundaryX, top: 0, width: 1, height: 100 }) as DOMRect;

      dropPanel(target!, dataTransfer, dropX);

      expect(region.callbacks?.detachPanel).toHaveBeenCalledWith(
        region.layout.columns[0]?.panels[0]?.id,
        targetSide,
        0,
      );
    },
  );

  it("shows empty-side drop zones only for the lifetime of a panel drag", async () => {
    const region = await createRegion(false);
    region.layout = openSlot({ columns: [] }, "detail", "right");
    await region.updateComplete;
    const dropZones = () => regionRoot(region).querySelectorAll(".sidebar-empty-side-drop-zone");
    const source = regionRoot(region).querySelector<HTMLElement>(".sidebar-column__tab")!;

    expect(dropZones()).toHaveLength(0);
    startPanelDrag(source);
    await region.updateComplete;
    expect(dropZones()).toHaveLength(1);

    source.dispatchEvent(new Event("dragend", { bubbles: true }));
    await region.updateComplete;
    expect(dropZones()).toHaveLength(0);
  });

  it("removes the empty-side target when Chat mutation becomes unavailable", async () => {
    const region = await createRegion(false, { chat: true });
    region.layout = openSlot({ columns: [] }, "chat", "right");
    await region.updateComplete;
    const source = regionRoot(region).querySelector<HTMLElement>(".sidebar-column__tab")!;
    const dataTransfer = startPanelDrag(source);
    await region.updateComplete;
    const target = regionRoot(region).querySelector<HTMLElement>(
      ".sidebar-empty-side-drop-zone--left",
    );
    expect(target).not.toBeNull();

    region.panelMutationEnabled = { chat: false };
    await region.updateComplete;
    expect(regionRoot(region).querySelector(".sidebar-empty-side-drop-zone--left")).toBeNull();
    const boundary = target!.querySelector<HTMLElement>(".sidebar-empty-side-drop-zone__boundary")!;
    boundary.getBoundingClientRect = () => ({ left: 48, top: 0, width: 1, height: 100 }) as DOMRect;
    dropPanel(target!, dataTransfer, 24);
    expect(region.callbacks?.detachPanel).not.toHaveBeenCalled();
  });

  it("routes boundary drops through the detach callback", async () => {
    const region = await createRegion(false);
    const source = regionRoot(region).querySelectorAll<HTMLElement>(".sidebar-column__tab")[1]!;
    const boundary = regionRoot(region).querySelector<HTMLElement>("resizable-divider")!;
    boundary.getBoundingClientRect = () => ({ left: 0, top: 0, width: 4, height: 100 }) as DOMRect;
    const values = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      getData: (type: string) => values.get(type) ?? "",
      setData: (type: string, value: string) => values.set(type, value),
    };
    const start = new Event("dragstart", { bubbles: true }) as DragEvent;
    Object.defineProperty(start, "dataTransfer", { value: dataTransfer });
    source.dispatchEvent(start);
    const drop = new Event("drop", { bubbles: true }) as DragEvent;
    Object.defineProperties(drop, {
      clientX: { value: 1 },
      clientY: { value: 50 },
      dataTransfer: { value: dataTransfer },
    });
    boundary.dispatchEvent(drop);

    expect(region.callbacks?.detachPanel).toHaveBeenCalledWith(
      region.layout.columns[1]?.panels[0]?.id,
      "right",
      0,
    );
  });

  it("resizes the primary-adjacent column across the light-DOM shell boundary", async () => {
    const region = await createRegion(false);
    const primary = regionRoot(region).querySelector<HTMLElement>(".sidebar-region__primary");
    const divider = regionRoot(region).querySelector<HTMLElement>(
      ".sidebar-region__right-runtime .sidebar-column__divider",
    );
    const column = region.layout.columns.find((candidate) => candidate.side === "right");
    expect(primary).toBeDefined();
    expect(divider).toBeDefined();
    expect(column).toBeDefined();
    primary!.getBoundingClientRect = () => ({ width: 800 }) as DOMRect;
    regionRoot(region).querySelector<HTMLElement>(
      `[data-column-id="${column!.id}"]`,
    )!.getBoundingClientRect = () => ({ width: 320 }) as DOMRect;
    divider!.setPointerCapture = vi.fn();
    divider!.releasePointerCapture = vi.fn();
    divider!.hasPointerCapture = vi.fn(() => true);
    const pointerDown = new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: 500,
    });
    Object.defineProperty(pointerDown, "pointerId", { value: 7 });
    divider!.dispatchEvent(pointerDown);
    document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 612 }));
    document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 612 }));

    const resizedWidth = vi.mocked(region.callbacks!.resizeColumn).mock.lastCall?.[1];
    expect(region.callbacks?.resizeColumn).toHaveBeenCalledWith(column!.id, expect.any(Number));
    expect(resizedWidth).toBeCloseTo(208);

    vi.mocked(region.callbacks!.resizeColumn).mockClear();
    divider!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    const keyboardWidth = vi.mocked(region.callbacks!.resizeColumn).mock.lastCall?.[1];
    expect(keyboardWidth).toBeCloseTo(297.6);
  });

  it("ignores a drag payload started by another sidebar region", async () => {
    const sourceRegion = await createRegion(false);
    const targetRegion = await createRegion(false);
    const source = regionRoot(sourceRegion).querySelector<HTMLElement>(".sidebar-column__tab")!;
    const target = regionRoot(targetRegion).querySelector<HTMLElement>(".sidebar-column__tab")!;
    const values = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      getData: (type: string) => values.get(type) ?? "",
      setData: (type: string, value: string) => values.set(type, value),
    };
    const start = new Event("dragstart", { bubbles: true }) as DragEvent;
    Object.defineProperty(start, "dataTransfer", { value: dataTransfer });
    source.dispatchEvent(start);
    const drop = new Event("drop", { bubbles: true }) as DragEvent;
    Object.defineProperties(drop, {
      clientX: { value: 1 },
      clientY: { value: 1 },
      dataTransfer: { value: dataTransfer },
    });
    target.dispatchEvent(drop);

    expect(targetRegion.callbacks?.mergePanel).not.toHaveBeenCalled();
  });

  it("preserves a panel DOM node when it moves between columns", async () => {
    const region = await createRegion(false);
    const detail = region.layout.columns[1]!.panels[0]!;
    const target = region.layout.columns[2]!;
    const detailNode = regionRoot(region).querySelector('[data-panel="detail"]');

    region.layout = mergePanelIntoColumn(region.layout, detail.id, target.id, 0);
    await region.updateComplete;

    expect(regionRoot(region).querySelector('[data-panel="detail"]')).toBe(detailNode);
  });

  it("preserves a panel DOM node while crossing the responsive breakpoint", async () => {
    const region = await createRegion(false);
    const detailNode = regionRoot(region).querySelector('[data-panel="detail"]');

    region.narrow = true;
    region.availableWidth = 620;
    region.parentElement?.classList.add("sidebar-region--narrow");
    await region.updateComplete;

    expect(regionRoot(region).querySelector('[data-panel="detail"]')).toBe(detailNode);
  });

  it("preserves the primary DOM node while crossing the responsive breakpoint", async () => {
    const region = await createRegion(false);
    const primaryNode = regionRoot(region).querySelector("[data-primary]");

    region.narrow = true;
    region.availableWidth = 620;
    await region.updateComplete;

    expect(regionRoot(region).querySelector("[data-primary]")).toBe(primaryNode);
  });

  it("restores the persisted active tab when the session changes", async () => {
    const region = await createRegion(true);
    const chat = region.layout.columns[0]!.panels[0]!;
    const discussion = region.layout.columns[2]!.panels[0]!;
    let merged = mergePanelIntoColumn(
      region.layout,
      discussion.id,
      region.layout.columns[0]!.id,
      1,
    );
    const detail = merged.columns[1]!.panels[0]!;
    merged = mergePanelIntoColumn(merged, detail.id, merged.columns[0]!.id, 1);
    merged.columns[0]!.activePanelId = chat.id;
    region.layout = merged;
    region.sessionKey = "session-a";
    await region.updateComplete;
    merged = { ...merged, columns: merged.columns.map((column) => ({ ...column })) };
    merged.columns[0]!.activePanelId = discussion.id;

    region.layout = merged;
    region.sessionKey = "session-b";
    await region.updateComplete;

    expect(
      regionRoot(region).querySelector('[data-panel="discussion"]')?.parentElement?.hidden,
    ).toBe(false);
  });

  it("gives a simultaneous explicit focus request precedence on session change", async () => {
    const region = await createRegion(true);
    const detail = region.layout.columns[1]!.panels[0]!;

    region.sessionKey = "session-b";
    region.focusPanelId = detail.id;
    region.focusVersion += 1;
    await region.updateComplete;

    expect(regionRoot(region).querySelector('[data-panel="detail"]')?.parentElement?.hidden).toBe(
      false,
    );
  });

  it("keeps the narrow grid off when no panel is open", async () => {
    const region = await createRegion(true);
    region.layout = { columns: [] };
    region.parentElement?.classList.remove("sidebar-region--narrow");
    await region.updateComplete;

    // The two-row narrow grid must not reserve a panel row for an empty layout,
    // or every default mobile chat pane loses half its height.
    expect(region.parentElement?.classList.contains("sidebar-region--narrow")).toBe(false);
    expect(regionRoot(region).querySelector("[data-primary]")).not.toBeNull();
  });
});
