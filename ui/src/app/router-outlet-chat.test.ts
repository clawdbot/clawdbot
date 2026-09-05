import {
  createRouter,
  definePage,
  type RouteLocation,
  type RouteMatch,
  type Router,
} from "@openclaw/uirouter";
import { html, nothing, type LitElement } from "lit";
import { ref } from "lit/directives/ref.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_COMPOSER_FOCUS_PARAM,
  SESSION_NAVIGATION_KEY_PARAM,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import type { ChatRouteData } from "../pages/chat/route-loader.ts";
import { pages as chatPages } from "../pages/chat/route.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import "./router-outlet.ts";

type RouteId = "chat" | "dashboard";
type TestContext = Record<string, never>;
type OwnerMatch = Pick<RouteMatch<string, unknown, ChatRouteData>, "data" | "location">;
type TestModule = {
  render: (data: ChatRouteData | undefined) => unknown;
  renderOwnerKey?: (match: OwnerMatch, settled: OwnerMatch | undefined) => string | undefined;
};
type TestRouter = Router<RouteId, TestContext, TestModule, ChatRouteData>;
type RouterOutletElement = LitElement & { router?: TestRouter };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function location(pathname: string, search = ""): RouteLocation {
  return { pathname, search, hash: "" };
}

function sessionData(sessionKey: string, face: "chat" | "dashboard"): ChatRouteData {
  return { kind: "session", sessionKey, agentId: "main", face, shortId: "12345678" };
}

function createOutlet(router: TestRouter): RouterOutletElement {
  const outlet = document.createElement("openclaw-router-outlet") as RouterOutletElement;
  outlet.router = router;
  document.body.append(outlet);
  return outlet;
}

async function settleOutlet(outlet: RouterOutletElement): Promise<void> {
  await settleLitElement(outlet);
}

function ownedRenderer(teardown: () => Promise<void>) {
  return (data: ChatRouteData | undefined) =>
    data
      ? html`
          <mcp-app-view
            ${ref((element) => {
              if (element) {
                Reflect.set(element, "restartAfterTeardown", vi.fn());
                Reflect.set(element, "teardown", teardown);
              }
            })}
          ></mcp-app-view>
          <div data-testid="route-value">${data.kind === "session" ? data.face : "chooser"}</div>
        `
      : nothing;
}

async function routeModule(
  face: "chat" | "dashboard",
  render: TestModule["render"],
): Promise<TestModule> {
  const declared = await chatPages[face === "chat" ? 0 : 1].component();
  return { renderOwnerKey: declared.renderOwnerKey, render };
}

afterEach(() => {
  Reflect.deleteProperty(window, "__OPENCLAW_CONTROL_UI_BASE_PATH__");
  document.body.replaceChildren();
});

