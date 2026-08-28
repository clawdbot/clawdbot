import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createGateway, createSessions, mountSidebar } from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar transient menus", () => {
  it("lets the session sort dropdown own its popover without another top-layer host", async () => {
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
    expect(menu?.closest("openclaw-menu-surface")).toBeNull();
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
    expect(firstMenu?.closest("openclaw-menu-surface")).toBeNull();
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
    const pagesLabel = sidebar.querySelector(
      ".sidebar-nav__head .sidebar-recent-sessions__label-text",
    );
    expect(pagesLabel?.classList.contains("sr-only")).toBe(true);
    expect(pagesLabel?.textContent).toBe("Pages");
    const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-nav__head-action");
    if (!trigger) {
      throw new Error("expected Pages menu trigger");
    }

    trigger.click();
    await sidebar.updateComplete;
    const firstMenu = sidebar.querySelector<HTMLElement>(".sidebar-more-menu");
    expect(firstMenu).not.toBeNull();
    expect(firstMenu?.closest("openclaw-menu-surface")).toBeNull();
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
    expect(firstMenu?.closest("openclaw-menu-surface")).toBeNull();
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
