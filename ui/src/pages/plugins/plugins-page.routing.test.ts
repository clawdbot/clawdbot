/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import {
  createClient,
  createContext,
  createGateway,
  createInspectResult,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";
import type { PluginsRouteData } from "./plugins-page.ts";

function clickHubTab(page: HTMLElement, tab: "plugins" | "skills") {
  page
    .querySelector(`#plugins-tab-${tab}`)
    ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
}

async function switchToSettingsSurface(
  page: HTMLElement & {
    surface: "discovery" | "settings";
    routeData?: PluginsRouteData;
    updateComplete: Promise<boolean>;
  },
  routeData: PluginsRouteData,
) {
  page.surface = "settings";
  page.routeData = { ...routeData };
  await page.updateComplete;
}

describe("PluginsPage routing", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(resetPluginsPageTestState);

  it("switches between the Plugins and Skills workspace without reviving catalog tabs", async () => {
    const { client } = createClient(async () => createResult());
    const harness = createGateway(client);
    const context = createContext(harness.gateway);
    const routeData = createPluginsRouteData(
      harness.gateway,
      createResult(),
      createPluginsRouteLocation("/plugins"),
    );
    const { page } = await mountPage(context, routeData);

    expect(page.querySelector("#plugins-tab-plugins")).not.toBeNull();
    expect(page.querySelector("#plugins-tab-skills")).not.toBeNull();
    expect(page.querySelector("#plugins-tab-installed")).toBeNull();
    expect(page.querySelector("#plugins-tab-discover")).toBeNull();
    const header = page.querySelector(".plugins-hub-header");
    const tabs = page.querySelector(".plugins-tabs");
    expect(tabs?.classList.contains("oc-segmented")).toBe(true);
    expect(header?.firstElementChild?.classList.contains("hub-page-header__tabs")).toBe(true);

    clickHubTab(page, "plugins");
    expect(context.navigate).not.toHaveBeenCalled();
    clickHubTab(page, "skills");
    expect(context.navigate).toHaveBeenCalledWith("skills");
  });

  it("keeps the canonical settings inventory at /settings/plugins", async () => {
    const { client } = createClient(async () => createResult());
    const harness = createGateway(client);
    const context = createContext(harness.gateway);
    const routeData = createPluginsRouteData(
      harness.gateway,
      createResult(),
      createPluginsRouteLocation("/settings/plugins"),
    );
    const { page } = await mountPage(context, routeData);
    await switchToSettingsSurface(page, routeData);

    expect(context.replace).not.toHaveBeenCalled();
    expect(page.querySelector(".plugins-toolbar")).not.toBeNull();
  });

  it("opens the plugin selected by a settings detail path", async () => {
    const { client, request } = createClient(async (method) =>
      method === "plugins.inspect" ? createInspectResult() : createResult(),
    );
    const harness = createGateway(client);
    const context = createContext(harness.gateway);
    const routeData = createPluginsRouteData(
      harness.gateway,
      createResult(),
      createPluginsRouteLocation("/settings/plugins/workboard"),
    );
    const { page } = await mountPage(context, routeData);
    await switchToSettingsSurface(page, routeData);

    await vi.waitFor(() => {
      expect(page.querySelector('[data-detail-plugin-id="workboard"]')).not.toBeNull();
    });
    expect(request).toHaveBeenCalledWith("plugins.inspect", { pluginId: "workboard" });

    page.querySelector<HTMLButtonElement>(".plugins-detail__close")?.click();
    await page.updateComplete;
    expect(context.replace).toHaveBeenCalledWith("plugin-settings", {
      pathname: "/settings/plugins",
    });
    expect(page.querySelector('[data-detail-plugin-id="workboard"]')).toBeNull();
  });
});
