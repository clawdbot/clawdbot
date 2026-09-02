/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./session-menu.ts";
import type { SessionMenuData } from "./session-menu-actions.ts";
import type { SessionMenuAction, SessionMenuActionKind, SessionMenuWork } from "./session-menu.ts";
import type { SessionOwnerOption } from "./session-owner-chip.ts";
type SessionMenuElement = HTMLElement & {
  anchor: { x: number; y: number };
  compact: boolean;
  lastActive: string;
  session: SessionMenuData;
  ownerOptions: readonly SessionOwnerOption[];
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
    compact?: boolean;
    navigationAllowed?: boolean;
    copyMarkdownAllowed?: boolean;
    splitAllowed?: boolean;
    work?: SessionMenuWork | null;
    workboard?: { captured: boolean; busy: boolean } | null;
    archiveAllowed?: boolean;
    deleteAllowed?: boolean;
    cloudWorkerStopAllowed?: boolean;
    selectionCount?: number;
    lastActive?: string;
    groups?: readonly string[];
    ownerOptions?: readonly SessionOwnerOption[];
    selfOwner?: SessionOwnerOption | null;
    currentOwnerId?: string | null;
    trigger?: HTMLElement | null;
    onAction?: (action: SessionMenuAction) => void;
    onClose?: () => void;
    actionDisabledReasons?: Partial<Record<SessionMenuActionKind, string>>;
    forkFromLastCompleted?: boolean;
  } = {},
): Promise<SessionMenuElement> {
  const container = document.createElement("div");
  containers.push(container);
  document.body.append(container);
  const session: SessionMenuData = {
    label: "Test session",
    sessionId: "session-123",
    isChild: false,
    pinned: false,
    unread: false,
    archived: false,
    category: null,
    icon: null,
    color: null,
    categoryClearReturnsToGroups: false,
    ...options.session,
  };
  render(
    html`<openclaw-session-menu
      .session=${session}
      .compact=${options.compact ?? false}
      .navigationAllowed=${options.navigationAllowed ?? true}
      .copyMarkdownAllowed=${options.copyMarkdownAllowed ?? true}
      .splitAllowed=${options.splitAllowed ?? false}
      .selectionCount=${options.selectionCount ?? 1}
      .lastActive=${options.lastActive ?? "57d"}
      .anchor=${{ x: 100, y: 100 }}
      .trigger=${options.trigger ?? null}
      .disabled=${false}
      .actionDisabledReasons=${options.actionDisabledReasons ?? {}}
      .forkDisabled=${false}
      .forkFromLastCompleted=${options.forkFromLastCompleted ?? false}
      .archiveAllowed=${options.archiveAllowed ?? true}
      .deleteAllowed=${options.deleteAllowed ??
      (session.archived || (options.archiveAllowed ?? true))}
      .cloudWorkerStopAllowed=${options.cloudWorkerStopAllowed ?? false}
      .groups=${options.groups ?? []}
      .ownerOptions=${options.ownerOptions ?? []}
      .selfOwner=${options.selfOwner ?? null}
      .currentOwnerId=${options.currentOwnerId ?? null}
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

function iconChoices(menu: ParentNode): HTMLButtonElement[] {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>(".session-menu__icon-choice"));
}

function selectMenuValue(menu: SessionMenuElement, value: string) {
  menu.querySelector("wa-dropdown")?.dispatchEvent(
    new CustomEvent("wa-select", {
      bubbles: true,
      composed: true,
      detail: { item: { value } },
    }),
  );
}

describe("session menu", () => {
  it("puts the self shortcut first in the owner submenu and dispatches canonical owners", async () => {
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    const onClose = vi.fn();
    const selfOwner = { type: "human", id: "profile-ada", label: "Ada" } as const;
    const menu = await mountMenu({
      ownerOptions: [selfOwner, { type: "agent", id: "research:one", label: "Research" }],
      selfOwner,
      currentOwnerId: "research:one",
      onAction,
      onClose,
    });
    const selected = menuItem(menu, "Research");
    const submenu = menuItem(menu, "Assign to…");
    expect(menuItemLabels(menu).filter((label) => label.startsWith("Assign to"))).toEqual([
      "Assign to…",
    ]);
    expect(menuItemLabels(submenu)).toEqual(["Me", "Research"]);
    expect(selected.getAttribute("role")).toBe("menuitemradio");
    expect(selected.getAttribute("aria-checked")).toBe("true");
    expect(selected.disabled).toBe(true);
    expect(selected.querySelector("[slot='details']")).not.toBeNull();

    for (const label of ["Me", "Research"]) {
      const value = menuItem(menu, label).getAttribute("value");
      menu.querySelector("wa-dropdown")?.dispatchEvent(
        new CustomEvent("wa-select", {
          bubbles: true,
          composed: true,
          detail: { item: { value } },
        }),
      );
    }
    expect(onAction.mock.calls).toEqual([
      [{ kind: "assign-owner", owner: { type: "human", id: "profile-ada" } }],
      [{ kind: "assign-owner", owner: { type: "agent", id: "research:one" } }],
    ]);
    expect(onClose).toHaveBeenCalledTimes(2);
    const closeOrder = onClose.mock.invocationCallOrder[0];
    const actionOrder = onAction.mock.invocationCallOrder[0];
    if (closeOrder === undefined || actionOrder === undefined) {
      throw new Error("Expected close and action call order");
    }
    expect(closeOrder).toBeLessThan(actionOrder);

    const batch = await mountMenu({
      selectionCount: 2,
      ownerOptions: [selfOwner],
      selfOwner,
    });
    expect(batch.textContent).not.toContain("Assign to");
  });

  it("disables only denied mutation actions and ignores forced selection", async () => {
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    const menu = await mountMenu({
      onAction,
      actionDisabledReasons: {
        delete: "This action requires operator.admin access.",
        "toggle-pin": "This action requires operator.write access.",
      },
    });
    const pin = menuItem(menu, "Pin session");
    const deleteItem = menuItem(menu, "Delete…");

    expect(pin.disabled).toBe(true);
    expect(pin.getAttribute("title")).toBe("This action requires operator.write access.");
    expect(deleteItem.disabled).toBe(true);
    deleteItem.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        composed: true,
        detail: { item: { value: "delete" } },
      }),
    );
    expect(onAction).not.toHaveBeenCalled();
  });

  it("shows when the session was last active", async () => {
    const menu = await mountMenu({ lastActive: "57d" });

    expect(menu.querySelector(".session-menu__info")?.textContent?.trim()).toBe("Last active 57d");
  });

  it("renders the full plain-session item set in order", async () => {
    const menu = await mountMenu();

    expect(menuItemLabels(menu)).toEqual([
      "Pin session",
      "Rename…",
      "Mark as unread",
      "Archive session",
      "Icon & color",
      "Move to group",
      "Add to Workboard",
      "Fork conversation",
      "Copy",
      "Open in",
      "Delete…",
    ]);
  });

  it("drills into compact menu groups without rendering side flyouts", async () => {
    const ada = { type: "human", id: "profile-ada", label: "Ada" } as const;
    const research = { type: "agent", id: "research:one", label: "Research owner" } as const;
    const menu = await mountMenu({
      compact: true,
      groups: ["Research", "Operations"],
      ownerOptions: [ada, research],
      selfOwner: ada,
      currentOwnerId: research.id,
      work: {
        loading: false,
        pullRequestUrl: "https://example.test/pr",
        worktreePath: "/work/openclaw",
      },
    });

    expect(menu.querySelector("[slot='submenu']")).toBeNull();
    expect(menuItemLabels(menu)).toContain("Open in");
    expect(menuItemLabels(menu)).toContain("Assign to…");
    expect(menuItemLabels(menu)).toContain("Icon & color");
    expect(menuItemLabels(menu)).toContain("Move to group");

    selectMenuValue(menu, "compact:open-open-in");
    await menu.updateComplete;
    expect(menuItemLabels(menu)).toEqual([
      "Back",
      "New tab",
      "New window",
      "Cursor",
      "VS Code",
      "Windsurf",
      "Zed",
    ]);

    selectMenuValue(menu, "compact:back");
    await menu.updateComplete;
    selectMenuValue(menu, "compact:open-copy");
    await menu.updateComplete;
    expect(menuItemLabels(menu)).toEqual([
      "Back",
      "Session link",
      "Conversation as Markdown",
      "Session ID",
    ]);

    selectMenuValue(menu, "compact:back");
    await menu.updateComplete;
    selectMenuValue(menu, "compact:open-assign-owner");
    await menu.updateComplete;
    expect(menuItemLabels(menu)).toEqual(["Back", "Me", "Research owner"]);

    selectMenuValue(menu, "compact:back");
    await menu.updateComplete;
    selectMenuValue(menu, "compact:open-icon");
    await menu.updateComplete;
    expect(menuItemLabels(menu)).toEqual(["Back"]);
    expect(menu.querySelectorAll(".session-menu__color-choice")).toHaveLength(9);
    expect(menu.querySelector(".session-menu__icon-picker")?.getAttribute("slot")).toBeNull();

    selectMenuValue(menu, "compact:back");
    await menu.updateComplete;
    selectMenuValue(menu, "compact:open-group");
    await menu.updateComplete;
    expect(menuItemLabels(menu)).toEqual(["Back", "Research", "Operations", "New group…"]);
    expect(menu.querySelector("[slot='submenu']")).toBeNull();
  });

  it("omits root placement actions for child sessions", async () => {
    const menu = await mountMenu({
      session: { isChild: true },
      workboard: null,
    });

    expect(menuItemLabels(menu)).toEqual([
      "Rename…",
      "Mark as unread",
      "Archive session",
      "Icon & color",
      "Fork conversation",
      "Copy",
      "Open in",
      "Delete…",
    ]);
  });

  it("names the stable fork boundary for an active session", async () => {
    const menu = await mountMenu({ forkFromLastCompleted: true });

    expect(menuItem(menu, "Fork conversation").getAttribute("title")).toBe(
      "Fork from last completed message",
    );
  });

  it("renders only batch actions with counts for a multi-selection", async () => {
    const menu = await mountMenu({
      selectionCount: 3,
      work: { loading: false, pullRequestUrl: "https://example.test/pr", worktreePath: "/tmp/x" },
    });

    expect(menuItemLabels(menu)).toEqual([
      "Mark 3 as unread",
      "Archive 3",
      "Move 3 to group",
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

  it("offers Restore N when every selected session is archived", async () => {
    const menu = await mountMenu({ selectionCount: 2, session: { archived: true } });

    expect(menuItemLabels(menu)).toContain("Restore 2");
    expect(menuItemLabels(menu)).not.toContain("Archive 2");
  });

  it("omits Workboard when unavailable", async () => {
    const menu = await mountMenu({ workboard: null });

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

  it("enables archive while preserving disabled delete for an active session", async () => {
    const menu = await mountMenu({ archiveAllowed: true, deleteAllowed: false });

    expect(menuItem(menu, "Archive session").disabled).toBe(false);
    expect(menuItem(menu, "Delete…").disabled).toBe(true);
  });

  it("keeps batch archive enabled while independently guarding delete", async () => {
    const menu = await mountMenu({
      selectionCount: 2,
      archiveAllowed: false,
      deleteAllowed: false,
    });

    expect(menuItem(menu, "Archive 2").disabled).toBe(false);
    expect(menuItem(menu, "Delete 2…").disabled).toBe(true);
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

  it("groups copy actions under one keyboard shortcut", async () => {
    const calls: string[] = [];
    const menu = await mountMenu({
      onClose: () => calls.push("close"),
      onAction: (action) => calls.push(action.kind),
    });
    const copy = menuItem(menu, "Session ID");

    expect(copy.disabled).toBe(false);
    const copyGroup = menuItem(menu, "Copy");
    expect(copyGroup.querySelector(".session-menu__shortcut")?.textContent).toBe("C");
    expect(copyGroup.getAttribute("aria-keyshortcuts")).toBe("C");
    expect(menuItemLabels(copyGroup)).toEqual([
      "Session link",
      "Conversation as Markdown",
      "Session ID",
    ]);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }),
    );
    await copyGroup.updateComplete;
    expect((copyGroup as SessionMenuItem & { submenuOpen: boolean }).submenuOpen).toBe(true);
    expect(calls).toEqual([]);

    copy.click();

    expect(calls).toEqual(["close", "copy-session-id"]);
  });

  it("gates unavailable copy and navigation actions even on forced selection", async () => {
    const onAction = vi.fn();
    const menu = await mountMenu({
      session: { sessionId: null },
      navigationAllowed: false,
      copyMarkdownAllowed: false,
      splitAllowed: false,
      onAction,
    });

    expect(menuItem(menu, "Session ID").disabled).toBe(true);
    expect(menuItem(menu, "Conversation as Markdown").disabled).toBe(true);
    expect(menuItemLabels(menuItem(menu, "Copy"))).toEqual([
      "Conversation as Markdown",
      "Session ID",
    ]);
    expect(menuItemLabels(menu)).not.toContain("Open in");
    for (const kind of [
      "copy-session-id",
      "copy-session-link",
      "copy-markdown",
      "open-new-tab",
      "open-new-window",
      "split-right",
      "split-below",
    ]) {
      selectMenuValue(menu, kind);
    }
    expect(onAction).not.toHaveBeenCalled();
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

  it.each([false, true])(
    "edits icon and color together without closing (compact=%s)",
    async (compact) => {
      const onAction = vi.fn<(action: SessionMenuAction) => void>();
      const onClose = vi.fn();
      const menu = await mountMenu({
        compact,
        session: { icon: "🦞", color: "blue" },
        onAction,
        onClose,
      });
      if (compact) {
        selectMenuValue(menu, "compact:open-icon");
        await menu.updateComplete;
      } else {
        (menuItem(menu, "Icon & color") as SessionMenuItem & { submenuOpen: boolean }).submenuOpen =
          true;
      }
      const blue = menu.querySelector<HTMLButtonElement>(
        '.session-menu__color-choice[aria-label="Blue"]',
      );
      expect(blue?.getAttribute("aria-pressed")).toBe("true");
      expect(menu.querySelectorAll('.session-menu__colors [aria-pressed="true"]')).toHaveLength(1);
      menu
        .querySelector<HTMLButtonElement>('.session-menu__color-choice[aria-label="Purple"]')
        ?.click();
      iconChoices(menu)[1]?.click();
      menu
        .querySelector<HTMLButtonElement>('.session-menu__color-choice[aria-label="Default"]')
        ?.click();
      menu.querySelector<HTMLButtonElement>(".session-menu__icon-remove")?.click();
      expect(onAction.mock.calls).toEqual([
        [{ kind: "set-color", color: "purple" }],
        [{ kind: "set-icon", icon: "🚀" }],
        [{ kind: "set-color", color: null }],
        [{ kind: "reset-appearance" }],
      ]);
      expect(onClose).not.toHaveBeenCalled();
      menu.session = { ...menu.session, icon: "🚀", color: "purple" };
      await menu.updateComplete;
      expect(
        menu.querySelector('.session-menu__icon-choice[aria-pressed="true"]')?.textContent?.trim(),
      ).toBe("🚀");
      expect(
        menu
          .querySelector('.session-menu__color-choice[aria-pressed="true"]')
          ?.getAttribute("aria-label"),
      ).toBe("Purple");
    },
  );

  it.each([
    { selectionCount: 2 },
    { actionDisabledReasons: { "set-color": "Write access required" } },
  ])("does not dispatch a disabled color action: %j", async (options) => {
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    const menu = await mountMenu({ ...options, onAction });
    if (options.selectionCount === 2) {
      expect(menu.querySelector(".session-menu__appearance")).toBeNull();
    } else {
      for (const label of ["Red", "Default"]) {
        const choice = menu.querySelector<HTMLButtonElement>(
          `.session-menu__color-choice[aria-label="${label}"]`,
        );
        expect(choice?.disabled).toBe(true);
        choice?.click();
      }
      const reset = menu.querySelector<HTMLButtonElement>(".session-menu__icon-remove");
      expect(reset?.disabled).toBe(true);
      reset?.click();
    }
    expect(onAction).not.toHaveBeenCalled();
  });

  it("renders emoji and glyph sections with a custom entry and combined reset", async () => {
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    const menu = await mountMenu({ session: { icon: "🦞" }, onAction });
    const submenu = menuItem(menu, "Icon & color");
    (submenu as SessionMenuItem & { submenuOpen: boolean }).submenuOpen = true;

    const choices = iconChoices(submenu);
    expect(submenu.querySelector(".session-menu__icon-options")?.getAttribute("role")).toBe(
      "group",
    );
    expect(
      Array.from(submenu.querySelectorAll(".session-menu__icon-section-label")).map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(["Color", "Emoji", "Icons"]);
    const grids = submenu.querySelectorAll(".session-menu__icon-grid");
    expect(
      Array.from(grids[0]?.querySelectorAll<HTMLButtonElement>("button") ?? []).map((choice) =>
        choice.textContent?.trim(),
      ),
    ).toEqual(["🦞", "🚀", "🐛", "✅", "🔥", "📦", "🧪", "📝", "🔍", "⚡", "🎯", ""]);
    expect(grids[0]?.querySelectorAll("button")).toHaveLength(12);
    expect(grids[0]?.querySelector("button:nth-child(12)")?.getAttribute("aria-label")).toBe(
      "Custom emoji…",
    );
    expect(grids[1]?.querySelectorAll("button")).toHaveLength(6);
    const current = choices[0];
    if (!current) {
      throw new Error("Expected the first icon choice");
    }
    // Click/Enter-only activation: pressed-state action grid, not radio semantics,
    // so arrow keys may move focus without changing the persisted selection.
    expect(current.getAttribute("role")).toBeNull();
    expect(current.getAttribute("aria-pressed")).toBe("true");
    expect(choices.filter((choice) => choice.tabIndex === 0)).toEqual([current]);

    choices[1]?.click();
    expect(onAction).toHaveBeenCalledWith({ kind: "set-icon", icon: "🚀" });
    const remove = submenu.querySelector<HTMLButtonElement>(".session-menu__icon-remove");
    expect(remove?.previousElementSibling?.getAttribute("role")).toBe("separator");
    expect(remove?.textContent?.trim()).toBe("Reset to default");
    remove?.click();
    expect(onAction).toHaveBeenCalledWith({ kind: "reset-appearance" });
  });

  it("validates and applies a custom emoji with Enter", async () => {
    const calls: string[] = [];
    const menu = await mountMenu({
      onClose: () => calls.push("close"),
      onAction: (action) =>
        calls.push(`${action.kind}:${action.kind === "set-icon" ? action.icon : ""}`),
    });
    const submenu = menuItem(menu, "Icon & color");
    submenu.querySelector<HTMLButtonElement>('[aria-label="Custom emoji…"]')?.click();
    await menu.updateComplete;

    const input = submenu.querySelector<HTMLInputElement>(".session-menu__icon-custom-input");
    const set = submenu.querySelector<HTMLButtonElement>(".session-menu__icon-set");
    expect(input).not.toBeNull();
    expect(input?.getAttribute("aria-label")).toBe("Custom emoji");
    expect(document.activeElement).toBe(input);
    expect(set?.disabled).toBe(true);

    if (!input) {
      throw new Error("Expected custom emoji input");
    }
    input.value = "a";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await menu.updateComplete;
    expect(submenu.querySelector<HTMLButtonElement>(".session-menu__icon-set")?.disabled).toBe(
      true,
    );

    input.value = "🧜‍♀️";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await menu.updateComplete;
    expect(submenu.querySelector<HTMLButtonElement>(".session-menu__icon-set")?.disabled).toBe(
      false,
    );
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    expect(calls).toEqual(["set-icon:🧜‍♀️"]);
  });

  it("returns from custom entry on Escape without closing the menu", async () => {
    const onClose = vi.fn();
    const menu = await mountMenu({ onClose });
    const submenu = menuItem(menu, "Icon & color");
    submenu.querySelector<HTMLButtonElement>('[aria-label="Custom emoji…"]')?.click();
    await menu.updateComplete;
    const input = submenu.querySelector<HTMLInputElement>(".session-menu__icon-custom-input");
    if (!input) {
      throw new Error("Expected custom emoji input");
    }

    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await menu.updateComplete;

    expect(submenu.querySelector(".session-menu__icon-custom-input")).toBeNull();
    expect(submenu.querySelector('[aria-label="Custom emoji…"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps custom entry open when Web Awesome rebinds its open submenu slot", async () => {
    const menu = await mountMenu();
    const submenu = menuItem(menu, "Icon & color");
    submenu.querySelector<HTMLButtonElement>('[aria-label="Custom emoji…"]')?.click();
    await menu.updateComplete;
    submenu.setAttribute("aria-expanded", "true");

    submenu.dispatchEvent(
      new CustomEvent("submenu-opening", {
        bubbles: true,
        composed: true,
        detail: { item: submenu },
      }),
    );
    await menu.updateComplete;

    expect(submenu.querySelector(".session-menu__icon-custom-input")).not.toBeNull();
  });

  it("marks and dispatches named glyph icons", async () => {
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    const menu = await mountMenu({ session: { icon: "braces" }, onAction });
    const submenu = menuItem(menu, "Icon & color");
    const braces = submenu.querySelector<HTMLButtonElement>('[aria-label="braces"]');
    const book = submenu.querySelector<HTMLButtonElement>('[aria-label="book"]');

    expect(braces?.getAttribute("aria-pressed")).toBe("true");
    expect(braces?.tabIndex).toBe(0);
    book?.click();
    expect(onAction).toHaveBeenCalledWith({ kind: "set-icon", icon: "book" });
  });

  it("moves icon-grid focus by cell and row with arrow keys", async () => {
    const menu = await mountMenu({ session: { icon: "🚀" } });
    const submenu = menuItem(menu, "Icon & color");
    const choices = iconChoices(submenu);
    choices[1]?.focus();

    choices[1]?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(choices[2]);
    choices[2]?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(choices[8]);
    expect(choices.filter((choice) => choice.tabIndex === 0)).toEqual([choices[8]]);
  });

  it("omits Remove from group when the session has no category", async () => {
    const menu = await mountMenu({ groups: ["Research"] });

    const submenu = menuItem(menu, "Move to group");

    expect(menuItemLabels(submenu)).not.toContain("Remove from group");
  });

  it("names Groups as the destination when clearing the category returns there", async () => {
    const onAction = vi.fn<(action: SessionMenuAction) => void>();
    const menu = await mountMenu({
      session: { category: "Done", categoryClearReturnsToGroups: true },
      groups: ["Done"],
      onAction,
    });
    const submenu = menuItem(menu, "Move to group");

    expect(menuItemLabels(submenu)).toContain("Move back to Groups");
    expect(menuItemLabels(submenu)).not.toContain("Remove from group");

    menuItem(submenu, "Move back to Groups").click();
    expect(onAction).toHaveBeenCalledWith({ kind: "move-to-group", category: null });
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

    const keydown = new KeyboardEvent("keydown", {
      key: "٢",
      code: "Digit2",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(keydown);
    expect(onAction).toHaveBeenCalledWith({ kind: "move-to-group", category: "Projects" });
    expect(keydown.defaultPrevented).toBe(true);
  });

  it("keeps conversation destinations without showing absent workspace actions", async () => {
    const menu = await mountMenu();

    expect(menuItemLabels(menu)).not.toContain("Open PR");
    expect(menuItemLabels(menuItem(menu, "Open in"))).toEqual(["New tab", "New window"]);
  });

  it("hides unresolved work actions while keeping conversation destinations available", async () => {
    const menu = await mountMenu({
      work: { loading: true, pullRequestUrl: null, worktreePath: null },
    });

    expect(menuItemLabels(menu)).not.toContain("Open PR");
    expect(menuItemLabels(menuItem(menu, "Open in"))).toEqual(["New tab", "New window"]);
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
    expect(openPr.hasAttribute("data-new-tab-action")).toBe(true);
    expect(openPr.querySelector(".session-menu__shortcut")?.textContent).toBe("G");
    expect(menuItemLabels(menuItem(menu, "Open in"))).toEqual(["New tab", "New window"]);

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

    expect(menuItemLabels(menu)).not.toContain("Open PR");
    const openIn = menuItem(menu, "Open in");
    (openIn as SessionMenuItem & { submenuOpen: boolean }).submenuOpen = true;

    expect(menuItemLabels(openIn)).toEqual([
      "New tab",
      "New window",
      "Cursor",
      "VS Code",
      "Windsurf",
      "Zed",
    ]);
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

    const pin = menuItem(menu, "Pin session");
    expect(pin.querySelector(".session-menu__shortcut")?.textContent).toBe("P");
    expect(pin.getAttribute("aria-keyshortcuts")).toBe("P");
    expect(menuItem(menu, "Move to group").dataset.shortcut).toBeUndefined();

    const keydown = new KeyboardEvent("keydown", {
      key: "з",
      code: "KeyP",
      bubbles: true,
      cancelable: true,
    });
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

  it("returns focus to its durable trigger before a Tab leaves the menu", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    containers.push(trigger);
    const menu = await mountMenu({ trigger });
    const item = menuItem(menu, "Pin session");
    item.focus();

    const keydown = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    item.dispatchEvent(keydown);

    expect(document.activeElement).toBe(trigger);
    expect(keydown.defaultPrevented).toBe(false);
  });

  it("does not reclaim focus when Tab originates outside the open menu", async () => {
    const trigger = document.createElement("button");
    const outside = document.createElement("button");
    document.body.append(trigger, outside);
    containers.push(trigger, outside);
    await mountMenu({ trigger });
    outside.focus();

    outside.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );

    expect(document.activeElement).toBe(outside);
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