describe("openclaw-router-outlet chat ownership", () => {
  it("retains the exact subtree across session and presentation switches", async () => {
    const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
    const nextSessionKey = "agent:main:dashboard:abcdef12-3456-7890-abcd-ef1234567890";
    const row = { key: sessionKey, displayName: "Retained board" };
    const chatTarget = sessionNavigationTarget({
      face: "chat",
      sessionKey,
      fallbackAgentId: "main",
      row,
    });
    const dashboardTarget = sessionNavigationTarget({
      face: "dashboard",
      sessionKey: nextSessionKey,
      fallbackAgentId: "main",
      row: { key: nextSessionKey, displayName: "Next retained board" },
    });
    const nextData = deferred<ChatRouteData>();
    const teardown = vi.fn(async () => undefined);
    const render = ownedRenderer(teardown);
    const chatModule = await routeModule("chat", render);
    const dashboardModule = await routeModule("dashboard", render);
    const router = createRouter<RouteId, TestContext, TestModule, ChatRouteData>({
      routes: [
        definePage({
          id: "chat",
          path: "/chat",
          component: () => chatModule,
          loader: () => sessionData(sessionKey, "chat"),
        }),
        definePage({
          id: "dashboard",
          path: "/dashboard",
          component: () => dashboardModule,
          loader: () => nextData.promise,
        }),
      ],
    });
    const outlet = createOutlet(router);
    await router.navigate("chat", {}, undefined, location(chatTarget.href));
    await settleOutlet(outlet);
    const appView = outlet.querySelector("mcp-app-view");

    const navigation = router.navigate(
      "dashboard",
      {},
      undefined,
      location(dashboardTarget.options.pathname, dashboardTarget.options.search),
    );
    await settleOutlet(outlet);
    expect(outlet.querySelector("mcp-app-view")).toBe(appView);
    expect(outlet.querySelector('[data-testid="route-value"]')?.textContent).toBe("chat");
    expect(teardown).not.toHaveBeenCalled();

    nextData.resolve(sessionData(nextSessionKey, "dashboard"));
    await navigation;
    await settleOutlet(outlet);
    expect(outlet.querySelector("mcp-app-view")).toBe(appView);
    expect(outlet.querySelector('[data-testid="route-value"]')?.textContent).toBe("dashboard");
    expect(teardown).not.toHaveBeenCalled();
    router.stop();
  });

  it("retains a full-key-hinted route while it cleans up to its recorded canonical location", async () => {
    const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
    const clean = location("/chat/main/deploy-monitor-12345678");
    const hintedSearch = new URLSearchParams({
      [SESSION_NAVIGATION_KEY_PARAM]: sessionKey,
      draft: "ship it",
      [SESSION_COMPOSER_FOCUS_PARAM]: "1",
    });
    const hinted = location("/chat/main/wrong-name-12345678", `?${hintedSearch.toString()}`);
    const canonical = location(
      clean.pathname,
      `?${new URLSearchParams({ draft: "ship it", [SESSION_COMPOSER_FOCUS_PARAM]: "1" })}`,
    );
    const initial = { ...sessionData(sessionKey, "chat"), canonicalLocation: canonical };
    const nextData = deferred<ChatRouteData>();
    let loadCount = 0;
    const teardown = vi.fn(async () => undefined);
    const module = await routeModule("chat", ownedRenderer(teardown));
    const router = createRouter<RouteId, TestContext, TestModule, ChatRouteData>({
      routes: [
        definePage({
          id: "chat",
          path: "/chat",
          component: () => module,
          loaderDeps: (_context, routeLocation) =>
            `${routeLocation.pathname}${routeLocation.search}`,
          loader: () => (++loadCount === 1 ? initial : nextData.promise),
        }),
      ],
    });
    const outlet = createOutlet(router);
    await router.navigate("chat", {}, undefined, hinted);
    await settleOutlet(outlet);
    const appView = outlet.querySelector("mcp-app-view");

    const navigation = router.navigate("chat", {}, undefined, clean);
    await settleOutlet(outlet);
    expect(outlet.querySelector("mcp-app-view")).toBe(appView);
    expect(teardown).not.toHaveBeenCalled();

    nextData.resolve(sessionData(sessionKey, "chat"));
    await navigation;
    await settleOutlet(outlet);
    expect(outlet.querySelector("mcp-app-view")).toBe(appView);
    expect(teardown).not.toHaveBeenCalled();
    router.stop();
  });

  it("retains the chat page when a colliding short path's full-key hint changes", async () => {
    const firstKey = "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001";
    const secondKey = "agent:main:dashboard:12345678-0bbb-4000-8000-000000000002";
    const pathname = "/chat/main/deploy-monitor-12345678";
    const nextData = deferred<ChatRouteData>();
    let loadCount = 0;
    const teardown = vi.fn(async () => undefined);
    const module = await routeModule("chat", ownedRenderer(teardown));
    const router = createRouter<RouteId, TestContext, TestModule, ChatRouteData>({
      routes: [
        definePage({
          id: "chat",
          path: "/chat",
          component: () => module,
          loaderDeps: (_context, routeLocation) => routeLocation.search,
          loader: () => (++loadCount === 1 ? sessionData(firstKey, "chat") : nextData.promise),
        }),
      ],
    });
    const outlet = createOutlet(router);
    await router.navigate(
      "chat",
      {},
      undefined,
      location(pathname, `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(firstKey)}`),
    );
    await settleOutlet(outlet);
    const firstView = outlet.querySelector("mcp-app-view");

    const navigation = router.navigate(
      "chat",
      {},
      undefined,
      location(pathname, `?${SESSION_NAVIGATION_KEY_PARAM}=${encodeURIComponent(secondKey)}`),
    );
    await settleOutlet(outlet);
    expect(outlet.querySelector("mcp-app-view")).toBe(firstView);
    expect(teardown).not.toHaveBeenCalled();

    nextData.resolve(sessionData(secondKey, "chat"));
    await navigation;
    await settleOutlet(outlet);
    expect(outlet.querySelector("mcp-app-view")).toBe(firstView);
    expect(teardown).not.toHaveBeenCalled();
    router.stop();
  });

  it.each([
    {
      label: "an ambiguous result",
      result: {
        kind: "ambiguous",
        shortId: "12345678",
        candidates: [],
        truncated: false,
        face: "chat",
      } satisfies ChatRouteData,
    },
    {
      label: "a missing-session result",
      result: {
        kind: "missing-session",
        face: "chat",
        currentSessionHref: "/chat/main",
        sessionsHref: "/sessions",
      } satisfies ChatRouteData,
    },
  ])("retains an unresolved route until $label replaces it", async ({ result }) => {
    const sessionKey = "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001";
    const nextData = deferred<ChatRouteData>();
    let loadCount = 0;
    const teardown = vi.fn(async () => undefined);
    const module = await routeModule("chat", ownedRenderer(teardown));
    const router = createRouter<RouteId, TestContext, TestModule, ChatRouteData>({
      routes: [
        definePage({
          id: "chat",
          path: "/chat",
          component: () => module,
          loaderDeps: (_context, routeLocation) => routeLocation.pathname,
          loader: () => (++loadCount === 1 ? sessionData(sessionKey, "chat") : nextData.promise),
        }),
      ],
    });
    const outlet = createOutlet(router);
    await router.navigate("chat", {}, undefined, location("/chat/main/alpha-12345678"));
    await settleOutlet(outlet);
    const firstView = outlet.querySelector("mcp-app-view");

    const navigation = router.navigate("chat", {}, undefined, location("/chat/main/beta-12345678"));
    await settleOutlet(outlet);
    expect(outlet.querySelector("mcp-app-view")).toBe(firstView);
    expect(teardown).not.toHaveBeenCalled();

    nextData.resolve(result);
    await navigation;
    await settleOutlet(outlet);
    expect(outlet.querySelector('[data-testid="route-value"]')?.textContent).toBe("chooser");
    expect(teardown).toHaveBeenCalledOnce();
    router.stop();
  });
});
