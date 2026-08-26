import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  catalogPage,
  createGateway,
  createSessions,
  createSessionsHarness,
  mountSidebar,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar catalog row lifecycle", () => {
  it("retargets an open menu when its row is adopted", async () => {
    const adoptedKey = "agent:main:adopted-menu";
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main", adoptedKey]),
    );
    const setCatalog = async (sessionKey?: string) => {
      sidebar.sessionData.sessionCatalogs = catalogPage([
        { threadId: "thread-adopted-menu", name: "Adopted menu", sessionKey },
      ]).catalogs;
      sidebar.sessionData.requestSessionDataUpdate();
      await sidebar.updateComplete;
    };
    await setCatalog();
    sidebar.querySelector<HTMLButtonElement>("[data-catalog-session-menu]")?.click();
    await sidebar.updateComplete;
    await setCatalog(adoptedKey);
    await Promise.resolve();
    await sidebar.updateComplete;

    const adoptedMenu = sidebar.querySelector<HTMLButtonElement>(
      `[data-session-key="${adoptedKey}"] [data-session-menu]`,
    );
    const popup = sidebar.querySelector<HTMLElement & { trigger?: HTMLElement }>(
      "openclaw-catalog-session-menu",
    );
    expect(adoptedMenu?.getAttribute("aria-expanded")).toBe("true");
    expect(popup?.trigger).toBe(adoptedMenu);
    popup?.querySelector<HTMLElement>("wa-dropdown-item")?.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sidebar.updateComplete;
    expect(document.activeElement).toBe(adoptedMenu);
  });

  it("clears marquee state when a catalog label changes", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    const setLabel = async (name: string) => {
      sidebar.sessionData.sessionCatalogs = catalogPage([
        { threadId: "thread-rename", name },
      ]).catalogs;
      sidebar.sessionData.requestSessionDataUpdate();
      await sidebar.updateComplete;
    };
    await setLabel("A long catalog session title");
    const oldLabel = sidebar.querySelector<HTMLElement>(".hover-marquee");
    oldLabel?.classList.add("hover-marquee--scrolling");
    oldLabel?.style.setProperty("--hover-marquee-shift", "-80px");
    await setLabel("Short");

    const updatedLabel = sidebar.querySelector<HTMLElement>(".hover-marquee");
    expect(updatedLabel).not.toBe(oldLabel);
    expect(updatedLabel?.classList.contains("hover-marquee--scrolling")).toBe(false);
    expect(updatedLabel?.style.getPropertyValue("--hover-marquee-shift")).toBe("");
  });

  it("clears adopted marquee state when its live pull request appears", async () => {
    const adoptedKey = "agent:main:adopted-pull-request";
    const gateway = createGateway({} as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", ["agent:main:main", adoptedKey]);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);
    sidebar.sessionData.sessionCatalogs = catalogPage([
      { threadId: "thread-adopted-pr", name: "Adopted session", sessionKey: adoptedKey },
    ]).catalogs;
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;

    const row = sidebar.querySelector<HTMLElement>(`[data-session-key="${adoptedKey}"]`);
    const oldLabel = row?.querySelector<HTMLElement>(".hover-marquee");
    oldLabel?.classList.add("hover-marquee--scrolling");
    oldLabel?.style.setProperty("--hover-marquee-shift", "-80px");
    sessions.sessions.setPullRequestSummary(adoptedKey, { numbers: [125820], state: "open" });
    await sidebar.updateComplete;

    const updatedLabel = row?.querySelector<HTMLElement>(".hover-marquee");
    expect(updatedLabel).not.toBe(oldLabel);
    expect(updatedLabel?.classList.contains("hover-marquee--scrolling")).toBe(false);
    expect(row?.querySelector(".session-row-badge--pull-request")).not.toBeNull();
  });
});
