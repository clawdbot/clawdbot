/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { UiSettings } from "../../../app/settings.ts";
import { icons } from "../../../components/icons.ts";
import type { SessionMenuData } from "../../../components/session-menu-actions.ts";
import type { SessionOwnerOption } from "../../../components/session-owner-chip.ts";
import type { SessionCapability } from "../../../lib/sessions/index.ts";
import {
  clearNativeGatewayTestState,
  setNativeGatewayTestState,
} from "../../../test-helpers/native-gateways.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "../chat-pane.test-support.ts";
import type { ChatPageHost } from "../chat-state-host.ts";
import { createBackgroundTasksProps } from "./chat-background-tasks.ts";
import type {
  HeaderMenuAction,
  HeaderMenuActionKind,
  HeaderMenuQuickAction,
  HeaderMenuStatusAction,
} from "./chat-header-session-menu.ts";
import "./chat-header-session-menu.ts";
import type { ChatSessionSharingProps } from "./chat-session-sharing.ts";
import { createSessionWorkspaceProps } from "./chat-session-workspace.ts";

type HeaderMenuElement = HTMLElement & { updateComplete: Promise<boolean> };
type MenuItemElement = HTMLElement & { checked: boolean; disabled: boolean; submenuOpen?: boolean };

const containers: HTMLElement[] = [];

afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
  clearNativeGatewayTestState();
  vi.restoreAllMocks();
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
    session?: Partial<SessionMenuData>;
    worktreePath?: string | null;
    onboarding?: boolean;
    preferencesBrowserOnly?: boolean;
    compact?: boolean;
    settings?: UiSettings;
    panelActions?: HeaderMenuQuickAction[];
    layoutActions?: HeaderMenuQuickAction[];
    statusActions?: HeaderMenuStatusAction[];
    sharing?: ChatSessionSharingProps | null;
    ownerOptions?: SessionOwnerOption[];
    selfOwner?: SessionOwnerOption | null;
    currentOwnerId?: string | null;
    actionDisabledReasons?: Partial<Record<HeaderMenuActionKind, string>>;
    forkDisabled?: boolean;
    forkFromLastCompleted?: boolean;
    archiveAllowed?: boolean;
    deleteAllowed?: boolean;
    onOpen?: () => void;
    onOpenCommandPalette?: () => void;
    onSettingsChange?: (patch: Partial<UiSettings>) => void;
    onAction?: (action: HeaderMenuAction) => void;
  } = {},
): Promise<HeaderMenuElement> {
  const container = document.createElement("div");
  containers.push(container);
  document.body.append(container);
  render(
    html`<openclaw-chat-header-session-menu
      .session=${{
        label: "Test session",
        sessionId: "session-123",
        pinned: false,
        unread: false,
        archived: false,
        category: null,
        icon: null,
        categoryClearReturnsToGroups: false,
        ...options.session,
      }}
      .worktreePath=${options.worktreePath ?? null}
      .onboarding=${options.onboarding ?? false}
      .preferencesBrowserOnly=${options.preferencesBrowserOnly ?? false}
      .compact=${options.compact ?? false}
      .settings=${options.settings ?? settings()}
      .panelActions=${options.panelActions ?? []}
      .layoutActions=${options.layoutActions ?? []}
      .statusActions=${options.statusActions ?? []}
      .sharing=${options.sharing ?? null}
      .groups=${["Projects"]}
      .ownerOptions=${options.ownerOptions ?? []}
      .selfOwner=${options.selfOwner ?? null}
      .currentOwnerId=${options.currentOwnerId ?? null}
      .actionDisabledReasons=${options.actionDisabledReasons ?? {}}
      .forkDisabled=${options.forkDisabled ?? false}
      .forkFromLastCompleted=${options.forkFromLastCompleted ?? false}
      .archiveAllowed=${options.archiveAllowed ?? true}
      .deleteAllowed=${options.deleteAllowed ?? true}
      .onOpen=${options.onOpen ?? (() => {})}
      .onOpenCommandPalette=${options.onOpenCommandPalette ?? (() => {})}
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

function itemLabel(menuItem: Element): string {
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
  it.each([
    { name: "plain browser", nativeGateway: null, offered: false },
    { name: "native local gateway", nativeGateway: "local", offered: true },
    { name: "native remote gateway", nativeGateway: "remote", offered: false },
    {
      name: "SSH-tunneled remote native gateway",
      nativeGateway: "remote",
      gatewayUrl: "ws://127.0.0.1:18789",
      offered: false,
    },
    {
      name: "remote execution node",
      nativeGateway: "local",
      execNode: "build-mac",
      offered: false,
    },
  ] as const)(
    "offers session editors only for native-local workspaces: $name",
    async (testCase) => {
      setNativeGatewayTestState(testCase.nativeGateway);
      const client = {
        gatewayUrl: "gatewayUrl" in testCase ? testCase.gatewayUrl : "ws://localhost:18789",
      } as GatewayBrowserClient;
      const { pane, state } = createTestChatPane({ client, sessions: {} as SessionCapability });
      const session = {
        key: state.sessionKey,
        kind: "direct" as const,
        updatedAt: 0,
        spawnedWorkspaceDir: "/workspace",
        ...("execNode" in testCase
          ? { execNode: testCase.execNode, execCwd: "/remote/workspace" }
          : {}),
      };
      state.settings = {} as ChatPageHost["settings"];
      const container = document.createElement("div");
      document.body.append(container);
      containers.push(container);
      render(
        pane.renderPaneHeader(
          createSessionWorkspaceProps(state),
          createBackgroundTasksProps(state),
          session,
          false,
          undefined,
          false,
        ),
        container,
      );
      const menu = container.querySelector<HeaderMenuElement>("openclaw-chat-header-session-menu");
      await menu?.updateComplete;

      expect(menu?.textContent?.includes("Open in")).toBe(testCase.offered);
      expect(menu?.textContent?.includes("Cursor")).toBe(testCase.offered);
    },
  );

  it("renders pane actions plus the canonical session actions in order", async () => {
    const menu = await mountMenu();
    const labels = Array.from(
      menu.querySelectorAll<MenuItemElement>(":scope > wa-dropdown > wa-dropdown-item"),
    ).map(itemLabel);

    expect(labels).toEqual([
      "View",
      "Pin session",
      "Mark as unread",
      "Rename…",
      "Set icon",
      "Fork",
      "Copy session ID",
      "Move to group",
      "Continue in terminal…",
      "Archive session",
      "Delete…",
    ]);
    expect(
      menu.querySelector(".chat-header-session-menu__trigger")?.getAttribute("aria-label"),
    ).toBe("Actions for Test session");
  });

  it("preserves row-discovered groups when the gateway catalog lags", async () => {
    const session = {
      key: "agent:main:current",
      kind: "direct" as const,
      updatedAt: 2,
    };
    const sessions = createSessionCapabilityFixture({
      state: {
        error: null,
        groups: ["Catalog"],
        result: {
          count: 2,
          path: "",
          ts: 2,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [
            session,
            {
              key: "agent:main:discovered",
              kind: "direct",
              updatedAt: 1,
              category: "Discovered",
            },
          ],
        },
      },
    });
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture(),
      sessions,
    });
    state.settings = {} as ChatPageHost["settings"];
    const container = document.createElement("div");
    document.body.append(container);
    containers.push(container);
    render(
      pane.renderPaneHeader(
        createSessionWorkspaceProps(state),
        createBackgroundTasksProps(state),
        session,
        false,
        undefined,
        false,
      ),
      container,
    );
    const menu = container.querySelector<HeaderMenuElement>("openclaw-chat-header-session-menu");
    if (!menu) {
      throw new Error("Expected chat header session menu");
    }
    await menu.updateComplete;

    const moveToGroup = item(menu, "Move to group");
    const groupLabels = Array.from(
      moveToGroup.querySelectorAll<MenuItemElement>("wa-dropdown-item[slot='submenu']"),
    ).map(itemLabel);
    expect(groupLabels).toEqual(["Catalog", "Discovered", "New group…"]);
  });

  it("dispatches canonical session actions from the header surface", async () => {
    const onAction = vi.fn<(action: HeaderMenuAction) => void>();
    const menu = await mountMenu({ onAction });

    for (const value of [
      "toggle-pin",
      "toggle-unread",
      "set-icon:%F0%9F%A6%9E",
      "copy-session-id",
      "move-to-group:Projects",
    ]) {
      select(menu, value);
    }

    expect(onAction.mock.calls).toEqual([
      [{ kind: "toggle-pin" }],
      [{ kind: "toggle-unread" }],
      [{ kind: "set-icon", icon: "🦞" }],
      [{ kind: "copy-session-id" }],
      [{ kind: "move-to-group", category: "Projects" }],
    ]);
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
          icon: icons.diff,
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
    expect(
      Array.from(
        item(menu, "Layout").querySelectorAll<MenuItemElement>("wa-dropdown-item[slot='submenu']"),
      ).map(itemLabel),
    ).toEqual(["Split right"]);

    select(menu, "quick:panels:background-tasks");
    select(menu, "quick:panels:changes");
    select(menu, "quick:layout:split-right");
    expect(showTasks).toHaveBeenCalledOnce();
    expect(showChanges).toHaveBeenCalledOnce();
    expect(splitRight).toHaveBeenCalledOnce();
  });

  it("offers direct and submenu owner assignment", async () => {
    const onAction = vi.fn<(action: HeaderMenuAction) => void>();
    const ada = { type: "human", id: "profile-ada", label: "Ada" } as const;
    const research = { type: "agent", id: "research:one", label: "Research" } as const;
    const menu = await mountMenu({
      ownerOptions: [ada, research],
      selfOwner: ada,
      currentOwnerId: research.id,
      onAction,
    });

    expect(item(menu, "Assign to me").disabled).toBe(false);
    const submenu = item(menu, "Assign to…");
    expect(
      Array.from(submenu.querySelectorAll("wa-dropdown-item[slot='submenu']")).map(itemLabel),
    ).toEqual(["Ada", "Research"]);
    const selected = item(menu, "Research");
    expect(selected.getAttribute("role")).toBe("menuitemradio");
    expect(selected.getAttribute("aria-checked")).toBe("true");
    expect(selected.disabled).toBe(true);
    expect(selected.querySelector("[slot='details']")).not.toBeNull();

    select(menu, item(menu, "Assign to me").getAttribute("value") ?? "");
    select(menu, "assign-owner:agent:research%3Aone");
    expect(onAction.mock.calls).toEqual([
      [{ kind: "assign-owner", owner: { type: "human", id: "profile-ada" } }],
      [{ kind: "assign-owner", owner: { type: "agent", id: "research:one" } }],
    ]);
  });

  it("drills into compact menu groups without rendering side flyouts", async () => {
    const showTasks = vi.fn();
    const showAccess = vi.fn();
    const onOpenCommandPalette = vi.fn();
    const onSettingsChange = vi.fn<(patch: Partial<UiSettings>) => void>();
    const onAction = vi.fn<(action: HeaderMenuAction) => void>();
    const ada = { type: "human", id: "profile-ada", label: "Ada" } as const;
    const research = { type: "agent", id: "research:one", label: "Research" } as const;
    const menu = await mountMenu({
      compact: true,
      worktreePath: "/work/openclaw",
      panelActions: [
        {
          id: "background-tasks",
          label: "Show background tasks",
          icon: icons.listChecks,
          badge: 2,
          onActivate: showTasks,
        },
      ],
      layoutActions: [
        {
          id: "split-right",
          label: "Split right",
          icon: icons.panelRightOpen,
          onActivate: vi.fn(),
        },
      ],
      statusActions: [
        {
          id: "access",
          label: "Limited access",
          icon: icons.shieldQuestion,
          tone: "warn",
          onActivate: showAccess,
        },
      ],
      ownerOptions: [ada, research],
      selfOwner: ada,
      currentOwnerId: research.id,
      onOpenCommandPalette,
      onSettingsChange,
      onAction,
    });

    const rootLabels = Array.from(
      menu.querySelectorAll<MenuItemElement>(":scope > wa-dropdown > wa-dropdown-item"),
    ).map(itemLabel);
    expect(rootLabels).toEqual([
      "Open command palette",
      "Limited access",
      "Open in",
      "Panels",
      "Layout",
      "View",
      "Pin session",
      "Mark as unread",
      "Rename…",
      "Assign to…",
      "Set icon",
      "Fork",
      "Copy session ID",
      "Move to group",
      "Continue in terminal…",
      "Archive session",
      "Delete…",
    ]);
    expect(menu.querySelector("[slot='submenu']")).toBeNull();
    expect(
      menu.querySelector('.chat-header-session-menu__status-dot[data-tone="warn"]'),
    ).not.toBeNull();

    select(menu, "open-command-palette");
    expect(onOpenCommandPalette).toHaveBeenCalledOnce();
    const dropdown = menu.querySelector<HTMLElement & { open: boolean }>("wa-dropdown");
    if (dropdown) {
      dropdown.open = true;
    }
    select(menu, "status:access");
    expect(showAccess).toHaveBeenCalledOnce();
    expect(dropdown?.open).toBe(false);

    select(menu, "compact:open-view");
    await menu.updateComplete;
    expect(
      Array.from(
        menu.querySelectorAll<MenuItemElement>(":scope > wa-dropdown > wa-dropdown-item"),
      ).map(itemLabel),
    ).toEqual(["Back", "Reasoning", "Tool calls", "Keep commentary"]);
    expect(menu.querySelector("[slot='submenu']")).toBeNull();
    select(menu, "view:reasoning");
    expect(onSettingsChange).toHaveBeenCalledWith({ chatShowThinking: false });

    select(menu, "compact:back");
    await menu.updateComplete;
    select(menu, "compact:open-panels");
    await menu.updateComplete;
    const action = item(menu, "Show background tasks");
    expect(action.querySelector('[slot="details"]')?.textContent?.trim()).toBe("2");

    select(menu, "quick:panels:background-tasks");
    expect(showTasks).toHaveBeenCalledOnce();

    select(menu, "compact:open-assign-owner");
    await menu.updateComplete;
    expect(
      Array.from(
        menu.querySelectorAll<MenuItemElement>(":scope > wa-dropdown > wa-dropdown-item"),
      ).map(itemLabel),
    ).toEqual(["Back", "Ada", "Research"]);
    select(menu, "assign-owner:human:profile-ada");
    expect(onAction).toHaveBeenCalledWith({
      kind: "assign-owner",
      owner: { type: "human", id: "profile-ada" },
    });
  });

  it("drills into session sharing only from the compact menu", async () => {
    const onOpen = vi.fn();
    const onVisibilityChange = vi.fn();
    const sharing = {
      session: {
        key: "agent:main:shared",
        kind: "direct",
        updatedAt: 1,
        visibility: "draft",
        sharingRole: "owner",
      },
      state: {
        loading: false,
        result: {
          sessionKey: "agent:main:shared",
          owner: { type: "human", id: "owner", label: "Owner" },
          members: [],
          identities: [{ type: "human", id: "vyctor", label: "Vyctor" }],
          role: "owner",
          allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
        },
      },
      onOpen,
      onVisibilityChange,
      onMemberChange: vi.fn(),
    } satisfies ChatSessionSharingProps;

    const desktop = await mountMenu({ sharing });
    expect(desktop.textContent).not.toContain("Session sharing");

    const compact = await mountMenu({ compact: true, sharing });
    select(compact, "compact:open-sharing");
    await compact.updateComplete;
    expect(onOpen).toHaveBeenCalledOnce();
    expect(
      Array.from(
        compact.querySelectorAll<MenuItemElement>(":scope > wa-dropdown > wa-dropdown-item"),
      ).map(itemLabel),
    ).toEqual(["Back", "Publish draft", "Read-only", "Suggest", "Draft", "Vyctor"]);
    expect(
      compact
        .querySelector(".chat-pane__publish-draft")
        ?.classList.contains("session-menu__item"),
    ).toBe(true);
    select(compact, "visibility:read-only");
    expect(onVisibilityChange).toHaveBeenCalledWith("read-only");
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

  it("names the stable fork boundary for an active session", async () => {
    const menu = await mountMenu({ forkFromLastCompleted: true });

    expect(item(menu, "Fork from last completed message")).toBeDefined();
  });

  it("emits terminal continuation only while the current Gateway is connected", async () => {
    const onAction = vi.fn<(action: HeaderMenuAction) => void>();
    const connected = await mountMenu({ onAction });

    expect(item(connected, "Continue in terminal…").disabled).toBe(false);
    const dropdown = connected.querySelector("wa-dropdown") as HTMLElement & { open: boolean };
    dropdown.open = true;
    select(connected, "continue-in-terminal");
    expect(dropdown.open).toBe(false);
    expect(onAction).toHaveBeenCalledWith({ kind: "continue-in-terminal" });

    const disconnected = await mountMenu({
      actionDisabledReasons: { "continue-in-terminal": "Gateway disconnected." },
      onAction,
    });
    const disabledAction = item(disconnected, "Continue in terminal…");
    expect(disabledAction.disabled).toBe(true);
    expect(disabledAction.getAttribute("title")).toBe("Gateway disconnected.");
    onAction.mockClear();
    select(disconnected, "continue-in-terminal");
    expect(onAction).not.toHaveBeenCalled();
  });
});
