/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { pt_BR } from "../i18n/locales/pt-BR.ts";
import { renderSettingsSidebar } from "./settings-sidebar.ts";
import "./tooltip.ts";

let container: HTMLDivElement;

const saveIndicator = () => ({
  status: "idle" as const,
  lastError: null,
  needsApply: false,
  applying: false,
  applyDisabled: false,
  onRetry: vi.fn(),
  onSave: vi.fn(),
  onReload: vi.fn(),
  onApply: vi.fn(),
});

const inactiveRefresh = {
  refreshRequired: false,
  onRefresh: async () => false,
};

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
  it("keeps Models selected while its setup flow is open", () => {
    render(
      renderSettingsSidebar({
        basePath: "",
        activeRouteId: "model-setup",
        offline: false,
        lastError: null,
        gatewayVersion: "",
        updateAvailable: null,
        updateBusy: false,
        onUpdate: vi.fn(),
        ...inactiveRefresh,
        searchQuery: "",
        onExit: vi.fn(),
        onRetryConnect: vi.fn(),
        onNavigate: vi.fn(),
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
        saveIndicator: saveIndicator(),
      }),
      container,
    );

    const active = container.querySelector<HTMLAnchorElement>(
      '.settings-sidebar__item[href="/settings/model-providers"]',
    );
    expect(active?.classList.contains("settings-sidebar__item--active")).toBe(true);
    expect(active?.getAttribute("aria-current")).toBe("page");
    expect(active?.textContent?.trim()).toBe("Models");
  });

  it("links Ask OpenClaw to the shared custodian route", () => {
    const onNavigate = vi.fn();
    render(
      renderSettingsSidebar({
        basePath: "",
        activeRouteId: "appearance",
        offline: false,
        lastError: null,
        gatewayVersion: "",
        updateAvailable: null,
        updateBusy: false,
        onUpdate: vi.fn(),
        ...inactiveRefresh,
        searchQuery: "",
        onExit: vi.fn(),
        onRetryConnect: vi.fn(),
        onNavigate,
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
        saveIndicator: saveIndicator(),
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
        activeRouteId: "appearance",
        offline: false,
        lastError: null,
        gatewayVersion: "",
        updateAvailable: null,
        updateBusy: false,
        onUpdate: vi.fn(),
        ...inactiveRefresh,
        searchQuery: "cp",
        searchBlockMatches: [
          {
            routeId: "connection",
            label: "Gateway Host",
            hash: "#settings-connection-host",
          },
        ],
        onExit: vi.fn(),
        onRetryConnect: vi.fn(),
        onNavigate: vi.fn(),
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
        saveIndicator: saveIndicator(),
      }),
      container,
    );

    const resultLabels = [
      ...container.querySelectorAll(
        ".settings-sidebar__item-label, .settings-sidebar__subitem-label",
      ),
    ].map((item) => item.textContent?.trim());
    expect(resultLabels).toEqual(["Gateway", "Gateway Host"]);
  });

  it("ranks matching pages before matching blocks and navigates to the block", () => {
    const onNavigate = vi.fn();
    render(
      renderSettingsSidebar({
        basePath: "",
        activeRouteId: "appearance",
        offline: false,
        lastError: null,
        gatewayVersion: "",
        updateAvailable: null,
        updateBusy: false,
        onUpdate: vi.fn(),
        ...inactiveRefresh,
        searchQuery: "mcp",
        searchBlockMatches: [
          {
            routeId: "appearance",
            label: "Language",
            search: "?section=__appearance__",
            hash: "#settings-language",
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
        saveIndicator: saveIndicator(),
      }),
      container,
    );

    const resultLabels = [
      ...container.querySelectorAll(
        ".settings-sidebar__item-label, .settings-sidebar__subitem-label",
      ),
    ].map((item) => item.textContent?.trim());
    expect(resultLabels).toEqual(["MCP", "Appearance", "Language"]);
    const active = container.querySelector(".settings-sidebar__item--active");
    expect(active?.textContent).toContain("Appearance");
    expect(active?.getAttribute("aria-current")).toBe("page");

    const language = container.querySelector<HTMLAnchorElement>(
      '.settings-sidebar__subitem[href="/settings/appearance?section=__appearance__#settings-language"]',
    );
    language?.click();
    expect(onNavigate).toHaveBeenCalledWith("appearance", {
      search: "?section=__appearance__",
      hash: "#settings-language",
    });
  });

  it("keeps a precise block result when its owning page also matches", () => {
    const onNavigate = vi.fn();
    render(
      renderSettingsSidebar({
        basePath: "",
        activeRouteId: "appearance",
        offline: false,
        lastError: null,
        gatewayVersion: "",
        updateAvailable: null,
        updateBusy: false,
        onUpdate: vi.fn(),
        ...inactiveRefresh,
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
        saveIndicator: saveIndicator(),
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

  it("finds Agent Defaults by page name after its sidebar demotion", () => {
    render(
      renderSettingsSidebar({
        basePath: "",
        activeRouteId: "agents",
        offline: false,
        lastError: null,
        gatewayVersion: "",
        updateAvailable: null,
        updateBusy: false,
        onUpdate: vi.fn(),
        ...inactiveRefresh,
        searchQuery: "agent defaults",
        onExit: vi.fn(),
        onRetryConnect: vi.fn(),
        onNavigate: vi.fn(),
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
        saveIndicator: saveIndicator(),
      }),
      container,
    );

    const result = container.querySelector<HTMLAnchorElement>(
      '.settings-sidebar__item[href="/settings/ai-agents"]',
    );
    expect(result?.textContent?.trim()).toBe("Agent Defaults");
  });

  it("excludes admin-only pages and config blocks from non-admin search", () => {
    render(
      renderSettingsSidebar({
        basePath: "",
        activeRouteId: "appearance",
        offline: false,
        lastError: null,
        gatewayVersion: "",
        updateAvailable: null,
        updateBusy: false,
        onUpdate: vi.fn(),
        ...inactiveRefresh,
        canAdmin: false,
        searchQuery: "security",
        searchBlockMatches: [
          {
            routeId: "security",
            label: "Security policy",
            hash: "#config-section-security",
          },
        ],
        onExit: vi.fn(),
        onRetryConnect: vi.fn(),
        onNavigate: vi.fn(),
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
        saveIndicator: saveIndicator(),
      }),
      container,
    );

    expect(container.querySelector('a[href="/settings/security"]')).toBeNull();
    expect(container.querySelector('a[href$="#config-section-security"]')).toBeNull();
    expect(container.querySelector('a[href="/settings/approvals"]')).not.toBeNull();
  });

  it("keeps Memory search results on the canonical Settings tab path", () => {
    const onNavigate = vi.fn();
    render(
      renderSettingsSidebar({
        basePath: "/ui",
        activeRouteId: "memory",
        activePathname: "/ui/settings/memory/settings",
        activeHash: "#memory-backend",
        offline: false,
        lastError: null,
        gatewayVersion: "",
        updateAvailable: null,
        updateBusy: false,
        onUpdate: vi.fn(),
        ...inactiveRefresh,
        searchQuery: "backend",
        searchBlockMatches: [
          {
            routeId: "memory",
            label: "Memory",
            pathname: "/ui/settings/memory/settings",
            hash: "#memory-backend",
          },
        ],
        onExit: vi.fn(),
        onRetryConnect: vi.fn(),
        onNavigate,
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
        saveIndicator: saveIndicator(),
      }),
      container,
    );

    const link = container.querySelector<HTMLAnchorElement>(
      '.settings-sidebar__subitem[href="/ui/settings/memory/settings#memory-backend"]',
    );
    expect(link).not.toBeNull();
    expect(link?.getAttribute("aria-current")).toBe("location");
    link?.click();
    expect(onNavigate).toHaveBeenCalledWith("memory", {
      pathname: "/ui/settings/memory/settings",
      hash: "#memory-backend",
    });
  });

  it("filters localized routes and groups while preserving navigation", () => {
    let searchQuery = "";
    const onNavigate = vi.fn();
    const rerender = () => {
      render(
        renderSettingsSidebar({
          basePath: "",
          activeRouteId: "appearance",
          offline: false,
          lastError: null,
          gatewayVersion: "",
          updateAvailable: null,
          updateBusy: false,
          onUpdate: vi.fn(),
          ...inactiveRefresh,
          searchQuery,
          onExit: vi.fn(),
          onRetryConnect: vi.fn(),
          onNavigate,
          onSearchQueryChange: (nextQuery) => {
            searchQuery = nextQuery;
            rerender();
          },
          preloadTimers: new Map(),
          saveIndicator: saveIndicator(),
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
    expect(allLabels.indexOf("Updates")).toBe(allLabels.indexOf("Logs") + 1);
    expect(allLabels.indexOf("About")).toBe(allLabels.indexOf("Updates") + 1);

    enterQuery("  ThEmE  ");
    expect(labels()).toEqual(["Appearance"]);

    enterQuery("connections");
    expect(labels()).toEqual([
      "Gateway",
      "Channels",
      "Communications",
      "Talk",
      "Devices",
      "Cloud workers",
    ]);

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

  it("clears a focused search before Escape exits Settings", () => {
    let searchQuery = "gateway";
    const onExit = vi.fn();
    const rerender = () => {
      render(
        renderSettingsSidebar({
          basePath: "",
          activeRouteId: "appearance",
          offline: false,
          lastError: null,
          gatewayVersion: "",
          updateAvailable: null,
          updateBusy: false,
          onUpdate: vi.fn(),
          ...inactiveRefresh,
          searchQuery,
          onExit,
          onRetryConnect: vi.fn(),
          onNavigate: vi.fn(),
          onSearchQueryChange: (nextQuery) => {
            searchQuery = nextQuery;
            rerender();
          },
          preloadTimers: new Map(),
          saveIndicator: saveIndicator(),
        }),
        container,
      );
    };

    rerender();
    const input = container.querySelector<HTMLInputElement>(".settings-sidebar__search-input");
    expect(input).not.toBeNull();
    input?.focus();

    input?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(searchQuery).toBe("");
    expect(document.activeElement).toBe(input);
    expect(onExit).not.toHaveBeenCalled();

    input?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(onExit).toHaveBeenCalledOnce();
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
        activeRouteId: "appearance",
        offline: false,
        lastError: null,
        gatewayVersion: "",
        updateAvailable: null,
        updateBusy: false,
        onUpdate: vi.fn(),
        ...inactiveRefresh,
        searchQuery: "",
        onExit: vi.fn(),
        onRetryConnect: vi.fn(),
        onNavigate: vi.fn(),
        onSearchQueryChange: vi.fn(),
        preloadTimers: new Map(),
        saveIndicator: saveIndicator(),
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

  it("shows the offline retry action without an online status", () => {
    const onRetryConnect = vi.fn();
    const renderSidebar = (
      offline: boolean,
      lastError: string | null,
      queuedOutboxCount = 0,
      restartPending = false,
      suspensionPhase?: Parameters<typeof renderSettingsSidebar>[0]["suspensionPhase"],
    ) =>
      render(
        renderSettingsSidebar({
          basePath: "",
          activeRouteId: "appearance",
          offline,
          restartPending,
          suspensionPhase,
          queuedOutboxCount,
          lastError,
          gatewayVersion: "1.0.0",
          updateAvailable: null,
          updateBusy: false,
          onUpdate: vi.fn(),
          ...inactiveRefresh,
          searchQuery: "",
          onExit: vi.fn(),
          onRetryConnect,
          onNavigate: vi.fn(),
          onSearchQueryChange: vi.fn(),
          preloadTimers: new Map(),
          saveIndicator: { ...saveIndicator(), status: "saving" },
        }),
        container,
      );

    renderSidebar(false, null, 3);
    expect(container.querySelector(".sidebar-footer-bar__status")).toBeNull();
    expect(container.querySelector("openclaw-settings-save-indicator")).not.toBeNull();

    renderSidebar(false, null, 0, false, "prepared");
    expect(container.querySelector(".sidebar-footer-bar__status")?.textContent).toBe("Suspended");
    expect(container.querySelector("openclaw-settings-save-indicator")).toBeNull();
    renderSidebar(false, null, 0, false, "accepting");
    expect(container.querySelector(".sidebar-footer-bar__status")).toBeNull();
    expect(container.querySelector("openclaw-settings-save-indicator")).not.toBeNull();

    renderSidebar(true, "connection refused?token=settings-secret", 3, false, "prepared");
    expect(container.querySelector("openclaw-settings-save-indicator")).toBeNull();
    const button = container.querySelector<HTMLButtonElement>(".sidebar-footer-bar__status");
    expect(button?.hasAttribute("title")).toBe(false);
    expect(
      (button?.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)?.content,
    ).toBe("connection refused?[redacted-credential]");
    expect(button?.textContent).toContain("3 queued");
    expect(button?.getAttribute("aria-label")).toBe("Offline — Retry now — 3 queued");
    button?.click();
    expect(onRetryConnect).toHaveBeenCalledOnce();

    renderSidebar(true, null, 3, true, "prepared");
    expect(container.querySelector(".sidebar-footer-bar__status--restarting")?.textContent).toBe(
      "Restarting…",
    );
    expect(container.querySelector("button.sidebar-footer-bar__status")).toBeNull();
  });
});
