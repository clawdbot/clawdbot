import { describe, expect, it, vi } from "vitest";
import type {
  SessionCatalog,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  loadStoredHiddenSessionCatalogIds,
  setStoredSessionCatalogHidden,
} from "../../components/app-sidebar-session-types.ts";
import { TERMINAL_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessions,
  mountSidebar,
} from "../app-sidebar.ts";
import {
  answerConfirmDialog,
  installDialogPolyfill,
  waitForConfirmDialogActions,
} from "../modal-dialog.ts";
import { waitForFast } from "../wait-for.ts";
import {
  click,
  mountMultiSelect,
  openContextMenu,
  rowLink,
  selectedRowKeys,
  sessionMenu,
} from "./multi-select-support.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar context menu boundary", () => {
  it("suppresses native menus except on editable controls", async () => {
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      createSessions("main", ["agent:main:main"]),
    );
    const aside = sidebar.querySelector<HTMLElement>("aside.sidebar");
    const footer = sidebar.querySelector<HTMLElement>(".sidebar-shell__footer");
    if (!aside || !footer) {
      throw new Error("expected sidebar chrome");
    }

    const chromeMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    footer.dispatchEvent(chromeMenu);
    expect(chromeMenu.defaultPrevented).toBe(true);

    const input = document.createElement("input");
    aside.append(input);
    const editableMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    input.dispatchEvent(editableMenu);
    expect(editableMenu.defaultPrevented).toBe(false);
  });
});

