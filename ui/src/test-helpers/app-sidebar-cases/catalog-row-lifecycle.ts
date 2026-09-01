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
  it.each([
    { label: undefined, expected: "Captured native title" },
    { label: "Operator chosen label", expected: "Operator chosen label" },
  ])(
    "keeps the adopted session name $expected after a native rename",
    async ({ label, expected }) => {
      const adoptedKey = "agent:main:adopted-title";
      const sessions = createSessionsHarness("main", ["agent:main:main", adoptedKey]);
      const adoptedRow = sessions.sessions.state.result!.sessions.find(
        (row) => row.key === adoptedKey,
      )!;
      adoptedRow.label = label;
      adoptedRow.displayName = "Captured native title";
      adoptedRow.boardFace = "dashboard";
      const { sidebar } = await mountSidebar(
        createGateway({} as GatewayBrowserClient),
        sessions.sessions,
      );
      sidebar.sessionData.sessionCatalogs = catalogPage([
        { threadId: "thread-adopted-title", name: "Renamed upstream", sessionKey: adoptedKey },
      ]).catalogs;
      sidebar.sessionData.requestSessionDataUpdate();
      await sidebar.updateComplete;

      const row = sidebar.querySelector(`[data-session-key="${adoptedKey}"]`);
      expect(row?.querySelector(".sidebar-recent-session__name")?.textContent).toBe(expected);
      expect(row?.querySelector("[data-session-menu]")?.getAttribute("aria-label")).toContain(
        expected,
      );
      expect(row?.querySelector("a")?.getAttribute("href")).toBe(
        "/dashboard/main/adopted-title?nav=collapsed",
      );
    },
  );
  it("uses catalog colors only until the live session owns the row", async () => {
    const key = "agent:main:adopted-color";
    const sessions = createSessionsHarness("main", [key]);
    const { sidebar } = await mountSidebar(
      createGateway({} as GatewayBrowserClient),
      sessions.sessions,
    );
    const catalog = catalogPage([{ threadId: "colored", name: "CLI session", color: "cyan" }]);
    sidebar.sessionData.sessionCatalogs = catalog.catalogs;
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;
    const row = () => sidebar.querySelector<HTMLElement>("[data-catalog-session-key]");
    expect(row()?.classList.contains("sidebar-recent-session--colored")).toBe(true);
    expect(row()?.style.getPropertyValue("--session-color")).toBe("var(--session-color-cyan)");
    sidebar.sessionData.sessionCatalogs = catalogPage([
      { threadId: "colored", name: "CLI session", color: "cyan", sessionKey: key },
    ]).catalogs;
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;
    expect(row()?.classList.contains("sidebar-recent-session--colored")).toBe(false);
    expect(row()?.style.getPropertyValue("--session-color")).toBe("");
  });

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
