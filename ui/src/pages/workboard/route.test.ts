import type { RouteLocation, RouterHistory } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createApplicationRouter, startApplicationRouter, type RouteId } from "../../app-routes.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../../app/context.ts";
import { resolveWorkboardRouteLocation } from "./route-location.ts";

function routeFixture(
  initialLocation: RouteLocation = { pathname: "/ui/settings/about", search: "", hash: "" },
) {
  const basePath = "/ui";
  let location = initialLocation;
  let historyListener: ((location: RouteLocation) => void) | undefined;
  const history: RouterHistory = {
    location: () => location,
    push: (next) => {
      location = next;
    },
    replace: (next) => {
      location = next;
    },
    listen: (listener) => {
      historyListener = listener;
      return () => {
        historyListener = undefined;
      };
    },
  };
  const router = createApplicationRouter();
  const loading = createDeferred();
  const component = createDeferred<{ render: () => null }>();
  router.getRoute("about")!.component = async () => ({ render: () => null });
  router.getRoute("workboard")!.component = () => {
    loading.resolve();
    return component.promise;
  };
  const metadata = createDeferred();
  const redirects: Promise<void>[] = [];
  const context = {
    basePath,
    runtimeConfig: {
      ensureLoaded: () => metadata.promise,
    },
    agents: { ensureList: async () => null },
    sessions: { state: { result: {}, loading: false } },
    replace: (routeId: RouteId, options?: ApplicationNavigationOptions) => {
      redirects.push(
        router.navigate(
          routeId,
          context,
          { history: "replace" },
          {
            pathname: router.pathForRoute(routeId, basePath),
            search: "",
            hash: "",
            ...options,
          },
        ),
      );
    },
  } as unknown as ApplicationContext;
  const started = startApplicationRouter(router, history, basePath, context);
  return {
    router,
    history,
    context,
    loading,
    redirects,
    started,
    resolve() {
      metadata.resolve();
      component.resolve({ render: () => null });
    },
    pop(next: RouteLocation) {
      location = next;
      historyListener?.(next);
    },
  };
}

const legacyBoardLocation: RouteLocation = {
  pathname: "/ui/workboard",
  search: "?board=ops&agent=writer",
  hash: "#original",
};

