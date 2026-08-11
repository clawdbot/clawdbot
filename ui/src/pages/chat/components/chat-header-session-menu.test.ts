/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiSettings } from "../../../app/settings.ts";
import { icons } from "../../../components/icons.ts";
import type { SessionMenuActionKind } from "../../../components/session-menu.ts";
import "./chat-header-session-menu.ts";
import type { HeaderMenuAction, HeaderMenuQuickAction } from "./chat-header-session-menu.ts";

type HeaderMenuElement = HTMLElement & { updateComplete: Promise<boolean> };
type MenuItemElement = HTMLElement & { checked: boolean; disabled: boolean; submenuOpen?: boolean };

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

function settings(): UiSettings {
  return {
    gatewayUrl: "ws://localhost:18789",
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
    theme: "claw",
    themeMode: "dark",
    chatShowThinking: true,
    chatShowToolCalls: true,
    chatPersistCommentary: true,
    navCollapsed: false,
    navWidth: 280,
    sidebarEntries: [],
  };
}

async function mountMenu(
  options: {
    worktreePath?: string | null;
    archived?: boolean;
    onboarding?: boolean;
    preferencesBrowserOnly?: boolean;
    compact?: boolean;
    settings?: UiSettings;
    panelActions?: HeaderMenuQuickAction[];
    layoutActions?: HeaderMenuQuickAction[];
    actionDisabledReasons?: Partial<Record<SessionMenuActionKind, string>>;
    forkDisabled?: boolean;
    archiveAllowed?: boolean;
    deleteAllowed?: boolean;
    onOpen?: () => void;
    onSettingsChange?: (patch: Partial<UiSettings>) => void;
    onAction?: (action: HeaderMenuAction) => void;
  } = {},
): Promise<HeaderMenuElement> {
  const container = document.createElement("div");
  containers.push(container);
  document.body.append(container);
  render(
    html`<openclaw-chat-header-session-menu
      .sessionLabel=${"Test session"}
      .worktreePath=${options.worktreePath ?? null}
      .archived=${options.archived ?? false}
      .onboarding=${options.onboarding ?? false}
      .preferencesBrowserOnly=${options.preferencesBrowserOnly ?? false}
      .compact=${options.compact ?? false}
      .settings=${options.settings ?? settings()}
      .panelActions=${options.panelActions ?? []}
      .layoutActions=${options.layoutActions ?? []}
      .actionDisabledReasons=${options.actionDisabledReasons ?? {}}
      .forkDisabled=${options.forkDisabled ?? false}
      .archiveAllowed=${options.archiveAllowed ?? true}
      .deleteAllowed=${options.deleteAllowed ?? true}
      .onOpen=${options.onOpen ?? (() => {})}
      .onSettingsChange=${options.onSettingsChange ?? (() => {})}
      .onAction=${options.onAction ?? (() => {})}
    ></openclaw-chat-header-session-menu>`,
    container,
  );
  const menu = container.querySelector<HeaderMenuElement>("openclaw-chat-header-session-menu");
  if (!menu) {
    throw new Error("Expected chat header session menu");
  }
  await menu.updateComplete;
  return menu;
}

function itemLabel(menuItem: HTMLElement): string {
  return menuItem.querySelector(":scope > .session-menu__text")?.textContent?.trim() ?? "";
}

function item(menu: ParentNode, label: string): MenuItemElement {
  const found = Array.from(menu.querySelectorAll<MenuItemElement>("wa-dropdown-item")).find(
    (candidate) => itemLabel(candidate) === label,
  );
  if (!found) {
    throw new Error(`Expected menu item: ${label}`);
  }
  return found;
}

function select(menu: ParentNode, value: string) {
  menu.querySelector("wa-dropdown")?.dispatchEvent(
    new CustomEvent("wa-select", {
      bubbles: true,
      cancelable: true,
      composed: true,
      detail: { item: { value } },
    }),
  );
}

