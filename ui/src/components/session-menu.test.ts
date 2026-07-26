/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./session-menu.ts";
import type { SessionMenuAction, SessionMenuWork } from "./session-menu.ts";

type SessionMenuData = {
  label: string;
  pinned: boolean;
  unread: boolean;
  archived: boolean;
  category: string | null;
  icon?: string;
};
type SessionMenuElement = HTMLElement & {
  anchor: { x: number; y: number };
  lastActive: string;
  session: SessionMenuData;
  updateComplete: Promise<boolean>;
};
type SessionMenuItem = HTMLElement & { disabled: boolean; updateComplete: Promise<unknown> };

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
    work?: SessionMenuWork | null;
    workboard?: { captured: boolean; busy: boolean } | null;
    archiveAllowed?: boolean;
    cloudWorkerStopAllowed?: boolean;
    selectionCount?: number;
    lastActive?: string;
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
      .selectionCount=${options.selectionCount ?? 1}
      .lastActive=${options.lastActive ?? "57d"}
      .anchor=${{ x: 100, y: 100 }}
      .trigger=${options.trigger ?? null}
      .disabled=${false}
      .forkDisabled=${false}
      .archiveAllowed=${options.archiveAllowed ?? true}
      .cloudWorkerStopAllowed=${options.cloudWorkerStopAllowed ?? false}
      .groups=${options.groups ?? []}
      .canOpenChat=${options.canOpenChat ?? true}
      .work=${options.work ?? null}
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

function itemLabel(item: HTMLElement): string {
  return item.querySelector(".session-menu__text")?.textContent?.trim() ?? "";
}

function menuItemLabels(menu: ParentNode): string[] {
  const selector =
    menu instanceof Element && menu.matches("wa-dropdown-item")
      ? ":scope > wa-dropdown-item[slot='submenu']"
      : ":scope > wa-dropdown > wa-dropdown-item";
  return Array.from(menu.querySelectorAll<HTMLElement>(selector)).map(itemLabel);
}

function menuItem(menu: ParentNode, label: string): SessionMenuItem {
  const item = Array.from(menu.querySelectorAll<SessionMenuItem>("wa-dropdown-item")).find(
    (candidate) => itemLabel(candidate) === label,
  );
  if (!item) {
    throw new Error(`Expected menu item: ${label}`);
  }
  return item;
}

async function openIconPicker(menu: SessionMenuElement) {
  menuItem(menu, "Change icon").click();
  await menu.updateComplete;
  await Promise.resolve();
}

