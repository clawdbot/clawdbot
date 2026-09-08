import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import {
  SESSION_COMPOSER_FOCUS_PARAM,
  SESSION_FACE_PREFERENCE_PARAM,
} from "../../lib/sessions/route-navigation.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessions,
  manyAgents,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

function pointerEvent(type: "pointerenter" | "pointerleave", pointerType = "mouse") {
  const event = new Event(type);
  Object.defineProperty(event, "pointerType", { value: pointerType });
  return event;
}

describe("AppSidebar agent chip", () => {
  it("loads the workspace identity used by the Agents editor", async () => {
    const request = vi.fn().mockResolvedValue({
      agentId: "main",
      name: "Workspace Molty",
      emoji: "🦞",
      avatar: "data:image/png;base64,d29ya3NwYWNl",
    });
    const gatewayHarness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    const agentIdentity = createAgentIdentityCapability(gatewayHarness.gateway);
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      },
      [],
      agentIdentity,
    );

    sidebar.connected = true;
    await vi.waitFor(() => {
      expect(sidebar.querySelector(".sidebar-agent-card__name")?.textContent?.trim()).toContain(
        "Workspace Molty",
      );
      expect(sidebar.querySelector<HTMLImageElement>(".sidebar-agent-card__avatar img")?.src).toBe(
        "data:image/png;base64,d29ya3NwYWNl",
      );
    });
    expect(request).toHaveBeenCalledWith("agent.identity.get", { agentId: "main" });
  });

  it("keeps the hydrated identity while the active roster row is unavailable", async () => {
    const request = vi.fn().mockResolvedValue({
      agentId: "main",
      name: "Workspace Molty",
      emoji: "🦞",
    });
    const gatewayHarness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    const agentIdentity = createAgentIdentityCapability(gatewayHarness.gateway);
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      null,
      [],
      agentIdentity,
    );

    sidebar.connected = true;
    await vi.waitFor(() => {
      expect(sidebar.querySelector(".sidebar-agent-card__name")?.textContent?.trim()).toBe(
        "Workspace Molty",
      );
    });
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await vi.waitFor(() => {
      expect(
        sidebar
          .querySelector<HTMLElement>(
            'wa-dropdown-item[value="command:capabilities"] .sidebar-customize-menu__text',
          )
          ?.textContent?.trim(),
      ).toBe("What can Workspace Molty do?");
    });
  });

  it("keeps the configured roster label when identity hydration returns a fallback", async () => {
    const request = vi.fn(async (_method: string, params: { agentId: string }) =>
      params.agentId === "main"
        ? { agentId: "main", name: "Workspace Molty", avatar: "🦞" }
        : { agentId: "rust-claw", name: "Assistant", avatar: "🦀" },
    );
    const gatewayHarness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    const agentIdentity = createAgentIdentityCapability(gatewayHarness.gateway);
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }, { id: "rust-claw", name: "rust-claw" }],
      },
      [],
      agentIdentity,
    );

    sidebar.connected = true;
    await vi.waitFor(() => {
      expect(sidebar.querySelector(".sidebar-agent-card__name")?.textContent?.trim()).toBe(
        "Workspace Molty",
      );
    });
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("agent.identity.get", { agentId: "rust-claw" });
      const labels = [
        ...sidebar.querySelectorAll(".sidebar-agent-menu .agent-select__option-label"),
      ].map((element) => element.textContent?.trim());
      expect(labels).toEqual(["Workspace Molty", "rust-claw"]);
    });
    await vi.waitFor(() => {
      const rustRow = [
        ...sidebar.querySelectorAll<HTMLElement>(".sidebar-agent-menu__agent-switch"),
      ].find((row) => row.textContent?.includes("rust-claw"));
      expect(
        rustRow?.querySelector(".agent-select__avatar--text")?.getAttribute("data-avatar"),
      ).toBe("🦀");
    });
  });

  it("hydrates agents added while the switcher remains open", async () => {
    const request = vi.fn(async (_method: string, params: { agentId: string }) => ({
      agentId: params.agentId,
      name: `Workspace ${params.agentId}`,
    }));
    const gatewayHarness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    const agentIdentity = createAgentIdentityCapability(gatewayHarness.gateway);
    const { sidebar, context } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      },
      [],
      agentIdentity,
    );
    sidebar.connected = true;
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("agent.identity.get", { agentId: "main" }),
    );
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-agent-menu")).not.toBeNull();

    (context.agents.state as { agentsList: AgentsListResult | null }).agentsList = TWO_AGENTS;
    sidebar.requestUpdate();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("agent.identity.get", { agentId: "research" });
      expect(sidebar.querySelector(".sidebar-agent-menu")?.textContent).toContain(
        "Workspace research",
      );
    });
  });

  it("opens the agent-scoped menu with its inline roster", async () => {
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const setSessionKey = vi.fn();
    (gatewayHarness.gateway as { setSessionKey: (key: string) => void }).setSessionKey =
      setSessionKey;
    const { sidebar, context } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      {
        ...TWO_AGENTS,
        agents: [
          { id: "main", identity: { name: "Molty", emoji: "🦞" } },
          {
            id: "research",
            identity: { avatarUrl: "data:image/png;base64,eA==" },
          },
        ],
      },
    );
    const onNavigate = vi.fn();
    sidebar.connected = true;
    sidebar.canPairDevice = true;
    sidebar.onNavigate = onNavigate;
    await sidebar.updateComplete;

    expect(sidebar.querySelector(".sidebar-agent-card__name")?.textContent?.trim()).toBe("Molty");
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;

    const menu = sidebar.querySelector(".sidebar-agent-menu");
    expect(menu).not.toBeNull();
    expect(menu?.querySelector(".sidebar-pair-mobile")).toBeNull();
    expect(menu?.querySelector("openclaw-sidebar-build-chip")).toBeNull();
    expect(menu?.querySelector("openclaw-theme-mode-toggle")).toBeNull();
    expect(
      [...(menu?.querySelectorAll("wa-dropdown-item") ?? [])].map((element) =>
        element.getAttribute("value"),
      ),
    ).toEqual([
      "agent:main",
      "agent:research",
      "command:new-agent",
      "command:capabilities",
      "command:agent-settings",
    ]);

    const agentRows = [...(menu?.querySelectorAll('wa-dropdown-item[type="checkbox"]') ?? [])];
    expect(agentRows).toHaveLength(2);
    expect(agentRows[0]?.classList.contains("sidebar-agent-menu__agent-switch--active")).toBe(true);
    expect(agentRows[0]?.querySelector(".sidebar-agent-menu__agent-tile")).not.toBeNull();
    expect(menu?.querySelector(".agent-select__avatar--text")?.getAttribute("data-avatar")).toBe(
      "🦞",
    );
    expect(menu?.querySelector<HTMLImageElement>("img.agent-select__avatar")?.src).toContain(
      "data:image/png;base64,eA==",
    );
    const switchMenu = menu;
    const researchRow = [
      ...(switchMenu?.querySelectorAll<HTMLElement>('wa-dropdown-item[type="checkbox"]') ?? []),
    ].find((row) => row.textContent?.includes("research"));
    expect(researchRow).toBeDefined();
    switchMenu?.dispatchEvent(
      new CustomEvent("wa-select", { detail: { item: researchRow }, bubbles: true }),
    );
    await sidebar.updateComplete;

    expect(context.agentSelection.state).toEqual({ selectedId: "research", scopeId: "research" });
    expect(sidebar.querySelector(".sidebar-agent-card__name")?.textContent?.trim()).toBe(
      "research",
    );
    // No cached sessions for the other agent: resume falls back to its main key, and
    // the uncached face is a guess, so navigation is marked for gateway re-derivation.
    expect(setSessionKey).toHaveBeenCalledWith("agent:research:main");
    expect(onNavigate).toHaveBeenCalledWith("chat", {
      pathname: "/chat/research",
      search: `?${SESSION_FACE_PREFERENCE_PARAM}=1`,
    });
    expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
  });

  it("opens after fine-pointer hover intent without stealing focus", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    try {
      const { sidebar } = await mountSidebar(
        createGateway({} as GatewayBrowserClient),
        createSessions("main", ["agent:main:main"]),
        "panel",
        TWO_AGENTS,
      );
      const menus = (
        sidebar as unknown as {
          sidebarMenus: { preloadMenuRenderer: () => Promise<unknown> };
        }
      ).sidebarMenus;
      await menus.preloadMenuRenderer();
      const input = document.createElement("input");
      document.body.append(input);
      input.focus();
      const trigger = sidebar.querySelector<HTMLElement>(".sidebar-agent-card__main");
      if (!trigger) {
        throw new Error("Expected the sidebar agent card trigger");
      }

      trigger.dispatchEvent(pointerEvent("pointerenter"));
      await vi.advanceTimersByTimeAsync(299);
      await sidebar.updateComplete;
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
      trigger.dispatchEvent(pointerEvent("pointerleave"));
      await vi.advanceTimersByTimeAsync(1);
      await sidebar.updateComplete;
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();

      trigger.dispatchEvent(pointerEvent("pointerenter"));
      await vi.advanceTimersByTimeAsync(300);
      await sidebar.updateComplete;
      const menu = sidebar.querySelector<HTMLElement>(".sidebar-agent-menu");
      if (!menu) {
        throw new Error("Expected the agent menu after hover intent");
      }
      menu.dispatchEvent(new Event("wa-after-show"));
      expect(document.activeElement).toBe(input);

      trigger.dispatchEvent(pointerEvent("pointerleave"));
      await vi.advanceTimersByTimeAsync(199);
      menu.dispatchEvent(pointerEvent("pointerenter"));
      await vi.advanceTimersByTimeAsync(1);
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBe(menu);
      menu.dispatchEvent(pointerEvent("pointerleave"));
      await vi.advanceTimersByTimeAsync(200);
      await sidebar.updateComplete;
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("keeps hover opening disabled without a fine hover pointer", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    try {
      const { sidebar } = await mountSidebar(
        createGateway({} as GatewayBrowserClient),
        createSessions("main", ["agent:main:main"]),
        "panel",
        TWO_AGENTS,
      );
      sidebar
        .querySelector<HTMLElement>(".sidebar-agent-card__main")
        ?.dispatchEvent(pointerEvent("pointerenter"));
      await vi.advanceTimersByTimeAsync(500);
      await sidebar.updateComplete;
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("requests composer focus and highlighting from the capabilities action", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    const onNavigate = vi.fn();
    sidebar.connected = true;
    sidebar.onNavigate = onNavigate;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    const item = sidebar.querySelector<HTMLElement>(
      'wa-dropdown-item[value="command:capabilities"]',
    );
    sidebar
      .querySelector(".sidebar-agent-menu")
      ?.dispatchEvent(new CustomEvent("wa-select", { detail: { item }, bubbles: true }));

    expect(onNavigate).toHaveBeenCalledOnce();
    const options = onNavigate.mock.calls[0]?.[1] as { search: string };
    const search = new URLSearchParams(options.search);
    expect(search.get("draft")).toBe("What can you do?");
    expect(search.get(SESSION_COMPOSER_FOCUS_PARAM)).toBe("1");
  });

  it("drops the menu below the agent card instead of covering it", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    sidebar.connected = true;
    await sidebar.updateComplete;

    const card = sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main");
    if (!card) {
      throw new Error("Expected the sidebar agent card");
    }
    card.getBoundingClientRect = () => ({ bottom: 88, left: 12, right: 252, top: 40 }) as DOMRect;
    card.click();
    await sidebar.updateComplete;

    const menus = (sidebar as unknown as { sidebarMenus: { agentMenuPosition: unknown } })
      .sidebarMenus;
    expect(menus.agentMenuPosition).toEqual({ x: 12, top: 92 });
    const menu = sidebar.querySelector(".sidebar-agent-menu");
    expect(menu?.getAttribute("placement")).toBe("bottom-start");
    expect(menu?.querySelector('[slot="trigger"]')?.getAttribute("style")).toContain("top: 92px");
  });

  it("keeps the widened agent menu inside a narrow viewport", async () => {
    vi.stubGlobal("innerWidth", 280);
    try {
      const gateway = createGateway({} as GatewayBrowserClient);
      const { sidebar } = await mountSidebar(
        gateway,
        createSessions("main", ["agent:main:main"]),
        "panel",
        TWO_AGENTS,
      );
      sidebar.connected = true;
      await sidebar.updateComplete;

      const card = sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main");
      if (!card) {
        throw new Error("Expected the sidebar agent card");
      }
      card.getBoundingClientRect = () =>
        ({ bottom: 88, left: 100, right: 340, top: 40 }) as DOMRect;
      card.click();
      await sidebar.updateComplete;

      const menus = (sidebar as unknown as { sidebarMenus: { agentMenuPosition: unknown } })
        .sidebarMenus;
      expect(menus.agentMenuPosition).toEqual({ x: 8, top: 92 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens the agent menu on right-click without toggling an open menu", async () => {
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    const card = sidebar.querySelector<HTMLElement>("openclaw-sidebar-agent-card");
    const trigger = card?.querySelector<HTMLElement>(".sidebar-agent-card__main");
    const label = card?.querySelector<HTMLElement>(".sidebar-agent-card__name");
    if (!card || !trigger || !label) {
      throw new Error("Expected the sidebar agent card");
    }
    trigger.getBoundingClientRect = () =>
      ({ bottom: 88, left: 12, right: 252, top: 40 }) as DOMRect;

    const firstContextMenu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    label.dispatchEvent(firstContextMenu);
    await sidebar.updateComplete;
    const firstMenu = sidebar.querySelector(".sidebar-agent-menu");
    expect(firstContextMenu.defaultPrevented).toBe(true);
    expect(firstMenu).not.toBeNull();

    label.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-agent-menu")).toBe(firstMenu);
  });

  it("collapses a single-agent roster to the three agent actions", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main", identity: { name: "Molty", emoji: "🦞" } }],
      },
    );
    sidebar.connected = true;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    const menu = sidebar.querySelector(".sidebar-agent-menu");
    expect(menu?.querySelector(".sidebar-customize-menu__title")).toBeNull();
    expect(menu?.querySelector(".sidebar-agent-menu__filter")).toBeNull();
    expect(menu?.querySelector(".sidebar-agent-menu__agent-switch")).toBeNull();
    expect(
      [...(menu?.children ?? [])]
        .filter((element) => element.localName === "wa-dropdown-item")
        .map((element) => element.getAttribute("value")),
    ).toEqual(["command:new-agent", "command:capabilities", "command:agent-settings"]);
  });

  it("navigates to the agents settings page with the active agent preselected", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    const onNavigate = vi.fn();
    sidebar.connected = true;
    sidebar.onNavigate = onNavigate;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    const settingsRow = [
      ...sidebar.querySelectorAll<HTMLElement>(".sidebar-agent-menu wa-dropdown-item"),
    ].find((row) => row.textContent?.includes("Agent settings"));
    expect(settingsRow).toBeDefined();
    settingsRow?.click();
    await sidebar.updateComplete;
    expect(onNavigate).toHaveBeenCalledWith("agents", { pathname: "/settings/agents/main" });
    expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
  });

  it("keeps the plain roster without a filter at six agents or fewer", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("agent-1", ["agent:agent-1:main"]),
      "panel",
      manyAgents(6),
    );
    sidebar.connected = true;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-agent-menu__filter")).toBeNull();
    expect(
      sidebar.querySelectorAll(
        ".sidebar-agent-menu wa-dropdown-item.sidebar-agent-menu__agent-switch",
      ),
    ).toHaveLength(6);
  });

  it("keeps pinned agents first in large scrollable rosters without a filter", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar, context } = await mountSidebar(
      gateway,
      createSessions("agent-1", ["agent:agent-1:main"]),
      "panel",
      manyAgents(12),
    );
    sidebar.connected = true;
    sidebar.pinnedAgentIds = ["agent-7", "agent-12"];
    // Pins sort first, but the scrollable grid keeps every configured agent reachable.
    context.agentSelection.state.selectedId = "agent-1";
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-agent-menu__filter")).toBeNull();
    // Pinned agents sort first without hiding the remaining roster.
    const labels = () =>
      [
        ...sidebar.querySelectorAll(
          ".sidebar-agent-menu wa-dropdown-item.sidebar-agent-menu__agent-switch .agent-select__option-label",
        ),
      ].map((el) => el.textContent?.trim());
    expect(labels()).toEqual([
      "agent-7",
      "agent-12",
      "agent-1",
      "agent-2",
      "agent-3",
      "agent-4",
      "agent-5",
      "agent-6",
      "agent-8",
      "agent-9",
      "agent-10",
      "agent-11",
    ]);
  });

  it("keeps the full large roster scrollable when nothing is pinned", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("agent-1", ["agent:agent-1:main"]),
      "panel",
      manyAgents(12),
    );
    sidebar.connected = true;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    expect(sidebar.querySelector(".sidebar-agent-menu__filter")).toBeNull();
    expect(
      sidebar.querySelectorAll(
        ".sidebar-agent-menu wa-dropdown-item.sidebar-agent-menu__agent-switch",
      ),
    ).toHaveLength(12);
    expect(sidebar.querySelector(".sidebar-agent-menu__agent-grid")).not.toBeNull();
  });

  it("ignores stale pins when choosing the large-roster fallback", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("agent-1", ["agent:agent-1:main"]),
      "panel",
      manyAgents(12),
    );
    sidebar.connected = true;
    sidebar.pinnedAgentIds = ["deleted-agent"];
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    expect(
      sidebar.querySelectorAll(
        ".sidebar-agent-menu wa-dropdown-item.sidebar-agent-menu__agent-switch",
      ),
    ).toHaveLength(12);
  });
});
