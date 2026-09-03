import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import {
  SIDEBAR_SESSION_NAV_COLLAPSE_QUERY,
  sessionRefFromPath,
} from "../../app-session-route-paths.ts";
import {
  SESSION_FACE_PREFERENCE_PARAM,
  SESSION_NAVIGATION_KEY_PARAM,
} from "../../lib/sessions/route-navigation.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessions,
  createSessionsHarness,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

await import("../../components/viewer-facepile.ts");

describe("AppSidebar update card wiring", () => {
  it("keeps OpenClaw out of the workspace sidebar", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));

    expect(sidebar.querySelector('.nav-item[href="/custodian"]')).toBeNull();
    expect(sidebar.querySelector('.nav-item[href="/settings/secrets"]')).toBeNull();
  });
});

describe("AppSidebar new session navigation", () => {
  it("opens new-session links for the expanded agent without intercepting browser gestures", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }, { id: "research" }],
    } as AgentsListResult;
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("research", ["agent:research:main", "agent:research:task"]),
      "panel",
      agentsList,
    );
    const onOpenNewSession = vi.fn();
    const onOpenPalette = vi.fn();
    const onToggleSidebar = vi.fn();
    sidebar.basePath = "/control";
    sidebar.connected = false;
    sidebar.onOpenNewSession = onOpenNewSession;
    sidebar.onOpenPalette = onOpenPalette;
    sidebar.onToggleSidebar = onToggleSidebar;
    await sidebar.updateComplete;

    const actions = sidebar.querySelector(".sidebar-brand__actions");
    const brandLink = sidebar.querySelector<HTMLAnchorElement>(".sidebar-brand__new-thread");
    expect(
      Array.from(actions?.querySelectorAll("[aria-label]") ?? [], (action) =>
        action.getAttribute("aria-label"),
      ),
    ).toEqual(["Collapse sidebar", "Open command palette", "New session"]);
    sidebar.querySelector<HTMLButtonElement>(".sidebar-brand__collapse")?.click();
    sidebar.querySelector<HTMLButtonElement>(".sidebar-brand__search")?.click();
    expect(onToggleSidebar).toHaveBeenCalledOnce();
    expect(onOpenPalette).toHaveBeenCalledOnce();
    expect(brandLink?.getAttribute("aria-label")).toBe("New session");
    expect(brandLink).toBeInstanceOf(HTMLAnchorElement);
    expect(brandLink?.getAttribute("aria-disabled")).toBe("true");
    expect(brandLink?.hasAttribute("href")).toBe(false);
    expect(brandLink?.tabIndex).toBe(-1);
    brandLink?.click();
    expect(onOpenNewSession).not.toHaveBeenCalled();

    sidebar.connected = true;
    await sidebar.updateComplete;
    for (const selector of [
      ".sidebar-brand__new-thread",
      ".sidebar-session-toolbar .sidebar-new-session",
    ]) {
      const link = sidebar.querySelector<HTMLAnchorElement>(selector)!;
      expect(link.getAttribute("aria-label")).toBe("New session");
      expect(link.getAttribute("href")).toBe("/control/new?agent=research");
      expect(link.hasAttribute("aria-disabled")).toBe(false);
      for (const modifiers of [
        { metaKey: true },
        { ctrlKey: true },
        { shiftKey: true },
        { button: 1 },
      ]) {
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers });
        link.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(onOpenNewSession).not.toHaveBeenCalled();
      }
      link.click();
      expect(onOpenNewSession).toHaveBeenCalledExactlyOnceWith("research");
      onOpenNewSession.mockClear();
    }
  });

  it("opens a catalog-targeted draft from its new-session action", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("research", ["agent:research:main"]),
      "panel",
      {
        defaultId: "main",
        mainKey: "agent:main:main",
        scope: "global",
        agents: [
          { id: "main", name: "Main" },
          { id: "research", name: "Research" },
        ],
      },
    );
    const onOpenNewSession = vi.fn();
    sidebar.connected = true;
    sidebar.onOpenNewSession = onOpenNewSession;
    sidebar.sessionData.sessionCatalogs = [
      {
        id: "claude",
        label: "Claude Code",
        capabilities: {
          continueSession: true,
          archive: false,
          startTerminal: true,
        },
        hosts: [],
      },
    ];
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;

    const link = sidebar.querySelector<HTMLAnchorElement>(".sidebar-session-catalog-new")!;
    expect(link.getAttribute("aria-label")).toBe("New session — Claude Code");
    expect(link.getAttribute("href")).toBe("/new?agent=research&catalog=claude");
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    link.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(false);
    expect(sidebar.querySelector(".sidebar-session-catalog-view-menu")).toBeNull();
    link.click();

    expect(onOpenNewSession).toHaveBeenCalledWith("research", { catalogId: "claude" });
  });
});

