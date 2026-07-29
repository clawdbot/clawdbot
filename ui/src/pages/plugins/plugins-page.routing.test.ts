/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import {
  createClient,
  createContext,
  createGateway,
  createPluginsRouteLocation,
  createResult,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";
import type { PluginsRouteData } from "./plugins-page.ts";

function clickHubTab(page: HTMLElement, tab: "installed" | "discover" | "skills" | "workshop") {
  page
    .querySelector(`#plugins-tab-${tab}`)
    ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
}

describe("PluginsPage routing", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(resetPluginsPageTestState);

  it("applies the Discover path from route data", async () => {
    const { client } = createClient(async () => createResult());
    const harness = createGateway(client);
    const routeData: PluginsRouteData = {
      gateway: harness.gateway,
      gatewaySnapshot: harness.gateway.snapshot,
      result: createResult(),
      error: null,
      location: createPluginsRouteLocation("/settings/plugins/discover"),
    };
    const { page } = await mountPage(
      createContext(
        harness.gateway,
        vi.fn(async () => undefined),
      ),
      routeData,
    );

    expect(page.activeTab).toBe("discover");
    const tabGroup = page.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "wa-tab-group",
    );
    await tabGroup?.updateComplete;
    expect(
      page.querySelector<HTMLElement & { active: boolean }>("#plugins-tab-discover")?.active,
    ).toBe(true);
  });

  it.each([
    ["/settings/plugins", "installed", null],
    ["/settings/plugins/discover", "discover", null],
    ["/settings/plugins?tab=discover", "discover", "/settings/plugins/discover"],
    ["/settings/plugins?tab=installed", "installed", "/settings/plugins"],
    ["/settings/plugins?tab=unknown", "installed", "/settings/plugins"],
    [
      "/settings/plugins?tab=discover&query=calendar#featured",
      "discover",
      "/settings/plugins/discover?query=calendar#featured",
    ],
  ] as const)(
    "performs at most one replace for %s and never oscillates back to a query tab",
    async (sourceUrl, expectedTab, expectedUrl) => {
      const { client } = createClient(async () => createResult());
      const harness = createGateway(client);
      const context = createContext(
        harness.gateway,
        vi.fn(async () => undefined),
      );
      const routeData: PluginsRouteData = {
        gateway: harness.gateway,
        gatewaySnapshot: harness.gateway.snapshot,
        result: createResult(),
        error: null,
        location: createPluginsRouteLocation(sourceUrl),
      };
      const { page } = await mountPage(context, routeData);

      expect(page.activeTab).toBe(expectedTab);
      for (let cycle = 0; cycle < 3; cycle += 1) {
        page.routeData = { ...page.routeData } as PluginsRouteData;
        await page.updateComplete;
      }
      page.querySelector("wa-tab-group")?.dispatchEvent(
        new CustomEvent("wa-tab-show", {
          bubbles: true,
          composed: true,
          detail: { name: expectedTab === "discover" ? "installed" : "discover" },
        }),
      );

      expect(context.replace).toHaveBeenCalledTimes(expectedUrl ? 1 : 0);
      expect(context.navigate).not.toHaveBeenCalled();
      if (!expectedUrl) {
        return;
      }
      const canonicalLocation = createPluginsRouteLocation(expectedUrl);
      expect(context.replace).toHaveBeenCalledWith("plugins", canonicalLocation);

      page.routeData = { ...routeData, location: canonicalLocation };
      await page.updateComplete;
      for (let cycle = 0; cycle < 3; cycle += 1) {
        page.routeData = { ...page.routeData } as PluginsRouteData;
        await page.updateComplete;
      }
      expect(context.replace).toHaveBeenCalledOnce();
    },
  );

  it("pushes catalog tab paths and restores the tab from history", async () => {
    const { client } = createClient(async () => createResult());
    const harness = createGateway(client);
    const context = createContext(
      harness.gateway,
      vi.fn(async () => undefined),
    );
    const routeData: PluginsRouteData = {
      gateway: harness.gateway,
      gatewaySnapshot: harness.gateway.snapshot,
      location: createPluginsRouteLocation(),
      result: createResult(),
      error: null,
    };
    const { page } = await mountPage(context, routeData);

    clickHubTab(page, "skills");
    expect(context.navigate).toHaveBeenCalledWith("skills");
    clickHubTab(page, "workshop");
    expect(context.navigate).toHaveBeenCalledWith("skill-workshop");
    expect(page.activeTab).toBe("installed");

    clickHubTab(page, "discover");
    expect(page.activeTab).toBe("discover");
    expect(context.navigate).toHaveBeenCalledWith("plugins", {
      pathname: "/settings/plugins/discover",
    });
    page.routeData = {
      ...routeData,
      location: createPluginsRouteLocation("/settings/plugins/discover"),
    };
    await page.updateComplete;

    clickHubTab(page, "installed");
    expect(page.activeTab).toBe("installed");
    expect(context.navigate).toHaveBeenCalledWith("plugins", {
      pathname: "/settings/plugins",
    });

    page.routeData = {
      ...routeData,
      location: createPluginsRouteLocation("/settings/plugins/discover"),
    };
    await page.updateComplete;
    expect(page.activeTab).toBe("discover");
  });
});
