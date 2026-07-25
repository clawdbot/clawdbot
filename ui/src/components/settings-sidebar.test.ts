/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { pt_BR } from "../i18n/locales/pt-BR.ts";
import { renderSettingsSidebar } from "./settings-sidebar.ts";
import "./tooltip.ts";

let container: HTMLDivElement;

beforeEach(async () => {
  await i18n.setLocale("en");
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  i18n.registerTranslation("pt-BR", pt_BR);
  await i18n.setLocale("en");
  container.remove();
});

describe("settings sidebar search", () => {
  it("links Ask OpenClaw to the shared custodian route", () => {
    const onNavigate = vi.fn();
    render(
      renderSettingsSidebar({
        basePath: "",
        activeRouteId: "config",
        offline: false,
        lastError: null,
        version: "",
        updateAvailable: null,
        updateRunning: false,
        onUpdate: vi.fn(),
        searchQuery: "",
        onExit: vi.fn(),
        onRetryConnect: vi.fn(),
        onNavigate,
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
      }),
      container,
    );

    const link = container.querySelector<HTMLAnchorElement>(
      '.settings-sidebar__item[href="/custodian"]',
    );
    expect(link?.textContent?.trim()).toBe("Ask OpenClaw");
    link?.click();
    expect(onNavigate).toHaveBeenCalledWith("custodian");
  });

  it("does not match the middle of a word for a short query", () => {
    render(
      renderSettingsSidebar({
        basePath: "",
        activeRouteId: "config",
        offline: false,
        lastError: null,
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
        onRetryConnect: vi.fn(),
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
        offline: false,
        lastError: null,
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
        onRetryConnect: vi.fn(),
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
        offline: false,
        lastError: null,
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
        onRetryConnect: vi.fn(),
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
          offline: false,
          lastError: null,
          version: "",
          updateAvailable: null,
          updateRunning: false,
          onUpdate: vi.fn(),
          searchQuery,
          onExit: vi.fn(),
          onRetryConnect: vi.fn(),
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
    // Management surfaces moved back to the workspace sidebar.
    expect(allLabels).not.toContain("Activity");
    expect(allLabels).not.toContain("Sessions");
    expect(allLabels).toContain("Privacy & Security");
    expect(allLabels.indexOf("About")).toBe(allLabels.indexOf("Logs") + 1);

    enterQuery("  ThEmE  ");
    expect(labels()).toEqual(["Appearance"]);

    enterQuery("connections");
    expect(labels()).toEqual(["Connection", "Channels", "Communications", "Devices"]);

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

  it("renders refreshed settings route titles from the active locale", async () => {
    i18n.registerTranslation("pt-BR", {
      routeTitles: {
        notifications: "Notificacoes",
        modelProviders: "Provedores de modelos",
        advanced: "Avancado",
      },
    });
    await i18n.setLocale("pt-BR");

    render(
      renderSettingsSidebar({
        basePath: "",
        activeRouteId: "config",
        offline: false,
        lastError: null,
        version: "",
        updateAvailable: null,
        updateRunning: false,
        onUpdate: vi.fn(),
        searchQuery: "",
        onExit: vi.fn(),
        onRetryConnect: vi.fn(),
        onNavigate: vi.fn(),
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
      }),
      container,
    );

    const labels = [...container.querySelectorAll(".settings-sidebar__item-label")].map((item) =>
      item.textContent?.trim(),
    );
    expect(labels).toContain("Notificacoes");
    expect(labels).toContain("Provedores de modelos");
    expect(labels).toContain("Avancado");
  });

  it("keeps the update card above the settings footer", async () => {
    const onUpdate = vi.fn();
    render(
      renderSettingsSidebar({
        basePath: "",
        activeRouteId: "config",
        offline: false,
        lastError: null,
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
        onRetryConnect: vi.fn(),
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

  it("shows the offline retry action without an online status", () => {
    const onRetryConnect = vi.fn();
    const renderSidebar = (offline: boolean, lastError: string | null, queuedOutboxCount = 0) =>
      render(
        renderSettingsSidebar({
          basePath: "",
          activeRouteId: "config",
          offline,
          queuedOutboxCount,
          lastError,
          version: "1.0.0",
          updateAvailable: null,
          updateRunning: false,
          onUpdate: vi.fn(),
          searchQuery: "",
          onExit: vi.fn(),
          onRetryConnect,
          onNavigate: vi.fn(),
          onSearchQueryChange: vi.fn(),
          preloadTimers: new Map(),
        }),
        container,
      );

    renderSidebar(false, null, 3);
    expect(container.querySelector(".sidebar-footer-bar__status")).toBeNull();

    renderSidebar(true, "connection refused?token=settings-secret", 3);
    const button = container.querySelector<HTMLButtonElement>(".sidebar-footer-bar__status");
    expect(button?.hasAttribute("title")).toBe(false);
    expect(
      (button?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)?.content,
    ).toBe("connection refused?[redacted-credential]");
    expect(button?.textContent).toContain("3 queued");
    expect(button?.getAttribute("aria-label")).toBe("Offline — Retry now — 3 queued");
    button?.click();
    expect(onRetryConnect).toHaveBeenCalledOnce();
  });
});
