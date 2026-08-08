import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { sessionRefFromPath } from "../../app-session-route-paths.ts";
import {
  clearSessionBoardAvailability,
  recordSessionBoardAvailability,
} from "../../lib/board/provider.ts";
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

type SidebarNativeGatewayTestSnapshot = {
  gateways: Array<{
    id: string;
    name: string;
    isPrimary: boolean;
    health: "ok" | "error" | "unknown";
  }>;
  currentId: string;
};

type SidebarNativeGatewayTestWindow = Window & {
  __OPENCLAW_NATIVE_WEB_CHROME__?: boolean;
  __OPENCLAW_NATIVE_GATEWAYS__?: SidebarNativeGatewayTestSnapshot;
};

function setNativeGatewayTestState(snapshot: SidebarNativeGatewayTestSnapshot): void {
  const nativeWindow = window as SidebarNativeGatewayTestWindow;
  nativeWindow["__OPENCLAW_NATIVE_WEB_CHROME__"] = true;
  nativeWindow["__OPENCLAW_NATIVE_GATEWAYS__"] = snapshot;
}

afterEach(() => {
  const nativeWindow = window as SidebarNativeGatewayTestWindow;
  Reflect.deleteProperty(nativeWindow, "__OPENCLAW_NATIVE_WEB_CHROME__");
  Reflect.deleteProperty(nativeWindow, "__OPENCLAW_NATIVE_GATEWAYS__");
});

describe("AppSidebar update card wiring", () => {
  it("keeps OpenClaw out of the workspace sidebar", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));

    expect(sidebar.querySelector('.nav-item[href="/custodian"]')).toBeNull();
  });

  it("renders the update card in the footer after the attention slot and forwards its action", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const onUpdate = vi.fn();
    sidebar.updateAvailable = {
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      channel: "stable",
    };
    sidebar.onUpdate = onUpdate;
    await sidebar.updateComplete;

    const footer = sidebar.querySelector(".sidebar-shell__footer");
    // Attention chips (when present) stack above the update card.
    expect(footer?.firstElementChild?.localName).toBe("openclaw-sidebar-attention");
    const card = footer?.querySelector("openclaw-sidebar-update-card");
    expect(card).not.toBeNull();
    card?.querySelector<HTMLButtonElement>(".sidebar-update-card__action")?.click();
    expect(onUpdate).toHaveBeenCalledOnce();
  });
});

