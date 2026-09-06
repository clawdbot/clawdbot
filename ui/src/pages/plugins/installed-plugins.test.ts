/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderInstalledPlugins, type InstalledPluginsProps } from "./installed-plugins.ts";
import { createPlugin, createResult } from "./plugins-page.test-support.ts";

function baseProps(overrides: Partial<InstalledPluginsProps> = {}): InstalledPluginsProps {
  return {
    connected: true,
    loading: false,
    result: createResult([createPlugin()]),
    error: null,
    expanded: false,
    searchOpen: false,
    query: "",
    busy: {},
    iconUrls: {},
    canMutate: true,
    mutationBlockedReason: null,
    consent: null,
    consentInspection: null,
    consentInspectionLoading: false,
    consentInspectionError: null,
    onExpandedChange: vi.fn(),
    onSearchOpenChange: vi.fn(),
    onQueryChange: vi.fn(),
    onRefresh: vi.fn(),
    settingsHref: (pluginId) => `/settings/plugins/${pluginId}?from=plugins`,
    onOpenSettings: vi.fn(),
    onIconError: vi.fn(),
    onCancelConsent: vi.fn(),
    onConfirmConsent: vi.fn(),
    onRetryConsentInspection: vi.fn(),
    ...overrides,
  };
}

function mount(props: InstalledPluginsProps): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderInstalledPlugins(props), container);
  return container;
}

function visiblePluginIds(container: Element): string[] {
  return [...container.querySelectorAll<HTMLElement>("[data-plugin-id]")].map(
    (card) => card.dataset.pluginId ?? "",
  );
}