describe("AppSidebar multi-select", () => {
  it("names each session's pin and menu buttons after their owning session", async () => {
    const { sidebar } = await mountMultiSelect();

    for (const key of ["agent:main:a", "agent:main:b"]) {
      const row = sidebar.querySelector<HTMLElement>(`[data-session-key="${key}"]`);
      const label = row?.querySelector(".sidebar-recent-session__name")?.textContent?.trim();
      expect(label).toBeTruthy();
      expect(row?.querySelector("[data-sidebar-session-pin]")?.getAttribute("aria-label")).toBe(
        `Pin session: ${label}`,
      );
      expect(row?.querySelector("[data-session-menu]")?.getAttribute("aria-label")).toBe(
        `Open session menu: ${label}`,
      );
    }
  });

  it("restores the thread action anchor when Tab exits its keyboard context menu", async () => {
    const { sidebar } = await mountMultiSelect();
    const link = rowLink(sidebar, "agent:main:a");
    const trigger = sidebar.querySelector<HTMLElement>(
      '[data-session-key="agent:main:a"] [data-session-menu]',
    );
    link.focus();
    link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;

    const menu = await sessionMenu(sidebar);
    const item = menu.querySelector<HTMLElement>("wa-dropdown-item:not([disabled])");
    item?.focus();
    item?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );

    expect(document.activeElement).toBe(trigger);
  });

  it("cmd-click toggles rows into the selection and plain click clears it", async () => {
    const { sidebar } = await mountMultiSelect();

    click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
    click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
    await sidebar.updateComplete;
    expect(selectedRowKeys(sidebar)).toEqual(["agent:main:a", "agent:main:b"]);

    click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
    await sidebar.updateComplete;
    expect(selectedRowKeys(sidebar)).toEqual(["agent:main:a"]);

    click(rowLink(sidebar, "agent:main:c"));
    await sidebar.updateComplete;
    expect(selectedRowKeys(sidebar)).toEqual([]);
  });

  it("shift-click extends the selection from the anchor across the visible order", async () => {
    const { sidebar } = await mountMultiSelect();

    click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
    click(rowLink(sidebar, "agent:main:c"), { shiftKey: true });
    await sidebar.updateComplete;

    expect(selectedRowKeys(sidebar)).toEqual(["agent:main:a", "agent:main:b", "agent:main:c"]);
  });

  it("archives every selected session from the batch menu", async () => {
    const { sidebar, harness } = await mountMultiSelect();

    click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
    click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
    await sidebar.updateComplete;
    openContextMenu(sidebar, "agent:main:a");
    await sidebar.updateComplete;

    const menu = await sessionMenu(sidebar);
    expect(menu.selectionCount).toBe(2);
    // Batch menus drop single-session actions like Rename.
    expect(menu.querySelector('[data-shortcut="r"]')).toBeNull();
    menu.querySelector<HTMLButtonElement>('[data-shortcut="a"]')?.click();

    await waitForFast(() => expect(harness.patchMany).toHaveBeenCalledOnce());
    expect(harness.patchMany).toHaveBeenCalledWith(
      [
        {
          key: "agent:main:a",
          agentId: "main",
          expectedSessionId: "session:agent:main:a",
        },
        {
          key: "agent:main:b",
          agentId: "main",
          expectedSessionId: "session:agent:main:b",
        },
      ],
      { archived: true },
    );
    expect(harness.patch).not.toHaveBeenCalled();
    await waitForFast(() => expect(harness.refreshReplacement).toHaveBeenCalledTimes(1));
    expect(harness.refreshReplacement).toHaveBeenCalledWith("main");
  });

  it("marks every selected session unread through patchMany", async () => {
    const { sidebar, harness } = await mountMultiSelect(["sessions.patchMany"]);

    click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
    click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
    await sidebar.updateComplete;
    openContextMenu(sidebar, "agent:main:a");
    await sidebar.updateComplete;
    (await sessionMenu(sidebar)).querySelector<HTMLButtonElement>('[data-shortcut="u"]')?.click();

    await waitForFast(() => expect(harness.patchMany).toHaveBeenCalledOnce());
    expect(harness.patchMany).toHaveBeenCalledWith(
      [
        { key: "agent:main:a", agentId: "main" },
        { key: "agent:main:b", agentId: "main" },
      ],
      { unread: true },
    );
    expect(harness.patch).not.toHaveBeenCalled();
    await waitForFast(() => expect(harness.refreshReplacement).toHaveBeenCalledOnce());
  });

  it("archives serially when an older Gateway does not advertise patchMany", async () => {
    const { sidebar, harness, request } = await mountMultiSelect(["sessions.patch"]);

    click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
    click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
    await sidebar.updateComplete;
    openContextMenu(sidebar, "agent:main:a");
    await sidebar.updateComplete;

    const menu = await sessionMenu(sidebar);
    const archive = menu.querySelector<HTMLButtonElement>('[data-shortcut="a"]');
    expect(archive?.disabled).toBe(false);
    archive?.click();

    await waitForFast(() => expect(harness.patch).toHaveBeenCalledTimes(2));
    expect(harness.patch).toHaveBeenNthCalledWith(
      1,
      "agent:main:a",
      { archived: true },
      {
        agentId: "main",
        expectedSessionId: "session:agent:main:a",
        deferListRefresh: true,
      },
    );
    expect(harness.patch).toHaveBeenNthCalledWith(
      2,
      "agent:main:b",
      { archived: true },
      {
        agentId: "main",
        expectedSessionId: "session:agent:main:b",
        deferListRefresh: true,
      },
    );
    expect(harness.patchMany).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([method]) => method === "sessions.patchMany")).toEqual([]);
    await waitForFast(() => expect(harness.refreshReplacement).toHaveBeenCalledOnce());
    expect(harness.refreshReplacement).toHaveBeenCalledWith("main");
  });

  it("archives serially when an older Gateway omits method metadata and rejects patchMany", async () => {
    const rejection = new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "unknown method: sessions.patchMany",
    });
    const { sidebar, harness, request } = await mountMultiSelect(null, rejection);

    click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
    click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
    await sidebar.updateComplete;
    openContextMenu(sidebar, "agent:main:a");
    await sidebar.updateComplete;

    const menu = await sessionMenu(sidebar);
    const archive = menu.querySelector<HTMLButtonElement>('[data-shortcut="a"]');
    expect(archive?.disabled).toBe(false);
    archive?.click();

    await waitForFast(() => expect(harness.patch).toHaveBeenCalledTimes(2));
    expect(harness.patch).toHaveBeenNthCalledWith(
      1,
      "agent:main:a",
      { archived: true },
      {
        agentId: "main",
        expectedSessionId: "session:agent:main:a",
        deferListRefresh: true,
      },
    );
    expect(harness.patch).toHaveBeenNthCalledWith(
      2,
      "agent:main:b",
      { archived: true },
      {
        agentId: "main",
        expectedSessionId: "session:agent:main:b",
        deferListRefresh: true,
      },
    );
    expect(request.mock.calls.filter(([method]) => method === "sessions.patchMany")).toHaveLength(
      1,
    );
    expect(harness.patchMany).not.toHaveBeenCalled();
    await waitForFast(() => expect(harness.refreshReplacement).toHaveBeenCalledOnce());
    expect(harness.refreshReplacement).toHaveBeenCalledWith("main");
  });

  it("deletes the selection in one batch after a single confirm", async () => {
    const restoreDialogPolyfill = installDialogPolyfill();
    try {
      const { sidebar, harness } = await mountMultiSelect();

      click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
      click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
      await sidebar.updateComplete;
      openContextMenu(sidebar, "agent:main:b");
      await sidebar.updateComplete;

      const menu = await sessionMenu(sidebar);
      menu.querySelector<HTMLButtonElement>('[data-shortcut="d"]')?.click();

      const actions = await waitForConfirmDialogActions();
      expect(document.body.querySelector("openclaw-modal-dialog")?.textContent).toContain("2");
      answerConfirmDialog(actions, "confirm");

      await waitForFast(() => expect(harness.deleteMany).toHaveBeenCalledOnce());
      expect(harness.deleteMany).toHaveBeenCalledWith([
        {
          key: "agent:main:a",
          agentId: "main",
          deleteTranscript: true,
          expectedSessionId: "session:agent:main:a",
        },
        {
          key: "agent:main:b",
          agentId: "main",
          deleteTranscript: true,
          expectedSessionId: "session:agent:main:b",
        },
      ]);
    } finally {
      restoreDialogPolyfill();
    }
  });

  it("retargets the menu to an unselected row and drops the selection", async () => {
    const { sidebar } = await mountMultiSelect();

    click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
    click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
    await sidebar.updateComplete;
    openContextMenu(sidebar, "agent:main:c");
    await sidebar.updateComplete;

    expect(selectedRowKeys(sidebar)).toEqual([]);
    const menu = await sessionMenu(sidebar);
    expect(menu.selectionCount).toBe(1);
    expect(menu.querySelector('[data-shortcut="r"]')).not.toBeNull();
  });
});

