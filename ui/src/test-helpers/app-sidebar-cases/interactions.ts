import { describe, expect, it, vi } from "vitest";
import type {
  SessionCatalog,
  SessionsCatalogListResult,
} from "../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  loadStoredHiddenSessionCatalogIds,
  storeHiddenSessionCatalogIds,
} from "../../components/app-sidebar-session-types.ts";
import { TERMINAL_PANEL_TOGGLE_EVENT } from "../../components/panel-toggle-contract.ts";
import { CATALOG_SESSION_CONTINUED_EVENT } from "../../lib/sessions/catalog-key.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessions,
  createSessionsHarness,
  mountSidebar,
  type SidebarLifecycleState,
  type TestSessionMenu,
} from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";
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
  const KEYS = ["agent:main:main", "agent:main:a", "agent:main:b", "agent:main:c"];

  function rowLink(sidebar: SidebarLifecycleState, key: string): HTMLAnchorElement {
    const link = sidebar.querySelector<HTMLAnchorElement>(
      `[data-session-key="${key}"] .sidebar-recent-session__link`,
    );
    if (!link) {
      throw new Error(`expected row link for ${key}`);
    }
    return link;
  }

  function selectedRowKeys(sidebar: SidebarLifecycleState): string[] {
    return Array.from(sidebar.querySelectorAll(".sidebar-recent-session--selected")).map(
      (row) => row.getAttribute("data-session-key") ?? "",
    );
  }

  function click(target: Element, init: MouseEventInit = {}) {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  }

  function openContextMenu(sidebar: SidebarLifecycleState, key: string) {
    const row = sidebar.querySelector(`[data-session-key="${key}"]`);
    if (!row) {
      throw new Error(`expected row for ${key}`);
    }
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  }

  async function sessionMenu(sidebar: SidebarLifecycleState): Promise<TestSessionMenu> {
    const menu = sidebar.querySelector<TestSessionMenu>("openclaw-session-menu");
    if (!menu) {
      throw new Error("expected session menu");
    }
    await menu.updateComplete;
    return menu;
  }

  async function mountMultiSelect() {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", KEYS);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    sidebar.connected = true;
    await sidebar.updateComplete;
    return { sidebar, harness };
  }

  it("names each session's pin and menu buttons after their owning session", async () => {
    const { sidebar } = await mountMultiSelect();

    for (const key of ["agent:main:a", "agent:main:b"]) {
      const row = sidebar.querySelector<HTMLElement>(`[data-session-key="${key}"]`);
      const label = row?.querySelector(".sidebar-recent-session__name")?.textContent?.trim();
      expect(label).toBeTruthy();
      expect(row?.querySelector("[data-sidebar-session-pin]")?.getAttribute("aria-label")).toBe(
        `Pin thread: ${label}`,
      );
      expect(row?.querySelector("[data-session-menu]")?.getAttribute("aria-label")).toBe(
        `Open thread menu: ${label}`,
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

    await waitForFast(() => expect(harness.patch).toHaveBeenCalledTimes(2));
    // Each row defers its canonical list refresh; the batch pays one refresh at
    // the end instead of a full sessions.list round trip per archived row.
    expect(harness.patch).toHaveBeenNthCalledWith(
      1,
      "agent:main:a",
      { archived: true },
      { agentId: "main", deferListRefresh: true },
    );
    expect(harness.patch).toHaveBeenNthCalledWith(
      2,
      "agent:main:b",
      { archived: true },
      { agentId: "main", deferListRefresh: true },
    );
    await waitForFast(() => expect(harness.refreshReplacement).toHaveBeenCalledTimes(1));
    expect(harness.refreshReplacement).toHaveBeenCalledWith("main");
  });

  it("deletes the selection in one batch after a single confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      const { sidebar, harness } = await mountMultiSelect();

      click(rowLink(sidebar, "agent:main:a"), { metaKey: true });
      click(rowLink(sidebar, "agent:main:b"), { metaKey: true });
      await sidebar.updateComplete;
      openContextMenu(sidebar, "agent:main:b");
      await sidebar.updateComplete;

      const menu = await sessionMenu(sidebar);
      menu.querySelector<HTMLButtonElement>('[data-shortcut="d"]')?.click();

      await waitForFast(() => expect(harness.deleteMany).toHaveBeenCalledOnce());
      expect(confirmSpy).toHaveBeenCalledOnce();
      expect(confirmSpy.mock.calls[0]?.[0]).toContain("2");
      expect(harness.deleteMany).toHaveBeenCalledWith([
        { key: "agent:main:a", agentId: "main", deleteTranscript: true },
        { key: "agent:main:b", agentId: "main", deleteTranscript: true },
      ]);
    } finally {
      confirmSpy.mockRestore();
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

describe("AppSidebar transient menus", () => {
  // Regression: the nav column is a stacking context (z-index 10) painted
  // below the sidebar resizer (z-index 20), so transient menus must render
  // through the top-layer surface host instead of plain fixed divs.
  it("hosts the session sort menu in the top-layer menu surface", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main", "agent:main:task"]),
    );

    const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort");
    if (!trigger) {
      throw new Error("expected sort menu trigger");
    }
    trigger.click();
    await sidebar.updateComplete;

    const menu = sidebar.querySelector(".sidebar-session-sort-menu");
    expect(menu).not.toBeNull();
    expect(menu?.closest("openclaw-menu-surface")).not.toBeNull();
  });

  it("ignores a stale sort-menu hide after opening its replacement", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main", "agent:main:task"]),
    );
    const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort");
    if (!trigger) {
      throw new Error("expected sort menu trigger");
    }

    trigger.click();
    await sidebar.updateComplete;
    const firstMenu = sidebar.querySelector<HTMLElement>(".sidebar-session-sort-menu");
    expect(firstMenu).not.toBeNull();
    firstMenu?.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        detail: { item: { value: "sort:created" } },
      }),
    );
    await sidebar.updateComplete;

    trigger.click();
    await sidebar.updateComplete;
    const replacement = sidebar.querySelector<HTMLElement>(".sidebar-session-sort-menu");
    expect(replacement).not.toBe(firstMenu);

    firstMenu?.dispatchEvent(new CustomEvent("wa-after-hide", { bubbles: true, composed: true }));
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-session-sort-menu")).toBe(replacement);
  });

  it("ignores a stale agent-menu hide after opening its replacement", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main");
    if (!trigger) {
      throw new Error("expected agent menu trigger");
    }

    trigger.click();
    await sidebar.updateComplete;
    const firstMenu = sidebar.querySelector<HTMLElement>(".sidebar-agent-menu");
    const settingsItem = firstMenu?.querySelector<HTMLElement>(
      'wa-dropdown-item[value="command:agent-settings"]',
    );
    expect(firstMenu).not.toBeNull();
    expect(settingsItem).not.toBeNull();
    firstMenu?.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        detail: { item: settingsItem },
      }),
    );
    await sidebar.updateComplete;

    trigger.click();
    await sidebar.updateComplete;
    const replacement = sidebar.querySelector<HTMLElement>(".sidebar-agent-menu");
    expect(replacement).not.toBe(firstMenu);

    firstMenu?.dispatchEvent(new CustomEvent("wa-after-hide", { bubbles: true, composed: true }));
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-agent-menu")).toBe(replacement);
  });

  it("ignores a stale More-menu hide after opening its replacement", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-nav__head-action");
    if (!trigger) {
      throw new Error("expected Pages menu trigger");
    }

    trigger.click();
    await sidebar.updateComplete;
    const firstMenu = sidebar.querySelector<HTMLElement>(".sidebar-more-menu");
    expect(firstMenu).not.toBeNull();
    trigger.click();
    await sidebar.updateComplete;
    trigger.click();
    await sidebar.updateComplete;
    const replacement = sidebar.querySelector<HTMLElement>(".sidebar-more-menu");
    expect(replacement).not.toBe(firstMenu);

    firstMenu?.dispatchEvent(new CustomEvent("wa-after-hide", { bubbles: true, composed: true }));
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-more-menu")).toBe(replacement);
  });

  it("ignores a stale Customize-menu hide after opening its replacement", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const nav = sidebar.querySelector<HTMLElement>(".sidebar-nav");
    if (!nav) {
      throw new Error("expected sidebar navigation");
    }

    nav.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
    );
    await sidebar.updateComplete;
    const firstMenu = sidebar.querySelector<HTMLElement>(".sidebar-customize-menu");
    expect(firstMenu).not.toBeNull();
    firstMenu?.dispatchEvent(
      new CustomEvent("wa-select", {
        bubbles: true,
        detail: { item: { value: "reset" } },
      }),
    );
    await sidebar.updateComplete;

    nav.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 24 }),
    );
    await sidebar.updateComplete;
    const replacement = sidebar.querySelector<HTMLElement>(".sidebar-customize-menu");
    expect(replacement).not.toBe(firstMenu);

    firstMenu?.dispatchEvent(new CustomEvent("wa-after-hide", { bubbles: true, composed: true }));
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-customize-menu")).toBe(replacement);
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

  it("opens the catalog view menu from its header and hides that section", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList([{ threadId: "thread-1", name: "Release checklist" }]),
        ["agent:main:main"],
      );
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

      storeHiddenSessionCatalogIds(new Set());
      await sidebar.updateComplete;
      expect(sidebar.querySelector('[data-session-section="catalog:codex"]')).not.toBeNull();
    } finally {
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
        (sidebar.querySelector('[data-session-key*="thread-1"] a') as HTMLElement).click();
      } finally {
        window.removeEventListener(TERMINAL_PANEL_TOGGLE_EVENT, listener);
      }
      expect(detail).toEqual({
        open: true,
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
      expect(row.querySelector("[data-catalog-session-menu]")).not.toBeNull();
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

  it("binds the adopted session immediately on the catalog-continued event", async () => {
    vi.useFakeTimers();
    try {
      const { sidebar } = await mountWithCatalog(
        catalogList([{ threadId: "thread-1", name: "Release checklist" }]),
        ["agent:main:main", "agent:main:adopted-codex"],
      );
      expect(
        sidebar.querySelectorAll('[data-session-key="agent:main:adopted-codex"]'),
      ).toHaveLength(1);

      document.dispatchEvent(
        new CustomEvent(CATALOG_SESSION_CONTINUED_EVENT, {
          detail: {
            catalogId: "codex",
            hostId: "gateway:local",
            threadId: "thread-1",
            sessionKey: "agent:main:adopted-codex",
          },
        }),
      );
      await sidebar.updateComplete;

      const rows = [...sidebar.querySelectorAll('[data-session-key="agent:main:adopted-codex"]')];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.closest('[data-session-section="catalog:codex"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