describe("AppSidebar viewer presence", () => {
  it("renders the self user's avatar route in the footer identity chip", async () => {
    const client = { instanceId: "self-instance" } as GatewayBrowserClient;
    const gatewayHarness = createGatewayHarness(client);
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
    );
    sidebar.connected = true;

    gatewayHarness.publishEvent("presence", {
      presence: [
        {
          instanceId: "self-instance",
          // Presence publishes the canonical gateway avatar route; the gateway
          // serves an uploaded avatar or its Gravatar fallback behind it, so the
          // chip renders that same-origin route (CSP-safe) rather than a direct
          // gravatar.com URL the Control UI CSP would block.
          user: {
            id: "00-self",
            email: "test@example.com",
            name: "Self User",
            avatarUrl: "/api/users/00-self/avatar?v=7",
          },
        },
      ],
    });

    await vi.waitFor(() => {
      const avatar = sidebar.querySelector<HTMLImageElement>(
        ".sidebar-identity-card openclaw-viewer-avatar img",
      );
      expect(avatar?.getAttribute("src")).toBe("/api/users/00-self/avatar?v=7");
    });
  });

  it("groups identified viewers for session rows and keeps the footer identity-only", async () => {
    const client = { instanceId: "self-instance" } as GatewayBrowserClient;
    const gatewayHarness = createGatewayHarness(client);
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main", "agent:main:work"]),
    );
    sidebar.connected = true;
    gatewayHarness.publishEvent("presence", {
      presence: [
        {
          instanceId: "self-instance",
          user: {
            id: "00-self",
            name: "Self User",
            avatarUrl: "/api/users/00-self/avatar?v=1",
          },
          watchedSessions: ["agent:main:work"],
        },
        {
          instanceId: "alice-1",
          // Presence publishes avatars as the canonical gateway route; the
          // resolver renders only that, falling back to initials otherwise.
          user: { id: "alice", name: "Alice", avatarUrl: "/api/users/alice/avatar" },
          watchedSessions: ["agent:main:work"],
        },
        {
          instanceId: "alice-2",
          user: { id: "alice", name: "Alice" },
          watchedSessions: ["agent:main:main"],
        },
        {
          instanceId: "bob-1",
          user: { id: "bob", email: "bob@example.test" },
          watchedSessions: ["agent:main:work"],
        },
        ...["carol", "dave", "erin", "frank"].map((id) => ({
          instanceId: `${id}-1`,
          user: { id, name: id[0]?.toUpperCase() + id.slice(1) },
          watchedSessions: ["agent:main:work"],
        })),
        {
          instanceId: "anonymous-1",
          watchedSessions: ["agent:main:work"],
        },
        {
          instanceId: "offline-1",
          reason: "disconnect",
          user: { id: "offline", name: "Offline User" },
          watchedSessions: ["agent:main:work"],
        },
      ],
    });
    await sidebar.updateComplete;
    gatewayHarness.publish({
      selfUser: {
        id: "00-self",
        name: "Self User",
        avatarUrl: "/api/users/00-self/avatar?v=1",
      },
    });
    await sidebar.updateComplete;

    const sessionFacepile = sidebar.querySelector<HTMLElement>(
      '[data-session-key="agent:main:work"] openclaw-viewer-facepile',
    );
    await (sessionFacepile as { updateComplete?: Promise<unknown> } | null)?.updateComplete;
    expect(
      sessionFacepile?.querySelector(".viewer-facepile")?.getAttribute("data-viewer-count"),
    ).toBe("6");
    expect(
      [...(sessionFacepile?.querySelectorAll<HTMLElement>("[data-viewer-id]") ?? [])].map(
        (avatar) => avatar.dataset.viewerId,
      ),
    ).toEqual(["alice", "bob", "carol"]);
    expect(sessionFacepile?.querySelector(".viewer-avatar--overflow")?.textContent).toContain("+3");
    expect(sessionFacepile?.querySelector('[data-viewer-id="alice"] img')).not.toBeNull();
    expect(
      [...(sessionFacepile?.querySelectorAll("openclaw-tooltip") ?? [])].map(
        (tooltip) => (tooltip as HTMLElement & { content?: string }).content,
      ),
    ).toEqual(["Alice", "bob@example.test", "Carol", "Dave\nErin\nFrank"]);

    const identityCard = sidebar.querySelector<HTMLButtonElement>(".sidebar-identity-card");
    expect(identityCard?.querySelector(".sidebar-identity-card__name")?.textContent).toBe(
      "Self User",
    );
    expect(identityCard?.querySelector('[data-viewer-id="00-self"]')).not.toBeNull();

    const avatar = identityCard?.querySelector<HTMLImageElement>("openclaw-viewer-avatar img");
    expect(avatar?.getAttribute("src")).toBe("/api/users/00-self/avatar?v=1");
    const footer = sidebar.querySelector(".sidebar-footer-bar");
    expect(footer?.querySelector("openclaw-viewer-facepile")).toBeNull();
    expect(footer?.querySelector("openclaw-sidebar-build-chip")).toBeNull();
    expect(footer?.querySelector(".sidebar-brand__logo-slot")).toBeNull();
    expect([...(footer?.children ?? [])].map((element) => element.localName)).toEqual([
      "openclaw-tooltip",
      "span",
    ]);
    gatewayHarness.gateway.updateSelfUser?.({
      name: "Augusta Ada",
      avatarUrl: "/api/users/00-self/avatar?v=4",
    });
    await sidebar.updateComplete;

    // Profile mutations update gateway state directly; no presence event follows them.
    expect(identityCard?.querySelector(".sidebar-identity-card__name")?.textContent).toBe(
      "Augusta Ada",
    );
    expect(avatar?.getAttribute("src")).toBe("/api/users/00-self/avatar?v=4");

    sidebar.connected = false;
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-identity-card__name")?.textContent).toBe("Augusta Ada");
  });

  it("renders an Account fallback for an unidentified connection", async () => {
    const client = { instanceId: "anonymous-self" } as GatewayBrowserClient;
    const gatewayHarness = createGatewayHarness(client);
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
    );

    gatewayHarness.publishEvent("presence", {
      presence: [
        { instanceId: "anonymous-self", watchedSessions: ["agent:main:main"] },
        { instanceId: "alice", user: { id: "alice", name: "Alice" } },
      ],
    });
    await sidebar.updateComplete;

    const identityCard = sidebar.querySelector(".sidebar-identity-card");
    expect(identityCard?.querySelector(".sidebar-identity-card__name")?.textContent).toBe(
      "Account",
    );
    expect(identityCard?.querySelector('[data-viewer-id="account"]')?.textContent).toContain("A");
  });
});

