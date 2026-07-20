import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
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
        ".sidebar-footer-bar__identity openclaw-viewer-avatar img",
      );
      expect(avatar?.getAttribute("src")).toBe("/api/users/00-self/avatar?v=7");
    });
  });

  it("groups identified viewers for session rows and the footer", async () => {
    const client = { instanceId: "self-instance" } as GatewayBrowserClient;
    const gatewayHarness = createGatewayHarness(client);
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main", "agent:main:work"]),
    );
    sidebar.connected = true;
    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;

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
    const footerFacepile = sidebar.querySelector<HTMLElement>(
      ".sidebar-footer-bar openclaw-viewer-facepile",
    );
    await Promise.all([
      (sessionFacepile as { updateComplete?: Promise<unknown> } | null)?.updateComplete,
      (footerFacepile as { updateComplete?: Promise<unknown> } | null)?.updateComplete,
    ]);
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

    expect(
      footerFacepile?.querySelector(".viewer-facepile")?.getAttribute("data-viewer-count"),
    ).toBe("6");
    expect(footerFacepile?.querySelector('[data-viewer-id="00-self"]')).toBeNull();
    expect(footerFacepile?.querySelector(".viewer-avatar--overflow")?.textContent).toContain("+1");

    const identityChip = sidebar.querySelector<HTMLButtonElement>(".sidebar-footer-bar__identity");
    expect(identityChip?.querySelector(".sidebar-footer-bar__identity-name")?.textContent).toBe(
      "Self User",
    );
    expect(identityChip?.querySelector('[data-viewer-id="00-self"]')).not.toBeNull();
    identityChip?.click();
    expect(onNavigate).toHaveBeenCalledWith("profile", {
      hash: "#settings-profile-identity",
    });

    const avatar = identityChip?.querySelector<HTMLImageElement>("openclaw-viewer-avatar img");
    expect(avatar?.getAttribute("src")).toBe("/api/users/00-self/avatar?v=1");
    gatewayHarness.gateway.updateSelfUser?.({
      name: "Augusta Ada",
      avatarUrl: "/api/users/00-self/avatar?v=4",
    });
    await sidebar.updateComplete;

    // Profile mutations update gateway state directly; no presence event follows them.
    expect(identityChip?.querySelector(".sidebar-footer-bar__identity-name")?.textContent).toBe(
      "Augusta Ada",
    );
    expect(avatar?.getAttribute("src")).toBe("/api/users/00-self/avatar?v=4");

    sidebar.connected = false;
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-footer-bar__identity")).toBeNull();
  });

  it("leaves the footer identity chip absent for an unidentified connection", async () => {
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

    expect(sidebar.querySelector(".sidebar-footer-bar__identity")).toBeNull();
    expect(sidebar.querySelector(".sidebar-footer-bar")?.textContent).not.toContain("Sign in");
  });
});

describe("AppSidebar brand actions", () => {
  it("starts a thread for the expanded agent from the brand action", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
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

  it("opens the archived Sessions view from the sessions-zone footer", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main", "agent:main:work"]),
    );
    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-view-archived")?.click();

    expect(onNavigate).toHaveBeenCalledWith("sessions", { search: "?showArchived=1" });
  });
});

describe("AppSidebar agent chip", () => {
  it("resumes the newest session when the menu switches to an agent with cached rows", async () => {
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const setSessionKey = vi.fn();
    (gatewayHarness.gateway as { setSessionKey: (key: string) => void }).setSessionKey =
      setSessionKey;
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main", "agent:main:task"]),
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
    expect(setSessionKey).toHaveBeenCalledWith("agent:main:task");
    expect(onNavigate).toHaveBeenCalledWith("chat", { search: "?session=agent%3Amain%3Atask" });
  });

  it("keeps agent ids distinct from utility command values", async () => {
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const setSessionKey = vi.fn();
    (gatewayHarness.gateway as { setSessionKey: (key: string) => void }).setSessionKey =
      setSessionKey;
    const agents = {
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
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

    expect(setSessionKey).toHaveBeenCalledWith("agent:settings:main");
    expect(onNavigate).toHaveBeenCalledWith("chat", {
      search: "?session=agent%3Asettings%3Amain",
    });
    expect(onNavigate).not.toHaveBeenCalledWith("config");
  });

  it("shows connection exceptions only after a sustained disconnect", async () => {
    vi.useFakeTimers();
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const presence = () => sidebar.querySelector(".sidebar-agent-card__presence");
    const offlinePill = () => sidebar.querySelector(".sidebar-footer-bar__status");
    const expectQuiet = () => {
      expect(presence()).toBeNull();
      expect(offlinePill()).toBeNull();
    };
    sidebar.connected = true;
    await sidebar.updateComplete;

    expectQuiet();
    expect(
      sidebar.querySelector(".sidebar-agent-card__main")?.getAttribute("aria-label"),
    ).toContain("Online");

    sidebar.connected = false;
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-agent-card__subtitle")?.textContent?.trim()).toBe(
      "Offline",
    );
    await vi.advanceTimersByTimeAsync(1_999);
    expectQuiet();

    await vi.advanceTimersByTimeAsync(1);
    await sidebar.updateComplete;
    const pill = offlinePill();
    expect(pill?.textContent?.trim()).toBe("Offline");
    expect(pill?.getAttribute("aria-live")).toBe("polite");
    expect(pill?.getAttribute("title")).toContain("Offline");
    expect(pill?.querySelector(".sidebar-footer-bar__status-dot")).not.toBeNull();
    expect(presence()).not.toBeNull();

    sidebar.connected = true;
    await sidebar.updateComplete;
    expectQuiet();

    sidebar.connected = false;
    await sidebar.updateComplete;
    await vi.advanceTimersByTimeAsync(1_000);
    sidebar.connected = true;
    await sidebar.updateComplete;
    await vi.advanceTimersByTimeAsync(2_000);
    expectQuiet();
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
    expect(navigate).toHaveBeenCalledWith("chat", { search: "?session=agent%3Amain%3Amain" });
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
    expect(sidebar.querySelector(".nav-item--home .session-unread-dot")).not.toBeNull();
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