describe("Workboard route navigation ownership", () => {
  it("canonicalizes the active legacy URL while preserving its query and hash", async () => {
    const fixture = routeFixture();
    await fixture.started;
    try {
      const navigation = fixture.router.navigate(
        "workboard",
        fixture.context,
        { history: "push" },
        legacyBoardLocation,
      );
      await fixture.loading.promise;
      fixture.resolve();
      await navigation;
      await Promise.all(fixture.redirects);
      expect(fixture.history.location()).toEqual({
        pathname: "/ui/workboard/ops",
        search: "?agent=writer",
        hash: "#original",
      });
      expect(fixture.router.getState().matches[0]?.data).toMatchObject({ boardFilter: "ops" });
    } finally {
      fixture.router.stop();
    }
  });

  it.each([
    {
      name: "another page",
      routeId: "about",
      location: { pathname: "/ui/settings/about", search: "?view=licenses", hash: "#latest" },
    },
    {
      name: "a newer hash on the same board",
      routeId: "workboard",
      location: { pathname: "/ui/workboard/ops", search: "?agent=writer", hash: "#latest" },
    },
    {
      name: "a newer query on the same board",
      routeId: "workboard",
      location: { pathname: "/ui/workboard/ops", search: "?agent=reviewer", hash: "#latest" },
    },
  ] as const)("keeps $name when old route loading finishes", async ({ routeId, location }) => {
    const fixture = routeFixture();
    await fixture.started;
    try {
      const oldNavigation = fixture.router.navigate(
        "workboard",
        fixture.context,
        { history: "push" },
        legacyBoardLocation,
      );
      await fixture.loading.promise;
      const newNavigation = fixture.router.navigate(
        routeId,
        fixture.context,
        { history: "push" },
        location,
      );
      fixture.resolve();
      await Promise.all([oldNavigation, newNavigation]);
      await Promise.all(fixture.redirects);
      expect(fixture.history.location()).toEqual(location);
      expect(fixture.router.getState().location).toEqual(location);
      expect(fixture.router.getState().matches[0]?.routeId).toBe(routeId);
    } finally {
      fixture.router.stop();
    }
  });

  it("preloads without navigation and canonicalizes the later visit to the cached board", async () => {
    const fixture = routeFixture();
    await fixture.started;
    const activeLocation = fixture.history.location();
    try {
      const preload = fixture.router.preloadLocation(legacyBoardLocation, fixture.context);
      await fixture.loading.promise;
      fixture.resolve();
      await preload;
      await Promise.all(fixture.redirects);
      expect(fixture.history.location()).toEqual(activeLocation);
      expect(fixture.router.getState().location).toEqual(activeLocation);
      expect(fixture.router.getState().matches[0]?.routeId).toBe("about");
      await fixture.router.navigate(
        "workboard",
        fixture.context,
        { history: "push" },
        legacyBoardLocation,
      );
      await Promise.all(fixture.redirects);
      expect(fixture.history.location()).toEqual({
        pathname: "/ui/workboard/ops",
        search: "?agent=writer",
        hash: "#original",
      });
    } finally {
      fixture.router.stop();
    }
  });

  it.each(["startup", "history"] as const)(
    "canonicalizes a %s alias before asynchronous route loading",
    async (entry) => {
      const fixture = routeFixture(entry === "startup" ? legacyBoardLocation : undefined);
      try {
        if (entry === "history") {
          await fixture.started;
          fixture.pop(legacyBoardLocation);
        }
        await fixture.loading.promise;
        const canonicalLocation = {
          pathname: "/ui/workboard/ops",
          search: "?agent=writer",
          hash: "#original",
        };
        expect.soft(fixture.history.location()).toEqual(canonicalLocation);
        fixture.resolve();
        await fixture.started;
        await Promise.all(fixture.redirects);
        await vi.waitFor(() => {
          expect(fixture.router.getState().status).toBe("success");
          expect(fixture.router.getState().location).toEqual(canonicalLocation);
        });
        expect(fixture.router.getState().matches[0]?.data).toMatchObject({ boardFilter: "ops" });
      } finally {
        fixture.router.stop();
      }
    },
  );
});

describe("Workboard route location", () => {
  it("reads the canonical board path without rewriting it", () => {
    expect(
      resolveWorkboardRouteLocation({
        pathname: "/workboard/ops",
        search: "?agent=main",
        hash: "#ready",
      }),
    ).toEqual({ boardFilter: "ops", search: "?agent=main" });
  });

  it("redirects the shipped query alias to the canonical path", () => {
    expect(
      resolveWorkboardRouteLocation({
        pathname: "/workboard",
        search: "?agent=main&board=ops",
        hash: "#ready",
      }),
    ).toEqual({
      boardFilter: "ops",
      search: "?agent=main",
      canonicalLocation: {
        pathname: "/workboard/ops",
        search: "?agent=main",
        hash: "#ready",
      },
    });
  });

  it("drops a redundant legacy query from an already-canonical board path", () => {
    expect(
      resolveWorkboardRouteLocation({
        pathname: "/workboard/ops",
        search: "?board=other&agent=main",
        hash: "",
      }),
    ).toEqual({
      boardFilter: "ops",
      search: "?agent=main",
      canonicalLocation: {
        pathname: "/workboard/ops",
        search: "?agent=main",
        hash: "",
      },
    });
  });

  it("normalizes an invalid legacy board to the all-boards route", () => {
    expect(
      resolveWorkboardRouteLocation(
        {
          pathname: "/ui/workboard",
          search: "?board=not%20valid&agent=main",
          hash: "",
        },
        "/ui",
      ),
    ).toEqual({
      boardFilter: "__all__",
      search: "?agent=main",
      canonicalLocation: {
        pathname: "/ui/workboard",
        search: "?agent=main",
        hash: "",
      },
    });
  });
});