describe("AppSidebar catalog session rows", () => {
  const catalogList = (
    sessions: Array<Record<string, unknown>>,
    hosts?: SessionCatalog["hosts"],
  ): SessionsCatalogListResult => ({
    catalogs: [
      {
        id: "codex",
        label: "Codex",
        capabilities: { continueSession: true, archive: true },
        hosts: hosts ?? [
          {
            hostId: "gateway:local",
            label: "Local Codex",
            kind: "gateway" as const,
            connected: true,
            sessions: sessions.map((session) => ({
              status: "idle",
              archived: false,
              canContinue: true,
              canArchive: true,
              ...session,
            })) as SessionCatalog["hosts"][number]["sessions"],
          },
        ],
      },
    ],
  });

  async function mountWithCatalog(result: SessionsCatalogListResult, sessionKeys: string[]) {
    const request = vi.fn().mockResolvedValue(result);
    const gateway = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    gateway.publish({
      hello: {
        features: { methods: ["sessions.catalog.list"] },
      } as ApplicationGatewaySnapshot["hello"],
    });
    const { sidebar } = await mountSidebar(gateway.gateway, createSessions("main", sessionKeys));
    sidebar.connected = true;
    await sidebar.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    await sidebar.updateComplete;
    return { sidebar, request };
  }

  it("opens the catalog view menu from its header and hides that section with undo", async () => {
    vi.useFakeTimers();
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    await toastHost.updateComplete;
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList([{ threadId: "thread-1", name: "Release checklist" }]),
        ["agent:main:main"],
      );
      const navigated: Array<[string, unknown]> = [];
      sidebar.onNavigate = (routeId, options) => navigated.push([routeId, options]);
      const header = sidebar.querySelector<HTMLElement>(
        '[data-session-section="catalog:codex"] .sidebar-recent-sessions__head',
      );
      if (!header) {
        throw new Error("expected catalog section header");
      }
      const contextMenu = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 24,
        clientY: 36,
      });
      header.dispatchEvent(contextMenu);
      await sidebar.updateComplete;

      expect(contextMenu.defaultPrevented).toBe(true);
      const menu = sidebar.querySelector<HTMLElement>(".sidebar-catalog-view-menu");
      const hide = menu?.querySelector<HTMLElement>('wa-dropdown-item[value="hide-catalog"]');
      expect(menu).not.toBeNull();
      expect(hide).not.toBeNull();
      menu?.dispatchEvent(new CustomEvent("wa-select", { bubbles: true, detail: { item: hide } }));
      await sidebar.updateComplete;

      expect(loadStoredHiddenSessionCatalogIds().has("codex")).toBe(true);
      expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).toBeNull();

      // Hiding must announce its own outcome: the section name, undo, and a recovery
      // path that opens the settings block instead of only naming it.
      await toastHost.updateComplete;
      const message = toastHost.querySelector(".app-toast__message")?.textContent ?? "";
      expect(message).toContain("Codex");
      expect(message).toContain("Settings > Appearance > Sidebar");

      const recovery = toastHost.querySelector<HTMLAnchorElement>(".app-toast__message a");
      expect(recovery?.getAttribute("href")).toBe(
        "/settings/appearance?section=__appearance__#settings-appearance-sidebar",
      );
      recovery?.click();
      expect(navigated).toEqual([
        ["appearance", { search: "?section=__appearance__", hash: "#settings-appearance-sidebar" }],
      ]);

      toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
      await sidebar.updateComplete;
      expect(loadStoredHiddenSessionCatalogIds().has("codex")).toBe(false);
      expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).not.toBeNull();
    } finally {
      toastHost.remove();
      setStoredSessionCatalogHidden("codex", false);
      vi.useRealTimers();
    }
  });

  it("renders local rows directly and keeps paired-node rows under their host heading", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList(
          [],
          [
            {
              hostId: "gateway:local",
              label: "Local Codex",
              kind: "gateway",
              connected: true,
              sessions: [
                {
                  threadId: "thread-local",
                  name: "Local session",
                  status: "idle",
                  archived: false,
                  canContinue: true,
                  canArchive: true,
                },
              ],
            },
            {
              hostId: "node:devbox",
              label: "Dev Box",
              kind: "node",
              nodeId: "devbox",
              connected: true,
              sessions: [
                {
                  threadId: "thread-node",
                  name: "Node session",
                  status: "stored",
                  archived: false,
                  canContinue: false,
                  canArchive: false,
                },
              ],
            },
          ],
        ),
        ["agent:main:main"],
      );

      const section = sidebar.querySelector('[data-session-section="catalog:codex"]');
      const local = section?.querySelector('[data-session-catalog-host="gateway:local"]');
      const node = section?.querySelector('[data-session-catalog-host="node:devbox"]');
      // Counts only render while a catalog section is collapsed.
      expect(section?.querySelector(".sidebar-session-group-count")).toBeNull();
      expect(local?.querySelector(".sidebar-session-catalog-host__head")).toBeNull();
      expect(local?.textContent).toContain("Local session");
      expect(local?.textContent).not.toContain("Node session");
      expect(node?.querySelector(".sidebar-session-catalog-host__label")?.textContent).toBe(
        "Dev Box",
      );
      expect(node?.textContent).toContain("Node session");
      expect(node?.textContent).not.toContain("Local session");

      // Collapsing the catalog surfaces the row count as the closed-state indicator.
      section?.querySelector<HTMLButtonElement>(".sidebar-session-group-toggle")?.click();
      await sidebar.updateComplete;
      const collapsedSection = sidebar.querySelector('[data-session-section="catalog:codex"]');
      expect(
        collapsedSection?.querySelector(".sidebar-session-group-count")?.textContent?.trim(),
      ).toBe("2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes terminal-preferred clicks to a typed terminal toggle", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList([{ threadId: "thread-1", name: "Resume me", canOpenTerminal: true }]),
        ["agent:main:main"],
      );
      sidebar.catalogOpenTarget = "terminal";
      sidebar.terminalAvailable = true;
      const navigate = vi.fn();
      sidebar.onNavigate = navigate;
      let detail: unknown;
      const listener = (event: Event) => {
        detail = (event as CustomEvent).detail;
      };
      window.addEventListener(TERMINAL_PANEL_TOGGLE_EVENT, listener);
      try {
        await sidebar.updateComplete;
        // The rendered row owns this catalog even if the global selection changes
        // before its already-rendered click handler runs.
        (sidebar as unknown as { newSessionAgentId: string }).newSessionAgentId = "jarvis";
        (sidebar.querySelector('[data-session-key*="thread-1"] a') as HTMLElement).click();
      } finally {
        window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, listener);
      }
      expect(detail).toEqual({
        open: true,
        agentId: "main",
        catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "thread-1" },
      });
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the viewer and disables the terminal menu item when ineligible", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList([{ threadId: "thread-1", name: "View me", canOpenTerminal: false }]),
        ["agent:main:main"],
      );
      sidebar.catalogOpenTarget = "terminal";
      sidebar.terminalAvailable = true;
      const navigate = vi.fn();
      sidebar.onNavigate = navigate;
      await sidebar.updateComplete;
      const row = sidebar.querySelector('[data-session-key*="thread-1"]') as HTMLElement;
      (row.querySelector("a") as HTMLElement).click();
      expect(navigate).toHaveBeenCalledWith("chat", {
        pathname: "/chat/main",
        search: "?catalog=codex&host=gateway%3Alocal&thread=thread-1",
      });
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 20,
          clientY: 30,
        }),
      );
      await sidebar.updateComplete;
      const menu = sidebar.querySelector("openclaw-catalog-session-menu") as HTMLElement & {
        updateComplete: Promise<boolean>;
      };
      await menu.updateComplete;
      const items = menu.querySelectorAll<HTMLElement & { disabled: boolean }>("wa-dropdown-item");
      expect(items).toHaveLength(2);
      expect(items[1]?.disabled).toBe(true);
      const menuButton = row.querySelector<HTMLElement>("[data-catalog-session-menu]");
      expect(menuButton).not.toBeNull();

      const keyboardContextMenu = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "F10",
        shiftKey: true,
      });
      row.querySelector("a")?.dispatchEvent(keyboardContextMenu);
      await sidebar.updateComplete;
      expect(sidebar.querySelector("openclaw-catalog-session-menu")).not.toBeNull();
      expect(keyboardContextMenu.defaultPrevented).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the routed catalog session row active without a phantom chat row", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList([{ threadId: "thread-1", name: "Release checklist" }]),
        ["agent:main:main"],
      );
      (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
      sidebar.sessionKey = "catalog:codex:gateway%3Alocal:thread-1";
      await sidebar.updateComplete;

      const active = sidebar.querySelectorAll(".sidebar-recent-session--active");
      expect(active).toHaveLength(1);
      expect(active[0]?.getAttribute("data-session-key")).toBe(
        "catalog:codex:gateway%3Alocal:thread-1",
      );
      expect(active[0]?.getAttribute("role")).toBe("listitem");
      expect(active[0]?.closest('[role="list"]')?.getAttribute("aria-label")).toBe("Local Codex");
      expect(active[0]?.querySelector("a")?.getAttribute("aria-current")).toBe("page");
      expect(active[0]?.querySelector("a")?.hasAttribute("aria-describedby")).toBe(false);
      expect(active[0]?.querySelector(".session-row-trail")).toBeNull();
      // The raw catalog key must not surface as a synthesized chat row.
      // Catalogs nest inside the Coding zone, so classify each row by its
      // closest section rather than any ancestor group.
      const chatRows = [
        ...sidebar.querySelectorAll(".sidebar-recent-sessions__group [data-session-key]"),
      ]
        .filter((row) => !row.closest('[data-session-section^="catalog:"]'))
        .map((row) => row.getAttribute("data-session-key"));
      expect(chatRows).not.toContain("catalog:codex:gateway%3Alocal:thread-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("associates catalog running state with the session link description", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList([{ threadId: "thread-running", name: "Running catalog", status: "running" }]),
        ["agent:main:main"],
      );
      const row = sidebar.querySelector('[data-session-key*="thread-running"]');
      const link = row?.querySelector("a");
      const state = row?.querySelector(".session-row-state");

      expect(link?.getAttribute("aria-describedby")).toBe(state?.id);
      expect(link?.getAttribute("title")).toBe("Running catalog · Local Codex · Active run");
      expect(state?.querySelector('.session-run-spinner[aria-label="Active run"]')).not.toBeNull();
      expect(state?.querySelector(".session-run-spinner")?.hasAttribute("title")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders an adopted catalog session as its live row and hides the duplicate", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList([
          {
            threadId: "thread-1",
            name: "Release checklist",
            sessionKey: "agent:main:adopted-codex",
          },
        ]),
        ["agent:main:main", "agent:main:adopted-codex"],
      );

      const rows = [...sidebar.querySelectorAll('[data-session-key="agent:main:adopted-codex"]')];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.closest('[data-session-section="catalog:codex"]')).not.toBeNull();
      // Live-row parity: the adopted row exposes the regular session actions.
      expect(rows[0]?.querySelector("[data-session-menu]")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an adopted session to the thread list when its catalog is hidden", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList([
          {
            threadId: "thread-1",
            name: "Release checklist",
            sessionKey: "agent:main:adopted-codex",
          },
        ]),
        ["agent:main:main", "agent:main:adopted-codex"],
      );
      // Hiding the catalog removes the live row; the adopted key must fall
      // back to a regular thread row, not vanish from the entire sidebar.
      sidebar.hiddenSessionCatalogIds = new Set(["codex"]);
      await sidebar.updateComplete;

      const rows = [...sidebar.querySelectorAll('[data-session-key="agent:main:adopted-codex"]')];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.closest('[data-session-section="catalog:codex"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