describe("AppSidebar gateway footer subtitle", () => {
  const twoGateways = {
    gateways: [
      { id: "local", name: "Local Gateway", isPrimary: true, health: "ok" },
      { id: "remote", name: "Remote Gateway", isPrimary: false, health: "unknown" },
    ],
    currentId: "local",
  } satisfies SidebarNativeGatewayTestSnapshot;

  it("stays hidden outside native chrome", async () => {
    const nativeWindow = window as SidebarNativeGatewayTestWindow;
    nativeWindow["__OPENCLAW_NATIVE_GATEWAYS__"] = twoGateways;
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));

    expect(sidebar.querySelector(".sidebar-identity-card__subtitle")).toBeNull();
  });

  it("stays hidden with one configured gateway", async () => {
    setNativeGatewayTestState({ gateways: [twoGateways.gateways[0]!], currentId: "local" });
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));

    expect(sidebar.querySelector(".sidebar-identity-card__subtitle")).toBeNull();
  });

  it("shows the current gateway health, name, and primary suffix", async () => {
    setNativeGatewayTestState(twoGateways);
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));

    expect(
      sidebar.querySelector(".sidebar-identity-card__gateway-health")?.getAttribute("data-health"),
    ).toBe("ok");
    expect(sidebar.querySelector(".sidebar-identity-card__gateway-name")?.textContent).toBe(
      "Local Gateway",
    );
    expect(sidebar.querySelector(".sidebar-identity-card__gateway-primary")?.textContent).toBe(
      "· primary",
    );
    expect(sidebar.querySelector(".sidebar-identity-card")?.getAttribute("aria-label")).toBe(
      "Identity and app menu for Account: Local Gateway, primary",
    );
  });

  it("keeps the reconnecting subtitle while offline", async () => {
    setNativeGatewayTestState(twoGateways);
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    sidebar.offline = true;
    await sidebar.updateComplete;

    expect(sidebar.querySelector(".sidebar-identity-card__subtitle")?.textContent).toBe(
      "Reconnecting…",
    );
    expect(sidebar.querySelector(".sidebar-identity-card__gateway-name")).toBeNull();
  });

  it("updates when the native gateway snapshot changes", async () => {
    setNativeGatewayTestState(twoGateways);
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    setNativeGatewayTestState({
      gateways: [
        { id: "local", name: "Local Gateway", isPrimary: true, health: "ok" },
        { id: "remote", name: "Remote Gateway", isPrimary: false, health: "error" },
      ],
      currentId: "remote",
    });
    window.dispatchEvent(new CustomEvent("openclaw:native-gateways-changed"));
    await sidebar.updateComplete;

    expect(sidebar.querySelector(".sidebar-identity-card__gateway-name")?.textContent).toBe(
      "Remote Gateway",
    );
    expect(
      sidebar.querySelector(".sidebar-identity-card__gateway-health")?.getAttribute("data-health"),
    ).toBe("error");
    expect(sidebar.querySelector(".sidebar-identity-card__gateway-primary")).toBeNull();
  });
});

