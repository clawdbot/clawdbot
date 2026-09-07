// @vitest-environment node
import {
  createRouter,
  definePage,
  type PageDefinition,
  type RouteLoaderOptions,
  type RouteLocation,
  type RouterHistory,
} from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import { routePageSpec, type RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { pages } from "./route.ts";

type RouteModule = { header: boolean; render: () => unknown };

const removedGeneralPage = pages.find((page) => page.id === "config") as PageDefinition<
  RouteId,
  ApplicationContext,
  RouteModule
>;
const updatesPage = pages.find((page) => page.id === "updates") as PageDefinition<
  RouteId,
  ApplicationContext,
  RouteModule
>;

function locationFromUrl(url: string): RouteLocation {
  const parsed = new URL(url, "https://control.test");
  return { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
}

function loaderOptions(location: RouteLocation): RouteLoaderOptions {
  return {
    signal: new AbortController().signal,
    shouldRun: () => true,
    revalidating: false,
    location,
    deps: `${location.pathname}\u0000${location.search}\u0000${location.hash}`,
    cause: "navigation",
  };
}

async function loadRemovedGeneral(url: string, basePath = "") {
  const location = locationFromUrl(url);
  const context = { basePath } as ApplicationContext;
  return await removedGeneralPage.loader?.(context, loaderOptions(location));
}

function targetPage(id: "appearance" | "model-providers") {
  return definePage({
    ...routePageSpec(id),
    component: async () => ({ header: true, render: () => null }),
  }) as PageDefinition<RouteId, ApplicationContext, RouteModule>;
}

describe("removed General route", () => {
  it.each([
    ["/settings/general", ""],
    ["/config?section=models#settings-general-language", ""],
    ["/ui/settings/general?section=env#config-section-env", "/ui"],
  ])("redirects %s to the Appearance language section", async (url, basePath) => {
    await expect(loadRemovedGeneral(url, basePath)).resolves.toEqual({
      type: "redirect",
      location: {
        pathname: `${basePath}/settings/appearance`,
        search: "?section=__appearance__",
        hash: "#settings-language",
      },
    });
  });

  it("keeps the former General model target on Models", async () => {
    await expect(loadRemovedGeneral("/settings/general#settings-general-model")).resolves.toEqual({
      type: "redirect",
      location: {
        pathname: "/settings/model-providers",
        search: "",
        hash: "#settings-model-behavior",
      },
    });
  });

  it.each([
    [
      "/settings/general?section=env#config-section-env",
      "/settings/appearance?section=__appearance__#settings-language",
    ],
    ["/config#settings-general-model", "/settings/model-providers#settings-model-behavior"],
  ])("performs at most one replace for %s and never oscillates", async (sourceUrl, targetUrl) => {
    let current = locationFromUrl(sourceUrl);
    const replace = vi.fn((next: RouteLocation) => {
      current = next;
    });
    const push = vi.fn((next: RouteLocation) => {
      current = next;
    });
    const history: RouterHistory = {
      location: () => current,
      push,
      replace,
      listen: () => () => undefined,
    };
    const router = createRouter<RouteId, ApplicationContext, RouteModule>({
      routes: [removedGeneralPage, targetPage("appearance"), targetPage("model-providers")],
    });
    const context = { basePath: "" } as ApplicationContext;

    try {
      await router.start(history, "", context);
      for (let cycle = 0; cycle < 3; cycle += 1) {
        await router.navigateLocation({ ...current }, context);
      }

      expect(replace).toHaveBeenCalledOnce();
      expect(push).not.toHaveBeenCalled();
      expect(current).toEqual(locationFromUrl(targetUrl));
      expect(router.getState().resolvedLocation).toEqual(locationFromUrl(targetUrl));
    } finally {
      router.stop();
    }
  });
});

describe("Updates route", () => {
  it("loads readable config without requesting the admin-only schema", async () => {
    const ensureLoaded = vi.fn(() => Promise.resolve());
    const ensureSchemaLoaded = vi.fn(() => Promise.resolve());
    const context = {
      runtimeConfig: { ensureLoaded, ensureSchemaLoaded },
    } as unknown as ApplicationContext;
    const location = locationFromUrl("/settings/updates");

    await updatesPage.loader?.(context, loaderOptions(location));
    await Promise.resolve();

    expect(ensureLoaded).toHaveBeenCalledOnce();
    expect(ensureSchemaLoaded).not.toHaveBeenCalled();
  });
});