describe("session menu", () => {
  it("shows when the session was last active", async () => {
    const menu = await mountMenu({ lastActive: "57d" });

    expect(menu.querySelector(".session-menu__info")?.textContent?.trim()).toBe("Last active 57d");
  });

  it("renders the full plain-session item set in order", async () => {
    const menu = await mountMenu();

    expect(menuItemLabels(menu)).toEqual([
      "Open chat",
      "Pin thread",
      "Change icon",
      "Mark as unread",
      "Rename…",
      "Fork",
      "Add to Workboard",
      "Move to group",
      "Archive thread",
      "Delete…",
    ]);
  });

  it("renders only batch actions with counts for a multi-selection", async () => {
    const menu = await mountMenu({
      selectionCount: 3,
      work: { loading: false, pullRequestUrl: "https://example.test/pr", worktreePath: "/tmp/x" },
    });

    expect(menuItemLabels(menu)).toEqual([
      "Mark 3 as unread",
      "Move 3 to group",
      "Archive 3",
      "Delete 3…",
    ]);
  });

  it("offers an explicit cloud worker stop action for a stoppable placement", async () => {
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    const menu = await mountMenu({ cloudWorkerStopAllowed: true, onAction });

    menuItem(menu, "Stop cloud worker…").click();

    expect(onAction).toHaveBeenCalledWith({ kind: "stop-cloud-worker" });
  });

  it("hides cloud worker stop from batch actions", async () => {
    const menu = await mountMenu({ cloudWorkerStopAllowed: true, selectionCount: 2 });

    expect(menuItemLabels(menu)).not.toContain("Stop cloud worker…");
  });

  it("offers Mark N as read when every selected session is unread", async () => {
    const menu = await mountMenu({ selectionCount: 2, session: { unread: true } });

    expect(menuItemLabels(menu)).toContain("Mark 2 as read");
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

    expect(menuItem(menu, "Restore thread").disabled).toBe(false);
    expect(menuItem(menu, "Delete…").disabled).toBe(false);
    expect(menuItem(menu, "Pin thread").disabled).toBe(true);
  });

  it("disables archive and delete when an active session cannot be archived", async () => {
    const menu = await mountMenu({ archiveAllowed: false });

    expect(menuItem(menu, "Archive thread").disabled).toBe(true);
    expect(menuItem(menu, "Delete…").disabled).toBe(true);
  });

  it("closes before dispatching Pin", async () => {
    const calls: string[] = [];
    const menu = await mountMenu({
      onClose: () => calls.push("close"),
      onAction: (action) => calls.push(action.kind),
    });

    menuItem(menu, "Pin thread").click();

    expect(calls).toEqual(["close", "toggle-pin"]);
  });

  it("dispatches curated, emoji, and remove icon choices", async () => {
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    let menu = await mountMenu({ onAction });
    await openIconPicker(menu);

    menu
      .querySelector<HTMLButtonElement>('.session-menu__icon-choice[aria-label="spark"]')
      ?.click();
    expect(onAction).toHaveBeenLastCalledWith({ kind: "set-icon", icon: "name:spark" });

    menu = await mountMenu({ onAction });
    await openIconPicker(menu);
    const input = menu.querySelector<HTMLInputElement>(".session-menu__emoji-field input");
    if (input) {
      input.value = "🦞";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    expect(onAction).toHaveBeenLastCalledWith({ kind: "set-icon", icon: "🦞" });

    menu = await mountMenu({ session: { icon: "name:spark" }, onAction });
    await openIconPicker(menu);
    menu.querySelector<HTMLButtonElement>(".session-menu__remove-icon")?.click();
    expect(onAction).toHaveBeenLastCalledWith({ kind: "set-icon", icon: null });
  });

  it("opens an accessible icon picker with keyboard grid navigation", async () => {
    const menu = await mountMenu();

    await openIconPicker(menu);

    expect(menu.querySelector(".session-menu__icon-picker")?.getAttribute("role")).toBe("dialog");
    const choices = Array.from(
      menu.querySelectorAll<HTMLButtonElement>(".session-menu__icon-choice"),
    );
    expect(document.activeElement).toBe(choices[0]);
    choices[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(choices[1]);
  });

  it("opens group actions and dispatches group, removal, and creation choices", async () => {
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    const menu = await mountMenu({
      session: { category: "Research" },
      groups: ["Research", "Projects"],
      onAction,
    });

    const submenu = menuItem(menu, "Move to group");
    (submenu as SessionMenuItem & { submenuOpen: boolean }).submenuOpen = true;

    expect(menuItemLabels(submenu)).toContain("Research");
    expect(menuItemLabels(submenu)).toContain("Projects");
    const research = menuItem(submenu, "Research");
    const remove = menuItem(submenu, "Remove from group");
    const create = menuItem(submenu, "New group…");
    await Promise.all([research.updateComplete, remove.updateComplete, create.updateComplete]);
    await Promise.resolve();
    expect(research.getAttribute("role")).toBe("menuitemradio");
    expect(research.getAttribute("aria-checked")).toBe("true");
    expect(remove.getAttribute("role")).toBe("menuitem");
    expect(create.getAttribute("role")).toBe("menuitem");

    menuItem(menu, "Projects").click();
    expect(onAction).toHaveBeenCalledWith({ kind: "move-to-group", category: "Projects" });

    menuItem(menu, "Remove from group").click();
    expect(onAction).toHaveBeenCalledWith({ kind: "move-to-group", category: null });

    menuItem(menu, "New group…").click();
    expect(onAction).toHaveBeenCalledWith({ kind: "new-group" });
  });

  it("omits Remove from group when the session has no category", async () => {
    const menu = await mountMenu({ groups: ["Research"] });

    const submenu = menuItem(menu, "Move to group");

    expect(menuItemLabels(submenu)).not.toContain("Remove from group");
  });

  it("uses Web Awesome submenu slots when New group is the only entry", async () => {
    const menu = await mountMenu({ groups: [] });

    const submenu = menuItem(menu, "Move to group");
    expect(menuItemLabels(submenu)).toEqual(["New group…"]);
    expect(submenu.querySelector("wa-dropdown-item")?.getAttribute("slot")).toBe("submenu");
  });

  it("renders existing groups in the Web Awesome submenu", async () => {
    const menu = await mountMenu({ groups: ["Research"] });

    const submenu = menuItem(menu, "Move to group");
    expect(menuItemLabels(submenu)).toEqual(["Research", "New group…"]);
  });

  it("numbers group submenu entries and dispatches them from digit keys", async () => {
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    const menu = await mountMenu({
      session: { category: "Research" },
      groups: ["Research", "Projects"],
      onAction,
    });

    const closedDigit = new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true });
    document.dispatchEvent(closedDigit);
    expect(onAction).not.toHaveBeenCalled();

    const submenu = menuItem(menu, "Move to group");
    (submenu as SessionMenuItem & { submenuOpen: boolean }).submenuOpen = true;
    expect(menuItemLabels(submenu)).toEqual([
      "Research",
      "Projects",
      "Remove from group",
      "New group…",
    ]);
    const shortcuts = Array.from(
      submenu.querySelectorAll<HTMLElement>("wa-dropdown-item[slot='submenu']"),
    ).map((item) => item.dataset.shortcut);
    expect(shortcuts).toEqual(["1", "2", "3", "4"]);
    expect(
      menuItem(submenu, "Projects").querySelector(".session-menu__shortcut")?.textContent,
    ).toBe("2");

    const keydown = new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true });
    document.dispatchEvent(keydown);
    expect(onAction).toHaveBeenCalledWith({ kind: "move-to-group", category: "Projects" });
    expect(keydown.defaultPrevented).toBe(true);
  });

  it("omits Open PR and Open in for sessions without a worktree", async () => {
    const menu = await mountMenu();

    expect(menuItemLabels(menu)).not.toContain("Open PR");
    expect(menuItemLabels(menu)).not.toContain("Open in");
  });

  it("keeps Open PR and Open in disabled while the work context loads", async () => {
    const menu = await mountMenu({
      work: { loading: true, pullRequestUrl: null, worktreePath: null },
    });

    expect(menuItem(menu, "Open PR").disabled).toBe(true);
    expect(menuItem(menu, "Open in").disabled).toBe(true);
  });

  it("dispatches open-pr with the resolved URL from click or the G shortcut", async () => {
    const url = "https://github.com/openclaw/openclaw/pull/12345";
    const calls: SessionMenuAction[] = [];
    const menu = await mountMenu({
      work: { loading: false, pullRequestUrl: url, worktreePath: null },
      onAction: (action) => calls.push(action),
    });

    const openPr = menuItem(menu, "Open PR");
    expect(openPr.disabled).toBe(false);
    expect(openPr.querySelector(".session-menu__shortcut")?.textContent).toBe("G");
    expect(menuItem(menu, "Open in").disabled).toBe(true);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "g", bubbles: true, cancelable: true }),
    );
    expect(calls).toEqual([{ kind: "open-pr", url }]);
  });

  it("opens the editor submenu and dispatches open-in with the worktree path", async () => {
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    const menu = await mountMenu({
      work: { loading: false, pullRequestUrl: null, worktreePath: "/work/trees/demo" },
      onAction,
    });

    expect(menuItem(menu, "Open PR").disabled).toBe(true);
    const openIn = menuItem(menu, "Open in");
    (openIn as SessionMenuItem & { submenuOpen: boolean }).submenuOpen = true;

    expect(menuItemLabels(openIn)).toEqual(["Cursor", "VS Code", "Windsurf", "Zed"]);
    menuItem(openIn, "VS Code").click();
    expect(onAction).toHaveBeenCalledWith({
      kind: "open-in",
      editor: "vscode",
      path: "/work/trees/demo",
    });
  });

  it("renders shortcut hints and dispatches actions from bare letter keys", async () => {
    const calls: string[] = [];
    const menu = await mountMenu({
      onClose: () => calls.push("close"),
      onAction: (action) => calls.push(action.kind),
    });

    const pin = menuItem(menu, "Pin thread");
    expect(pin.querySelector(".session-menu__shortcut")?.textContent).toBe("P");
    expect(pin.getAttribute("aria-keyshortcuts")).toBe("P");
    expect(menuItem(menu, "Move to group").dataset.shortcut).toBeUndefined();

    const keydown = new KeyboardEvent("keydown", { key: "p", bubbles: true, cancelable: true });
    document.dispatchEvent(keydown);
    expect(calls).toEqual(["close", "toggle-pin"]);
    expect(keydown.defaultPrevented).toBe(true);
  });

  it("ignores shortcut keys for disabled items and modified keystrokes", async () => {
    const onAction = vi.fn();
    await mountMenu({ archiveAllowed: false, onAction });

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "d", bubbles: true, cancelable: true }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true, cancelable: true }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true }),
    );

    expect(onAction).not.toHaveBeenCalled();
  });

  it("closes on Escape without leaking the key past the menu", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    containers.push(trigger);
    const onClose = vi.fn();
    const menu = await mountMenu({ trigger, onClose });
    const escaped = vi.fn();
    menu.addEventListener("keydown", escaped);

    menu.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    expect(escaped).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  it("closes after Web Awesome hides without stealing focus", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    containers.push(trigger);
    const onClose = vi.fn();
    const menu = await mountMenu({ trigger, onClose });

    menu
      .querySelector("wa-dropdown")
      ?.dispatchEvent(new CustomEvent("wa-after-hide", { bubbles: true, composed: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(trigger);
  });

  it("ignores a stale hide after reopening the same session", async () => {
    const onClose = vi.fn();
    const menu = await mountMenu({ onClose });
    const staleDropdown = menu.querySelector("wa-dropdown");

    menu.anchor = { x: 120, y: 120 };
    await menu.updateComplete;
    staleDropdown?.dispatchEvent(
      new CustomEvent("wa-after-hide", { bubbles: true, composed: true }),
    );

    expect(onClose).not.toHaveBeenCalled();
    expect(menu.querySelector("wa-dropdown")).not.toBe(staleDropdown);
  });
});
