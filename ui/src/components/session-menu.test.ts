/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./session-menu.ts";
import type { SessionMenuAction, SessionMenuData } from "./session-menu.ts";

type SessionMenuElement = HTMLElement & { updateComplete: Promise<boolean> };

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

async function mountMenu(
  options: {
    session?: Partial<SessionMenuData>;
    canOpenChat?: boolean;
    workboard?: { captured: boolean; busy: boolean } | null;
    archiveAllowed?: boolean;
    groups?: readonly string[];
    trigger?: HTMLElement | null;
    onAction?: (action: SessionMenuAction) => void;
    onClose?: () => void;
  } = {},
): Promise<SessionMenuElement> {
  const container = document.createElement("div");
  containers.push(container);
  document.body.append(container);
  const session: SessionMenuData = {
    key: "agent:main:test",
    label: "Test session",
    pinned: false,
    unread: false,
    archived: false,
    category: null,
    ...options.session,
  };
  render(
    html`<openclaw-session-menu
      .session=${session}
      .x=${100}
      .y=${100}
      .trigger=${options.trigger ?? null}
      .disabled=${false}
      .forkDisabled=${false}
      .archiveAllowed=${options.archiveAllowed ?? true}
      .groups=${options.groups ?? []}
      .canOpenChat=${options.canOpenChat ?? true}
      .workboard=${options.workboard === undefined
        ? { captured: false, busy: false }
        : options.workboard}
      .onAction=${options.onAction ?? (() => {})}
      .onClose=${options.onClose ?? (() => {})}
    ></openclaw-session-menu>`,
    container,
  );
  const element = container.querySelector("openclaw-session-menu") as SessionMenuElement | null;
  if (!element) {
    throw new Error("Expected session menu");
  }
  await element.updateComplete;
  return element;
}

function menuItemLabels(menu: ParentNode): string[] {
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
    (item) => item.textContent?.trim() ?? "",
  );
}

function menuItem(menu: ParentNode, label: string): HTMLButtonElement {
  const item = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!item) {
    throw new Error(`Expected menu item: ${label}`);
  }
  return item;
}

describe("session menu", () => {
  it("renders the full plain-session item set in order", async () => {
    const menu = await mountMenu();

    expect(menuItemLabels(menu)).toEqual([
      "Open chat",
      "Pin session",
      "Mark as unread",
      "Rename…",
      "Fork",
      "Add to Workboard",
      "Move to group",
      "Archive session",
      "Delete…",
    ]);
  });

  it("omits Open chat and Workboard when unavailable", async () => {
    const menu = await mountMenu({ canOpenChat: false, workboard: null });

    expect(menuItemLabels(menu)).not.toContain("Open chat");
    expect(menuItemLabels(menu)).not.toContain("Add to Workboard");
  });

  it("restores archived sessions while keeping delete enabled and pin disabled", async () => {
    const menu = await mountMenu({
      archiveAllowed: false,
      session: { archived: true },
    });

    expect(menuItem(menu, "Restore session").disabled).toBe(false);
    expect(menuItem(menu, "Delete…").disabled).toBe(false);
    expect(menuItem(menu, "Pin session").disabled).toBe(true);
  });

  it("disables archive and delete when an active session cannot be archived", async () => {
    const menu = await mountMenu({ archiveAllowed: false });

    expect(menuItem(menu, "Archive session").disabled).toBe(true);
    expect(menuItem(menu, "Delete…").disabled).toBe(true);
  });

  it("closes before dispatching Pin", async () => {
    const calls: string[] = [];
    const menu = await mountMenu({
      onClose: () => calls.push("close"),
      onAction: (action) => calls.push(action.kind),
    });

    menuItem(menu, "Pin session").click();

    expect(calls).toEqual(["close", "toggle-pin"]);
  });

  it("opens group actions and dispatches group, removal, and creation choices", async () => {
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    const menu = await mountMenu({
      session: { category: "Research" },
      groups: ["Research", "Projects"],
      onAction,
    });

    menuItem(menu, "Move to group").click();
    await menu.updateComplete;

    expect(menuItemLabels(menu)).toContain("Research");
    expect(menuItemLabels(menu)).toContain("Projects");
    expect(menuItem(menu, "Research").querySelector(".session-menu__check svg")).not.toBeNull();

    menuItem(menu, "Projects").click();
    expect(onAction).toHaveBeenCalledWith({ kind: "move-to-group", category: "Projects" });

    menuItem(menu, "Remove from group").click();
    expect(onAction).toHaveBeenCalledWith({ kind: "move-to-group", category: null });

    menuItem(menu, "New group…").click();
    expect(onAction).toHaveBeenCalledWith({ kind: "new-group" });
  });

  it("omits Remove from group when the session has no category", async () => {
    const menu = await mountMenu({ groups: ["Research"] });

    menuItem(menu, "Move to group").click();
    await menu.updateComplete;

    expect(menuItemLabels(menu)).not.toContain("Remove from group");
  });

  it("closes on Escape and outside pointerdown but ignores its trigger", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    containers.push(trigger);
    const onClose = vi.fn();
    await mountMenu({ trigger, onClose });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);

    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    expect(onClose).toHaveBeenCalledTimes(2);

    trigger.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