describe("chat header session menu", () => {
  it("renders the curated session actions in order", async () => {
    const menu = await mountMenu();
    const labels = Array.from(
      menu.querySelectorAll<MenuItemElement>(":scope > wa-dropdown > wa-dropdown-item"),
    ).map(itemLabel);

    expect(labels).toEqual(["Rename…", "View", "Fork", "Archive session", "Delete…"]);
    expect(
      menu.querySelector(".chat-header-session-menu__trigger")?.getAttribute("aria-label"),
    ).toBe("Actions for Test session");
  });

  it("shows Open in only for a known path and dispatches the selected editor", async () => {
    const plain = await mountMenu();
    expect(
      Array.from(
        plain.querySelectorAll<MenuItemElement>(":scope > wa-dropdown > wa-dropdown-item"),
      ).map(itemLabel),
    ).not.toContain("Open in");
    const onAction = vi.fn<(action: HeaderMenuAction) => void>();
    const menu = await mountMenu({ worktreePath: "/work/openclaw", onAction });
    const openIn = item(menu, "Open in");

    expect(
      Array.from(openIn.querySelectorAll<MenuItemElement>("wa-dropdown-item[slot='submenu']")).map(
        itemLabel,
      ),
    ).toEqual(["Cursor", "VS Code", "Windsurf", "Zed"]);
    select(menu, "open-in:vscode");
    expect(onAction).toHaveBeenCalledWith({
      kind: "open-in",
      editor: "vscode",
      path: "/work/openclaw",
    });
  });

  it("keeps the three view preferences and browser-only provenance in the submenu", async () => {
    const onSettingsChange = vi.fn<(patch: Partial<UiSettings>) => void>();
    const menu = await mountMenu({ preferencesBrowserOnly: true, onSettingsChange });
    const view = item(menu, "View");
    const viewItems = Array.from(
      view.querySelectorAll<MenuItemElement>("wa-dropdown-item[slot='submenu']"),
    );

    expect(viewItems.map(itemLabel)).toEqual(["Reasoning", "Tool calls", "Keep commentary"]);
    expect(viewItems.map((entry) => entry.checked)).toEqual([true, true, true]);
    expect(view.querySelector('[role="note"]')?.textContent?.trim()).toBe(
      "Stored in this browser only.",
    );
    select(menu, "view:reasoning");
    select(menu, "view:tool-calls");
    select(menu, "view:commentary");
    expect(onSettingsChange.mock.calls).toEqual([
      [{ chatShowThinking: false }],
      [{ chatShowToolCalls: false }],
      [{ chatPersistCommentary: false }],
    ]);
  });

  it("keeps panel and layout actions available from the session menu", async () => {
    const showTasks = vi.fn();
    const showChanges = vi.fn();
    const splitRight = vi.fn();
    const menu = await mountMenu({
      panelActions: [
        {
          id: "background-tasks",
          label: "Show background tasks",
          icon: icons.listChecks,
          active: false,
          badge: 2,
          onActivate: showTasks,
        },
        {
          id: "changes",
          label: "Show session changes",
          icon: icons.fileDiff,
          disabledReason: "This session's workspace is not a git checkout.",
          onActivate: showChanges,
        },
      ],
      layoutActions: [
        {
          id: "split-right",
          label: "Split right",
          icon: icons.panelRightOpen,
          onActivate: splitRight,
        },
      ],
    });

    const panels = item(menu, "Panels");
    const panelItems = Array.from(
      panels.querySelectorAll<MenuItemElement>("wa-dropdown-item[slot='submenu']"),
    );
    expect(panelItems.map(itemLabel)).toEqual(["Show background tasks", "Show session changes"]);
    expect(panelItems[0]?.checked).toBe(false);
    expect(panelItems[0]?.querySelector('[slot="details"]')?.textContent?.trim()).toBe("2");
    expect(panelItems[1]?.disabled).toBe(true);
    expect(
      Array.from(
        item(menu, "Layout").querySelectorAll<MenuItemElement>("wa-dropdown-item[slot='submenu']"),
      ).map(itemLabel),
    ).toEqual(["Split right"]);

    select(menu, "quick:panels:background-tasks");
    select(menu, "quick:panels:changes");
    select(menu, "quick:layout:split-right");
    expect(showTasks).toHaveBeenCalledOnce();
    expect(showChanges).not.toHaveBeenCalled();
    expect(splitRight).toHaveBeenCalledOnce();
  });

  it("renders quick actions directly in the compact menu", async () => {
    const showTasks = vi.fn();
    const menu = await mountMenu({
      compact: true,
      panelActions: [
        {
          id: "background-tasks",
          label: "Show background tasks",
          icon: icons.listChecks,
          badge: 2,
          onActivate: showTasks,
        },
      ],
    });

    expect(menu.querySelector(".session-menu__section-label")?.textContent?.trim()).toBe("Panels");
    const action = item(menu, "Show background tasks");
    expect(action.getAttribute("slot")).toBeNull();
    expect(action.querySelector('[slot="details"]')?.textContent?.trim()).toBe("2");

    select(menu, "quick:panels:background-tasks");
    expect(showTasks).toHaveBeenCalledOnce();
  });

  it("pins and disables onboarding view preferences", async () => {
    const onSettingsChange = vi.fn<(patch: Partial<UiSettings>) => void>();
    const menu = await mountMenu({ onboarding: true, onSettingsChange });
    const viewItems = Array.from(
      item(menu, "View").querySelectorAll<MenuItemElement>("wa-dropdown-item[slot='submenu']"),
    );

    expect(viewItems.map((entry) => entry.checked)).toEqual([false, true, true]);
    expect(viewItems.every((entry) => entry.disabled)).toBe(true);
    expect(
      viewItems.every((entry) => entry.getAttribute("title") === "Disabled during setup"),
    ).toBe(true);
    select(menu, "view:reasoning");
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("honors action gating and bare-letter shortcuts", async () => {
    const onAction = vi.fn<(action: HeaderMenuAction) => void>();
    const menu = await mountMenu({
      actionDisabledReasons: { rename: "Operator write access is required." },
      archiveAllowed: false,
      deleteAllowed: false,
      onAction,
    });
    const dropdown = menu.querySelector("wa-dropdown");

    expect(item(menu, "Rename…").disabled).toBe(true);
    expect(item(menu, "Archive session").disabled).toBe(true);
    expect(item(menu, "Delete…").disabled).toBe(true);
    dropdown?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true }),
    );
    expect(onAction).toHaveBeenCalledWith({ kind: "fork" });
    onAction.mockClear();
    dropdown?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }),
    );
    expect(onAction).not.toHaveBeenCalled();
  });
});