describe("AppSidebar agent chip", () => {
  it("qualifies unscoped session rows with the selected agent", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("research", ["agent:research:main", "telegram:12345"]),
      "panel",
      { ...TWO_AGENTS, defaultId: "research" },
    );
    sidebar.sessionKey = "agent:research:main";
    await sidebar.updateComplete;

    const href = sidebar
      .querySelector<HTMLAnchorElement>(
        '[data-session-key="telegram:12345"] .sidebar-recent-session__link',
      )
      ?.getAttribute("href");
    const sessionUrl = new URL(href ?? "", window.location.origin);
    expect(sessionUrl.pathname).toBe("/chat/research/telegram/12345");
    expect(sessionUrl.searchParams.get(SIDEBAR_SESSION_NAV_COLLAPSE_QUERY.name)).toBe(
      SIDEBAR_SESSION_NAV_COLLAPSE_QUERY.value,
    );
    expect(sessionRefFromPath(sessionUrl.pathname)).toMatchObject({
      kind: "literal",
      sessionKey: "agent:research:telegram:12345",
    });
  });

  it("opens an ambiguous one-segment literal session through its escaped path", async () => {
    const sessionKey = "agent:main:release-deadbeef";
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", [sessionKey]));
    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;
    await sidebar.updateComplete;

    sidebar
      .querySelector<HTMLAnchorElement>(
        `[data-session-key="${sessionKey}"] .sidebar-recent-session__link`,
      )
      ?.click();

    expect(onNavigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/main/~key/release-deadbeef",
    });
  });

  it("resumes the newest session when the menu switches to an agent with cached rows", async () => {
    const taskKey = "agent:main:dashboard:00000002-0000-4000-8000-000000000000";
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const setSessionKey = vi.fn();
    (gatewayHarness.gateway as { setSessionKey: (key: string) => void }).setSessionKey =
      setSessionKey;
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main", taskKey]),
      "panel",
      TWO_AGENTS,
    );
    const onNavigate = vi.fn();
    sidebar.connected = true;
    sidebar.onNavigate = onNavigate;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    const rows = [
      ...sidebar.querySelectorAll<HTMLElement>(
        ".sidebar-agent-menu wa-dropdown-item.sidebar-agent-menu__agent-switch",
      ),
    ];
    rows.find((row) => row.textContent?.includes("Molty"))?.click();
    // createSessionState stamps ascending updatedAt, so the last key is newest.
    expect(setSessionKey).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/main/00000002",
      search: `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(taskKey)}`,
    });
  });

  it("keeps agent ids distinct from utility command values", async () => {
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const setSessionKey = vi.fn();
    (gatewayHarness.gateway as { setSessionKey: (key: string) => void }).setSessionKey =
      setSessionKey;
    const agents = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }, { id: "settings" }],
    } as AgentsListResult;
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      agents,
    );
    const onNavigate = vi.fn();
    sidebar.connected = true;
    sidebar.onNavigate = onNavigate;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    const menu = sidebar.querySelector<HTMLElement>(".sidebar-agent-menu");
    const settingsAgent = [
      ...(menu?.querySelectorAll<HTMLElement>('wa-dropdown-item[type="checkbox"]') ?? []),
    ].find((row) => row.textContent?.includes("settings"));
    menu?.dispatchEvent(
      new CustomEvent("wa-select", { detail: { item: settingsAgent }, bubbles: true }),
    );
    await sidebar.updateComplete;

    // Uncached agent main session: the face is a guess, so the navigation carries the
    // marker that lets the chat loader re-derive it from the gateway.
    expect(setSessionKey).toHaveBeenCalledWith("agent:settings:main");
    expect(onNavigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/settings",
      search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
    });
    expect(onNavigate).not.toHaveBeenCalledWith("appearance");
  });

  it("keeps the identity card available offline with reconnect and retry actions", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const onRetryConnect = vi.fn();
    sidebar.onRetryConnect = onRetryConnect;
    sidebar.connected = true;
    await sidebar.updateComplete;

    expect(sidebar.querySelector(".sidebar-identity-card__subtitle")).toBeNull();
    expect(
      sidebar.querySelector(".sidebar-agent-card__main")?.getAttribute("aria-label"),
    ).not.toContain("Online");

    sidebar.connected = false;
    sidebar.offline = true;
    await sidebar.updateComplete;
    const card = sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card");
    expect(card?.querySelector(".sidebar-identity-card__name")?.textContent?.trim()).toBe(
      "Account",
    );
    expect(card?.querySelector(".sidebar-identity-card__subtitle")).toBeNull();
    const connectionStatus = sidebar.querySelector(".sidebar-footer-bar__status");
    expect(connectionStatus?.getAttribute("aria-live")).toBe("polite");
    expect(connectionStatus?.textContent).toContain("Offline");
    expect(connectionStatus?.textContent).toContain("Reconnecting…");
    expect(sidebar.querySelector(".sidebar-agent-card__subtitle-row")).toBeNull();

    card?.click();
    await sidebar.updateComplete;
    const menu = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu");
    const retry = menu?.querySelector('wa-dropdown-item[value="command:retry-connect"]');
    menu?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: retry }, bubbles: true }));
    expect(onRetryConnect).toHaveBeenCalledOnce();

    sidebar.offline = false;
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-identity-card__subtitle")).toBeNull();
    expect(sidebar.querySelector(".sidebar-footer-bar__status")).toBeNull();
  });

  it("shows the Home spinner without an agent subtitle during an active run", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:main"]);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    sidebar.connected = true;
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "agent:main:main",
            kind: "direct",
            updatedAt: 5,
            hasActiveRun: true,
            unread: true,
          },
        ],
      },
      agentId: "main",
    });
    await sidebar.updateComplete;

    expect(sidebar.querySelector(".sidebar-agent-card__subtitle-row")).toBeNull();
    // Run state uses the session spinner at the row edge without changing the Home icon.
    const spinner = sidebar.querySelector(".nav-item--home .nav-item__state .session-run-spinner");
    expect(spinner).not.toBeNull();
    expect(sidebar.querySelector(".nav-item--home .nav-item__icon")).not.toBeNull();
    expect(sidebar.querySelector(".nav-item--home .session-glyph__ring")).toBeNull();
    expect(sidebar.querySelector(".nav-item--home .session-glyph__badge--unread")).toBeNull();
    expect(spinner?.getAttribute("role")).toBe("img");
    expect(spinner?.getAttribute("aria-label")).toBe("Active run");
    expect(spinner?.getAttribute("title")).toBe("Active run");

    harness.publishList({
      result: {
        ts: 3,
        path: "",
        count: 1,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [{ key: "agent:main:main", kind: "direct", updatedAt: 6, unread: true }],
      },
      agentId: "main",
    });
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".nav-item--home .session-run-spinner")).toBeNull();
    expect(sidebar.querySelector(".nav-item--home .session-glyph__badge--unread")).not.toBeNull();
  });

  it("keeps the sessions list flat for the selected agent and flags other-agent unread", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["agent:main:main"]);
    const { sidebar, context } = await mountSidebar(gateway, harness.sessions, "panel", TWO_AGENTS);
    sidebar.connected = true;
    const defaults = { modelProvider: null, model: null, contextTokens: null };
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 1,
        defaults,
        sessions: [
          {
            key: "agent:research:one",
            kind: "direct",
            label: "Research task",
            updatedAt: 3,
            unread: true,
          },
        ],
      },
      agentId: "research",
    });
    harness.publishList({
      result: {
        ts: 3,
        path: "",
        count: 1,
        defaults,
        sessions: [{ key: "agent:main:main", kind: "direct", label: "Main task", updatedAt: 5 }],
      },
      agentId: "main",
    });
    await sidebar.updateComplete;

    // No per-agent sections: the card switcher owns agent switching now, and
    // the main session lives behind the identity card instead of the list.
    expect(sidebar.querySelector(".sidebar-agent-card__subtitle-row")).toBeNull();
    expect(sidebar.querySelector(".sidebar-agent-section")).toBeNull();
    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(0);
    expect(
      sidebar.querySelector(".sidebar-agent-card__avatar .sidebar-agent-card__menu-unread"),
    ).not.toBeNull();

    // Mid-switch (selected agent != loaded result agent) the list renders the
    // target agent's cached rows instead of flashing empty until refresh.
    // Chip switch and chat-pane both sync agentSelection with the route.
    context.agentSelection.state.selectedId = "research";
    sidebar.sessionKey = "agent:research:one";
    await sidebar.updateComplete;
    const rows = [...sidebar.querySelectorAll(".sidebar-recent-session")];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Research task");
  });

  it("routes Home to the main session and marks it active there", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const setSessionKey = vi.fn();
    (gateway as { setSessionKey: (key: string) => void }).setSessionKey = setSessionKey;
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const navigate = vi.fn();
    sidebar.onNavigate = navigate;
    sidebar.connected = true;
    (sidebar as unknown as { activeRouteId: string }).activeRouteId = "chat";
    sidebar.sessionKey = "agent:main:main";
    await sidebar.updateComplete;

    const home = sidebar.querySelector<HTMLAnchorElement>(".nav-item--home");
    expect(home?.textContent).toContain("Home");
    expect(home?.getAttribute("aria-current")).toBe("page");

    home?.click();
    expect(setSessionKey).toHaveBeenCalledWith("agent:main:main");
    expect(navigate).toHaveBeenCalledWith("chat", { pathname: "/chat/main" });
  });

  it("treats the global key as the main session under global scope", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const harness = createSessionsHarness("main", ["global"]);
    const globalAgents = {
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [{ id: "main", identity: { name: "Molty" } }],
    } as AgentsListResult;
    const { sidebar } = await mountSidebar(gateway, harness.sessions, "panel", globalAgents);
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 2,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          { key: "global", kind: "global", updatedAt: 5, unread: true },
          { key: "agent:main:side-quest", kind: "direct", label: "Side quest", updatedAt: 4 },
        ],
      },
    });
    await sidebar.updateComplete;

    // The advertised global main hides behind the Home row instead of
    // leaking into Threads; ordinary sessions still list, and Home surfaces
    // the global row's unread state.
    expect(sidebar.querySelector('[data-session-key="global"]')).toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:side-quest"]')).not.toBeNull();
    expect(sidebar.querySelector(".nav-item--home .session-glyph__badge--unread")).not.toBeNull();
  });

  it("promotes main-session children to top-level threads, including alias parent keys", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    // The gateway row uses the unprefixed "main" alias; children index under
    // that literal key, so promotion must follow the row's key, not only the
    // synthesized agent:main:main form.
    const harness = createSessionsHarness("main", ["main"]);
    const { sidebar } = await mountSidebar(gateway, harness.sessions);
    harness.publishList({
      result: {
        ts: 2,
        path: "",
        count: 2,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [
          {
            key: "main",
            kind: "direct",
            updatedAt: 5,
            childSessions: ["agent:main:subagent:thread-a"],
          },
          {
            key: "agent:main:subagent:thread-a",
            spawnedBy: "main",
            kind: "direct",
            label: "Spawned thread",
            updatedAt: 4,
          },
        ],
      },
    });
    await sidebar.updateComplete;

    // The main row hides behind the identity card; its child surfaces as a
    // top-level (non-child) thread row.
    expect(sidebar.querySelector('[data-session-key="main"]')).toBeNull();
    const promoted = sidebar.querySelector('[data-session-key="agent:main:subagent:thread-a"]');
    expect(promoted).not.toBeNull();
    expect(promoted?.classList.contains("sidebar-recent-session--child")).toBe(false);
    expect(promoted?.textContent).toContain("Spawned thread");
  });
});
