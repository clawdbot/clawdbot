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

describe("AppSidebar session catalog row identity", () => {
  it("does not carry marquee state across material updates or replacements", async () => {
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(gateway, createSessions("main", ["agent:main:main"]));
    sidebar.sessionData.sessionCatalogs = catalogPage([
      { threadId: "thread-first", name: "First catalog session" },
      { threadId: "thread-second", name: "Second catalog session" },
    ]).catalogs;
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;

    const firstRow = sidebar.querySelector<HTMLElement>(
      '[data-session-section="catalog:codex"] [data-session-key$=":thread-first"]',
    );
    const firstLabel = firstRow?.querySelector<HTMLElement>(".hover-marquee");
    const firstMenu = firstRow?.querySelector<HTMLButtonElement>("[data-catalog-session-menu]");
    firstLabel?.classList.add("hover-marquee--scrolling");
    firstLabel?.style.setProperty("--hover-marquee-shift", "-80px");
    firstMenu?.focus();
    expect(document.activeElement).toBe(firstMenu);

    sidebar.sessionData.sessionCatalogs = catalogPage([
      { threadId: "thread-second", name: "Second catalog session" },
      { threadId: "thread-first", name: "Renamed catalog session" },
    ]).catalogs;
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;

    const updatedRow = sidebar.querySelector<HTMLElement>(
      '[data-session-section="catalog:codex"] [data-session-key$=":thread-first"]',
    );
    const updatedLabel = updatedRow?.querySelector<HTMLElement>(".hover-marquee");
    const updatedMenu = updatedRow?.querySelector<HTMLButtonElement>("[data-catalog-session-menu]");
    expect(updatedRow).toBe(firstRow);
    expect(updatedLabel).not.toBe(firstLabel);
    expect(updatedMenu).toBe(firstMenu);
    expect(document.activeElement).toBe(updatedMenu);
    expect(updatedLabel?.classList.contains("hover-marquee--scrolling")).toBe(false);
    expect(updatedLabel?.style.getPropertyValue("--hover-marquee-shift")).toBe("");
    updatedLabel?.classList.add("hover-marquee--scrolling");
    updatedLabel?.style.setProperty("--hover-marquee-shift", "-60px");

    sidebar.sessionData.sessionCatalogs = catalogPage([
      { threadId: "thread-third", name: "Replacement catalog session" },
    ]).catalogs;
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;

    const replacementRow = sidebar.querySelector<HTMLElement>(
      '[data-session-section="catalog:codex"] .sidebar-recent-session',
    );
    const replacementLabel = replacementRow?.querySelector<HTMLElement>(".hover-marquee");
    expect(replacementRow).not.toBe(updatedRow);
    expect(replacementLabel?.classList.contains("hover-marquee--scrolling")).toBe(false);
    expect(replacementLabel?.style.getPropertyValue("--hover-marquee-shift")).toBe("");
  });

  it("restores menu focus when a catalog thread is adopted", async () => {
    const adoptedKey = "agent:main:adopted";
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main", adoptedKey]),
    );
    sidebar.sessionData.sessionCatalogs = catalogPage([
      { threadId: "thread-adopted", name: "Catalog session" },
    ]).catalogs;
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;

    const catalogMenu = sidebar.querySelector<HTMLButtonElement>("[data-catalog-session-menu]");
    catalogMenu?.focus();
    expect(document.activeElement).toBe(catalogMenu);

    sidebar.sessionData.sessionCatalogs = catalogPage([
      { threadId: "thread-adopted", name: "Catalog session", sessionKey: adoptedKey },
    ]).catalogs;
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;

    const adoptedMenu = sidebar.querySelector<HTMLButtonElement>(
      `[data-session-key="${adoptedKey}"] [data-session-menu]`,
    );
    expect(document.activeElement).toBe(adoptedMenu);
  });

  it("resets an adopted marquee when its live pull request appears", async () => {
    const adoptedKey = "agent:main:adopted-pull-request";
    const gateway = createGateway({} as GatewayBrowserClient);
    const sessions = createSessionsHarness("main", ["agent:main:main", adoptedKey]);
    const { sidebar } = await mountSidebar(gateway, sessions.sessions);
    sidebar.sessionData.sessionCatalogs = catalogPage([
      {
        threadId: "thread-adopted-pull-request",
        name: "Adopted catalog session",
        sessionKey: adoptedKey,
      },
    ]).catalogs;
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;

    const row = sidebar.querySelector<HTMLElement>(`[data-session-key="${adoptedKey}"]`);
    const label = row?.querySelector<HTMLElement>(".hover-marquee");
    label?.classList.add("hover-marquee--scrolling");
    label?.style.setProperty("--hover-marquee-shift", "-80px");

    sessions.sessions.setPullRequestSummary(adoptedKey, { numbers: [125820], state: "open" });
    await sidebar.updateComplete;

    const updatedRow = sidebar.querySelector<HTMLElement>(`[data-session-key="${adoptedKey}"]`);
    const updatedLabel = updatedRow?.querySelector<HTMLElement>(".hover-marquee");
    expect(updatedRow).toBe(row);
    expect(updatedLabel).not.toBe(label);
    expect(updatedLabel?.classList.contains("hover-marquee--scrolling")).toBe(false);
    expect(updatedLabel?.style.getPropertyValue("--hover-marquee-shift")).toBe("");
    expect(updatedRow?.querySelector(".session-row-badge--pull-request")).not.toBeNull();
  });

  it("restores menu focus when an adopted catalog thread loses its session", async () => {
    const adoptedKey = "agent:main:released";
    const gateway = createGateway({} as GatewayBrowserClient);
    const { sidebar } = await mountSidebar(
      gateway,
      createSessions("main", ["agent:main:main", adoptedKey]),
    );
    sidebar.sessionData.sessionCatalogs = catalogPage([
      {
        threadId: "thread-released",
        name: "Adopted catalog session",
        sessionKey: adoptedKey,
      },
    ]).catalogs;
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;

    const adoptedMenu = sidebar.querySelector<HTMLButtonElement>(
      `[data-session-key="${adoptedKey}"] [data-session-menu]`,
    );
    adoptedMenu?.focus();
    expect(document.activeElement).toBe(adoptedMenu);

    sidebar.sessionData.sessionCatalogs = catalogPage([
      { threadId: "thread-released", name: "Native catalog session" },
    ]).catalogs;
    sidebar.sessionData.requestSessionDataUpdate();
    await sidebar.updateComplete;

    const nativeMenu = sidebar.querySelector<HTMLButtonElement>(
      '[data-session-key$=":thread-released"] [data-catalog-session-menu]',
    );
    expect(document.activeElement).toBe(nativeMenu);
  });
});