describe("AppSidebar brand actions", () => {
  it("starts a thread for the expanded agent from the brand action", async () => {
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
    sidebar.connected = false;
    sidebar.onOpenNewSession = onOpenNewSession;
    await sidebar.updateComplete;

    const actions = sidebar.querySelector(".sidebar-brand__actions");
    const brandButton = sidebar.querySelector<HTMLButtonElement>(".sidebar-brand__new-thread");
    expect(actions?.firstElementChild?.querySelector(".sidebar-brand__new-thread")).toBe(
      brandButton,
    );
    expect(brandButton?.getAttribute("aria-label")).toBe("New thread");
    expect(brandButton?.disabled).toBe(true);
    expect(actions?.querySelectorAll("button")).toHaveLength(1);
    expect(sidebar.querySelector(".sidebar-search")).toBeNull();
    expect(sidebar.querySelector(".sidebar-brand__collapse")).toBeNull();

    sidebar.connected = true;
    await sidebar.updateComplete;
    expect(brandButton?.disabled).toBe(false);
    brandButton?.click();
    expect(onOpenNewSession).toHaveBeenCalledExactlyOnceWith("research");

    const headerButton = sidebar.querySelector<HTMLButtonElement>(
      '[data-session-section="ungrouped"] .sidebar-new-session',
    );
    expect(headerButton?.getAttribute("aria-label")).toBe("New thread");
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
    expect(href).toBe("/chat/research/telegram/12345");
    expect(sessionRefFromPath(href ?? "")).toMatchObject({
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
    expect(card?.querySelector(".sidebar-identity-card__name")?.textContent).toBe("Account");
    expect(card?.querySelector(".sidebar-identity-card__subtitle")?.textContent).toBe(
      "Reconnecting…",
    );
    expect(
      card?.querySelector(".sidebar-identity-card__subtitle")?.getAttribute("aria-hidden"),
    ).toBe("true");
    const connectionStatus = sidebar.querySelector(".sidebar-identity-card__status");
    expect(connectionStatus?.getAttribute("role")).toBe("status");
    expect(connectionStatus?.getAttribute("aria-live")).toBe("polite");
    expect(connectionStatus?.textContent).toBe("Reconnecting…");
    expect(sidebar.querySelector(".sidebar-footer-bar__status")).toBeNull();
    expect(sidebar.querySelector(".sidebar-agent-card__subtitle")?.textContent).not.toContain(
      "Offline",
    );

    card?.click();
    await sidebar.updateComplete;
    const menu = sidebar.querySelector<HTMLElement>(".sidebar-identity-menu");
    const retry = menu?.querySelector('wa-dropdown-item[value="command:retry-connect"]');
    menu?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: retry }, bubbles: true }));
    expect(onRetryConnect).toHaveBeenCalledOnce();

    sidebar.offline = false;
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-identity-card__subtitle")).toBeNull();
    expect(sidebar.querySelector(".sidebar-identity-card__status")?.textContent).toBe("");
  });

  it("shows a working subtitle while the agent has an active run", async () => {
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
        sessions: [{ key: "agent:main:main", kind: "direct", updatedAt: 5, hasActiveRun: true }],
      },
      agentId: "main",
    });
    await sidebar.updateComplete;

    expect(sidebar.querySelector(".sidebar-agent-card__subtitle")?.textContent).toContain(
      "Working",
    );
    // Run state rings the Home icon in the leading slot; the row edge keeps
    // only approval/outbox counts.
    const ring = sidebar.querySelector(
      ".nav-item--home .session-glyph--running .session-glyph__ring",
    );
    expect(ring).not.toBeNull();
    expect(sidebar.querySelector(".nav-item--home .nav-item__state")).toBeNull();
    expect(ring?.hasAttribute("title")).toBe(false);
    expect(
      (ring?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)?.content,
    ).toBe("Active run");
  });

  it("uses the shared tooltip for the Home dashboard glyph", async () => {
    const mainKey = "agent:main:main";
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", [mainKey]));

    try {
      recordSessionBoardAvailability(mainKey, true);
      sidebar.requestUpdate();
      await sidebar.updateComplete;

      const glyph = sidebar.querySelector(".nav-item--home .sidebar-board-glyph");
      expect(glyph?.getAttribute("aria-label")).toBe("Dashboard available");
      expect(glyph?.hasAttribute("title")).toBe(false);
      expect(
        (glyph?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)
          ?.content,
      ).toBe("Dashboard available");
    } finally {
      clearSessionBoardAvailability();
    }
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
    expect(sidebar.querySelector(".sidebar-agent-card__subtitle")?.textContent?.trim()).toBe(
      "Main task",
    );
    expect(sidebar.querySelector(".sidebar-agent-section")).toBeNull();
    expect(sidebar.querySelectorAll(".sidebar-recent-session")).toHaveLength(0);
    expect(sidebar.querySelector(".sidebar-agent-card__menu-unread")).not.toBeNull();

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