describe("renderInstalledPlugins", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    for (const container of document.body.querySelectorAll("div")) {
      render(nothing, container);
    }
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("retries a failed catalog load without leaving the workspace", () => {
    const onRefresh = vi.fn();
    const container = mount(baseProps({ error: "Catalog unavailable", onRefresh }));

    const alert = expectDefined(container.querySelector('[role="alert"]'), "catalog error");
    expect(alert.textContent).toContain("Catalog unavailable");
    const retry = expectDefined(alert.querySelector<HTMLButtonElement>("button"), "retry button");
    expect(retry.textContent?.trim()).toBe("Try again");

    retry.click();

    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("prioritizes actionable plugins while keeping inline search independent from Show all", async () => {
    const plugins = [
      createPlugin({ id: "attention-b", name: "Attention B", state: "error", order: 20 }),
      createPlugin({ id: "needs-setup", name: "Needs Setup", state: "needs-setup", order: 5 }),
      createPlugin({
        id: "enabled-b",
        name: "Enabled B",
        enabled: true,
        state: "enabled",
        order: 20,
      }),
      ...Array.from({ length: 11 }, (_, index) =>
        createPlugin({
          id: `disabled-${String(index).padStart(2, "0")}`,
          name: `Disabled ${String(index).padStart(2, "0")}`,
          order: index,
        }),
      ),
      createPlugin({ id: "attention-a", name: "Attention A", state: "error", order: 10 }),
      createPlugin({
        id: "enabled-a",
        name: "Enabled A",
        enabled: true,
        state: "enabled",
        order: 10,
      }),
      createPlugin({
        id: "not-installed",
        name: "Not Installed",
        installed: false,
        state: "not-installed",
      }),
    ];
    let props = baseProps({ result: createResult(plugins) });
    const container = mount(props);
    const rerender = () => render(renderInstalledPlugins(props), container);
    props = {
      ...props,
      onExpandedChange: (expanded) => {
        props = { ...props, expanded };
        rerender();
      },
      onSearchOpenChange: (searchOpen) => {
        props = { ...props, searchOpen, query: searchOpen ? props.query : "" };
        rerender();
      },
      onQueryChange: (query) => {
        props = { ...props, query };
        rerender();
      },
    };
    rerender();

    expect(visiblePluginIds(container)).toHaveLength(12);
    expect(visiblePluginIds(container).slice(0, 5)).toEqual([
      "enabled-a",
      "enabled-b",
      "needs-setup",
      "attention-a",
      "attention-b",
    ]);
    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(container.textContent).not.toContain("Not Installed");

    const searchButton = expectDefined(
      container.querySelector<HTMLButtonElement>('[aria-label="Search plugins"]'),
      "installed search button",
    );
    searchButton.click();
    expect(visiblePluginIds(container)).toHaveLength(16);
    expect(container.textContent).not.toContain("Show all 16");

    const search = expectDefined(
      container.querySelector<HTMLInputElement>('input[type="search"]'),
      "expanded inventory search",
    );
    await Promise.resolve();
    expect(search.closest(".installed-plugins__actions")).not.toBeNull();
    expect(document.activeElement).toBe(search);
    search.value = "disabled 10";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(visiblePluginIds(container)).toEqual(["disabled-10"]);

    const closeSearch = expectDefined(
      container.querySelector<HTMLButtonElement>('.installed-plugins__search [aria-label="Close"]'),
      "close search button",
    );
    closeSearch.click();
    await Promise.resolve();
    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(visiblePluginIds(container)).toHaveLength(12);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Search plugins");

    const showAll = expectDefined(
      [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Show all 16"),
      ),
      "show all button",
    );
    showAll.click();
    expect(visiblePluginIds(container)).toHaveLength(16);
    expect(container.querySelector('input[type="search"]')).toBeNull();

    const hide = expectDefined(
      [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Hide"),
      ),
      "hide button",
    );
    hide.click();
    expect(container.querySelector('input[type="search"]')).toBeNull();
    expect(visiblePluginIds(container)).toHaveLength(12);
  });

  it("uses the Carapace surface without repeating an inventory subtitle", () => {
    const container = mount(baseProps());

    expect(container.querySelector(".settings-page.oc-app-surface")).not.toBeNull();
    expect(
      container.querySelector(".installed-plugins-card.oc-card.oc-card-interactive"),
    ).not.toBeNull();
    expect(container.querySelector(".installed-plugins__header p")).toBeNull();
    expect(container.querySelector("#installed-plugins-title")?.textContent).toBe(
      "Installed plugins",
    );
  });

  it("routes cards and the gear to settings without inline mutation controls or icon tooltips", () => {
    const onOpenSettings = vi.fn();
    const container = mount(
      baseProps({
        result: createResult([createPlugin({ id: "successful", name: "Successful" })]),
        onOpenSettings,
      }),
    );

    const successful = expectDefined(
      container.querySelector<HTMLElement>('[data-plugin-id="successful"]'),
      "successful plugin card",
    );
    successful.click();
    expect(onOpenSettings).toHaveBeenCalledWith("successful");

    expect(successful).toBeInstanceOf(HTMLAnchorElement);
    expect((successful as HTMLAnchorElement).getAttribute("href")).toBe(
      "/settings/plugins/successful?from=plugins",
    );
    expect(successful.querySelector("wa-switch")).toBeNull();

    const settings = expectDefined(
      container.querySelector<HTMLButtonElement>(
        '.installed-plugins__header [aria-label="Plugin settings"]',
      ),
      "settings button",
    );
    const search = expectDefined(
      container.querySelector<HTMLButtonElement>('[aria-label="Search plugins"]'),
      "search button",
    );
    expect(search.hasAttribute("title")).toBe(false);
    expect(settings.hasAttribute("title")).toBe(false);
    settings.click();
    expect(onOpenSettings).toHaveBeenLastCalledWith();
  });

  it("keeps setup-required state visible as read-only inventory context", () => {
    const container = mount(
      baseProps({
        result: createResult([
          createPlugin({ id: "needs-setup", name: "Needs Setup", state: "needs-setup" }),
        ]),
      }),
    );

    const card = expectDefined(
      container.querySelector<HTMLElement>('[data-plugin-id="needs-setup"]'),
      "needs-setup plugin card",
    );
    expect(card.textContent).toContain("Setup required");
    expect(card.getAttribute("data-plugin-status")).toBe("needs-setup");
    expect(card.querySelector("wa-switch")).toBeNull();
  });
});
