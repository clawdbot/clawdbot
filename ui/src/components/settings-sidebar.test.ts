/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { renderSettingsSidebar } from "./settings-sidebar.ts";

let container: HTMLDivElement;

beforeEach(async () => {
  await i18n.setLocale("en");
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  container.remove();
});

describe("settings sidebar search", () => {
  it("does not match the middle of a word for a short query", () => {
    render(
      renderSettingsSidebar({
        basePath: "",
        activeRouteId: "config",
        connected: true,
        version: "",
        updateAvailable: null,
        updateRunning: false,
        onUpdate: vi.fn(),
        searchQuery: "cp",
        searchBlockMatches: [
          {
            routeId: "config",
            label: "Gateway Host",
            hash: "#settings-general-system",
          },
        ],
        onExit: vi.fn(),
        onNavigate: vi.fn(),
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
      }),
      container,
    );

    const resultLabels = [
      ...container.querySelectorAll(
        ".settings-sidebar__item-label, .settings-sidebar__subitem-label",
      ),
    ].map((item) => item.textContent?.trim());
    expect(resultLabels).toEqual(["General", "Gateway Host"]);
  });

  it("ranks matching pages before matching blocks and navigates to the block", () => {
    const onNavigate = vi.fn();
    render(
      renderSettingsSidebar({
        basePath: "",
        activeRouteId: "config",
        connected: true,
        version: "",
        updateAvailable: null,
        updateRunning: false,
        onUpdate: vi.fn(),
        searchQuery: "mcp",
        searchBlockMatches: [
          {
            routeId: "config",
            label: "Automations",
            hash: "#settings-general-automations",
          },
          {
            routeId: "mcp",
            label: "MCP",
            search: "?section=mcp",
            hash: "#config-section-mcp",
          },
        ],
        onExit: vi.fn(),
        onNavigate,
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
      }),
      container,
    );

    const resultLabels = [
      ...container.querySelectorAll(
        ".settings-sidebar__item-label, .settings-sidebar__subitem-label",
      ),
    ].map((item) => item.textContent?.trim());
    expect(resultLabels).toEqual(["MCP", "General", "Automations"]);
    expect(container.querySelector(".settings-sidebar__item--active")).toBeNull();

    const automations = container.querySelector<HTMLAnchorElement>(
      '.settings-sidebar__subitem[href="/settings/general#settings-general-automations"]',
    );
    automations?.click();
    expect(onNavigate).toHaveBeenCalledWith("config", {
      hash: "#settings-general-automations",
    });
  });

  it("keeps a precise block result when its owning page also matches", () => {
    const onNavigate = vi.fn();
    render(
      renderSettingsSidebar({
        basePath: "",
        activeRouteId: "config",
        connected: true,
        version: "",
        updateAvailable: null,
        updateRunning: false,
        onUpdate: vi.fn(),
        searchQuery: "infrastructure",
        searchBlockMatches: [
          {
            routeId: "infrastructure",
            label: "Browser",
            search: "?section=browser",
            hash: "#config-section-browser",
          },
        ],
        onExit: vi.fn(),
        onNavigate,
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
      }),
      container,
    );

    const resultLabels = [
      ...container.querySelectorAll(
        ".settings-sidebar__item-label, .settings-sidebar__subitem-label",
      ),
    ].map((item) => item.textContent?.trim());
    expect(resultLabels).toEqual(["Infrastructure", "Browser"]);

    container
      .querySelector<HTMLAnchorElement>(
        '.settings-sidebar__subitem[href="/settings/infrastructure?section=browser#config-section-browser"]',
      )
      ?.click();
    expect(onNavigate).toHaveBeenCalledWith("infrastructure", {
      search: "?section=browser",
      hash: "#config-section-browser",
    });
  });

  it("filters localized routes and groups while preserving navigation", () => {
    let searchQuery = "";
    const onNavigate = vi.fn();
    const rerender = () => {
      render(
        renderSettingsSidebar({
          basePath: "",
          activeRouteId: "config",
          connected: true,
          version: "",
          updateAvailable: null,
          updateRunning: false,
          onUpdate: vi.fn(),
          searchQuery,
          onExit: vi.fn(),
          onNavigate,
          onSearchQueryChange: (nextQuery) => {
            searchQuery = nextQuery;
            rerender();
          },
          preloadTimers: new Map(),
        }),
        container,
      );
    };
    const enterQuery = (query: string) => {
      const input = container.querySelector<HTMLInputElement>(".settings-sidebar__search-input");
      if (!input) {
        throw new Error("expected settings search input");
      }
      input.value = query;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const labels = () =>
      [...container.querySelectorAll(".settings-sidebar__item-label")].map((item) =>
        item.textContent?.trim(),
      );

    rerender();
    const allLabels = labels();
    const input = container.querySelector<HTMLInputElement>(".settings-sidebar__search-input");
    expect(input?.getAttribute("aria-label")).toBe("Search settings");
    expect(input?.placeholder).toBe("Search settings…");
    expect(allLabels).toContain("Activity");
    expect(allLabels.indexOf("Activity")).toBe(allLabels.indexOf("Logs") + 1);

    enterQuery("  ThEmE  ");
    expect(labels()).toEqual(["Appearance"]);

    enterQuery("connections");
    expect(labels()).toEqual(["Connection", "Channels", "Communications"]);

    enterQuery("does-not-exist");
    expect(labels()).toEqual([]);
    expect(container.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      "No matching settings.",
    );

    container.querySelector<HTMLButtonElement>(".settings-sidebar__search-clear")?.click();
    expect(labels()).toEqual(allLabels);
    expect(document.activeElement).toBe(input);

    enterQuery("channel");
    container
      .querySelector<HTMLAnchorElement>('.settings-sidebar__item[href="/settings/channels"]')
      ?.click();
    expect(onNavigate).toHaveBeenCalledWith("channels");
  });

  it("keeps the update card above the settings footer", async () => {
    const onUpdate = vi.fn();
    render(
      renderSettingsSidebar({
        basePath: "",
        activeRouteId: "config",
        connected: true,
        version: "1.0.0",
        updateAvailable: {
          currentVersion: "1.0.0",
          latestVersion: "2.0.0",
          channel: "stable",
        },
        updateRunning: false,
        onUpdate,
        searchQuery: "",
        onExit: vi.fn(),
        onNavigate: vi.fn(),
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
      }),
      container,
    );

    const card = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-sidebar-update-card",
    );
    await card?.updateComplete;
    expect(card?.nextElementSibling?.classList.contains("settings-sidebar__footer")).toBe(true);
    card?.querySelector<HTMLButtonElement>(".sidebar-update-card__action")?.click();
    expect(onUpdate).toHaveBeenCalledOnce();
  });
});
