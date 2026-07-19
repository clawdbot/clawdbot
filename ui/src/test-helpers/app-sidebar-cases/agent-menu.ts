import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessions,
  manyAgents,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar agent chip", () => {
  it("opens the footer menu with agent switching and folded-in utilities", async () => {
    const gatewayHarness = createGatewayHarness({} as GatewayBrowserClient);
    const setSessionKey = vi.fn();
    (gatewayHarness.gateway as { setSessionKey: (key: string) => void }).setSessionKey =
      setSessionKey;
    const { sidebar } = await mountSidebar(
      gatewayHarness.gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
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
    expect(menu?.querySelector(".sidebar-pair-mobile")).not.toBeNull();
    expect(menu?.querySelector("openclaw-sidebar-build-chip")).not.toBeNull();
    expect(menu?.querySelector("openclaw-theme-mode-toggle")).not.toBeNull();
    // External help links stay folded into Web Awesome's keyboard-navigable submenu.
    const helpRow = [...(menu?.querySelectorAll<HTMLElement>("wa-dropdown-item") ?? [])].find(
      (row) => row.textContent?.includes("Help"),
    );
    await (helpRow as (HTMLElement & { updateComplete?: Promise<unknown> }) | undefined)
      ?.updateComplete;
    expect(helpRow?.getAttribute("aria-haspopup")).toBe("menu");
    helpRow?.click();
    await sidebar.updateComplete;

    const linkHrefs = [
      ...(menu?.querySelectorAll('wa-dropdown-item[slot="submenu"] a[href]') ?? []),
    ].map((link) => link.getAttribute("href"));
    expect(linkHrefs).toEqual([
      "https://docs.openclaw.ai",
      "https://docs.openclaw.ai/help",
      "https://discord.gg/clawd",
      "https://docs.openclaw.ai/releases",
    ]);
    const openExternal = vi.spyOn(window, "open").mockReturnValue(null);
    menu?.querySelector<HTMLElement>('wa-dropdown-item[slot="submenu"]')?.click();
    expect(openExternal).toHaveBeenCalledWith(
      "https://docs.openclaw.ai/",
      "_blank",
      "noopener,noreferrer",
    );
    openExternal.mockRestore();
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    const reopenedMenu = sidebar.querySelector(".sidebar-agent-menu");

    const agentRows = [
      ...(reopenedMenu?.querySelectorAll('wa-dropdown-item[type="checkbox"]') ?? []),
    ];
    expect(agentRows).toHaveLength(2);
    expect(reopenedMenu?.querySelector(".sidebar-agent-menu__new")).toBeNull();
    const switchMenu = reopenedMenu;
    const researchRow = [
      ...(switchMenu?.querySelectorAll<HTMLElement>('wa-dropdown-item[type="checkbox"]') ?? []),
    ].find((row) => row.textContent?.includes("research"));
    expect(researchRow).toBeDefined();
    switchMenu?.dispatchEvent(
      new CustomEvent("wa-select", { detail: { item: researchRow }, bubbles: true }),
    );
    await sidebar.updateComplete;

    // No cached sessions for the other agent: resume falls back to its main key.
    expect(setSessionKey).toHaveBeenCalledWith("agent:research:main");
    expect(onNavigate).toHaveBeenCalledWith("chat", {
      search: "?session=agent%3Aresearch%3Amain",
    });
    expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
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
    expect(onNavigate).toHaveBeenCalledWith("agents", { search: "?agent=main" });
    expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
  });

  it("keeps the plain roster without a filter at ten agents or fewer", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("agent-1", ["agent:agent-1:main"]),
      "panel",
      manyAgents(10),
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
    ).toHaveLength(10);
  });

  it("shows pinned agents plus filter for large rosters and filters on input", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar, context } = await mountSidebar(
      gateway,
      createSessions("agent-1", ["agent:agent-1:main"]),
      "panel",
      manyAgents(12),
    );
    sidebar.connected = true;
    sidebar.pinnedAgentIds = ["agent-7", "agent-12"];
    // Two agents pinned while a third is active: the menu must keep all three.
    context.agentSelection.state.selectedId = "agent-1";
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    const input = sidebar.querySelector<HTMLInputElement>(".sidebar-agent-menu__filter input");
    expect(input).not.toBeNull();
    // Pinned agents plus the active one; pinned sort first.
    const labels = () =>
      [
        ...sidebar.querySelectorAll(
          ".sidebar-agent-menu wa-dropdown-item.sidebar-agent-menu__agent-switch .sidebar-customize-menu__text",
        ),
      ].map((el) => el.textContent?.trim());
    expect(labels()).toEqual(["agent-7", "agent-12", "agent-1"]);

    if (!input) {
      throw new Error("Expected agent menu filter input");
    }
    const dropdown = sidebar.querySelector("wa-dropdown");
    const onDropdownKeydown = vi.fn();
    dropdown?.addEventListener("keydown", onDropdownKeydown);
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(onDropdownKeydown).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      sidebar.querySelector(
        ".sidebar-agent-menu wa-dropdown-item.sidebar-agent-menu__agent-switch",
      ),
    );
    onDropdownKeydown.mockClear();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(onDropdownKeydown).toHaveBeenCalledOnce();
    onDropdownKeydown.mockClear();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(onDropdownKeydown).not.toHaveBeenCalled();

    input.value = "agent-11";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sidebar.updateComplete;
    expect(labels()).toEqual(["agent-11"]);
  });

  it("falls back to the first ten agents when nothing is pinned", async () => {
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
    expect(sidebar.querySelector(".sidebar-agent-menu__filter")).not.toBeNull();
    expect(
      sidebar.querySelectorAll(
        ".sidebar-agent-menu wa-dropdown-item.sidebar-agent-menu__agent-switch",
      ),
    ).toHaveLength(10);
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
    ).toHaveLength(10);
  });

  it("keeps an active agent outside the first ten reachable when nothing is pinned", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar, context } = await mountSidebar(
      gateway,
      createSessions("agent-12", ["agent:agent-12:main"]),
      "panel",
      manyAgents(12),
    );
    context.agentSelection.state.selectedId = "agent-12";
    context.agentSelection.state.scopeId = "agent-12";
    sidebar.sessionKey = "agent:agent-12:main";
    sidebar.connected = true;
    await sidebar.updateComplete;

    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;
    const rows = [
      ...sidebar.querySelectorAll(
        ".sidebar-agent-menu wa-dropdown-item.sidebar-agent-menu__agent-switch",
      ),
    ];
    expect(rows).toHaveLength(10);
    expect(rows.some((row) => row.textContent?.includes("agent-12"))).toBe(true);
  });
});
