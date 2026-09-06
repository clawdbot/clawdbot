import { createRouter, definePage, type RouteMatch, type Router } from "@openclaw/uirouter";
import { html, nothing, type LitElement } from "lit";
import { ref } from "lit/directives/ref.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import "./router-outlet.ts";

type RouteId = "page" | "next";
type TestContext = { label: string };
type TestData = { label: string };
type TestOwnerMatch = Pick<RouteMatch<string, unknown, TestData>, "data" | "location">;
type TestModule = {
  render: (data: TestData | undefined) => unknown;
  renderOwnerKey?: (
    match: TestOwnerMatch,
    settled: TestOwnerMatch | undefined,
  ) => string | undefined;
};
type TestRouter = Router<RouteId, TestContext, TestModule, TestData>;
type RouterOutletElement = LitElement & {
  router?: TestRouter;
  retryContext?: TestContext;
  onNotFound?: () => void;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createOutlet(router: TestRouter, context: TestContext): RouterOutletElement {
  const outlet = document.createElement("openclaw-router-outlet") as RouterOutletElement;
  outlet.router = router;
  outlet.retryContext = context;
  document.body.append(outlet);
  return outlet;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function settleOutlet(outlet: RouterOutletElement): Promise<void> {
  // The outlet resolves route work in promise chains that each schedule another render,
  // so drain to Lit's settled state rather than pumping a fixed number of cycles.
  await settleLitElement(outlet);
}

describe("openclaw-router-outlet", () => {
  it("retains MCP Apps across route IDs that share an explicit owner", async () => {
    const teardownView = vi.fn(async () => undefined);
    const nextData = deferred<TestData>();
    const renderOwnedRoute = vi.fn((data: TestData | undefined) =>
      data
        ? html`
            <mcp-app-view
              ${ref((element) => {
                if (element) {
                  Reflect.set(element, "restartAfterTeardown", vi.fn());
                  Reflect.set(element, "teardown", teardownView);
                }
              })}
            ></mcp-app-view>
            <div data-testid="owned-route">${data.label}</div>
          `
        : nothing,
    );
    const ownedModule: TestModule = {
      renderOwnerKey: () => "shared-owner",
      render: renderOwnedRoute,
    };
    const context = { label: "page" };
    const router = createRouter<RouteId, TestContext, TestModule, TestData>({
      routes: [
        definePage({
          id: "page",
          path: "/page",
          component: () => ownedModule,
          loader: () => ({ label: "page" }),
        }),
        definePage({
          id: "next",
          path: "/next",
          component: () => ownedModule,
          loader: () => nextData.promise,
        }),
      ],
    });
    const outlet = createOutlet(router, context);
    await router.navigate("page", context);
    await settleOutlet(outlet);
    const appView = outlet.querySelector("mcp-app-view");

    const navigation = router.navigate("next", context);
    await settleOutlet(outlet);
    expect(renderOwnedRoute).toHaveBeenCalledWith(undefined, true);
    expect(outlet.querySelector("mcp-app-view")).toBe(appView);
    expect(outlet.querySelector('[data-testid="owned-route"]')?.textContent).toBe("page");
    expect(teardownView).not.toHaveBeenCalled();

    nextData.resolve({ label: "next" });
    await navigation;
    await settleOutlet(outlet);

    expect(outlet.querySelector("mcp-app-view")).toBe(appView);
    expect(outlet.querySelector('[data-testid="owned-route"]')?.textContent).toBe("next");
    expect(teardownView).not.toHaveBeenCalled();
    outlet.remove();
    router.stop();
  });

  it("replaces the loading skeleton with the resolved route", async () => {
    vi.useFakeTimers();
    const routeModule = deferred<TestModule>();
    const context = { label: "loaded" };
    const router = createRouter<RouteId, TestContext, TestModule, TestData>({
      routes: [
        definePage({
          id: "page",
          path: "/page",
          component: () => routeModule.promise,
          loader: (loadContext) => ({ label: loadContext.label }),
        }),
      ],
    });
    const outlet = createOutlet(router, context);
    const navigation = router.navigate("page", context);

    await settleOutlet(outlet);
    expect(outlet.querySelector('[role="status"]')).toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    await settleOutlet(outlet);

    const loadingState = outlet.querySelector('[role="status"]');
    expect(loadingState?.getAttribute("aria-label")).toBe("Loading…");
    expect(loadingState?.querySelector(".loading-skeleton")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(loadingState?.getAttribute("aria-busy")).toBeNull();
    expect(loadingState?.textContent?.trim()).toBe("");
    expect(outlet.textContent).not.toContain("Loading panel");

    routeModule.resolve({
      render: (data) => html`<div data-testid="route-page">${data?.label}</div>`,
    });
    await navigation;
    await settleOutlet(outlet);

    expect(outlet.querySelector('[data-testid="route-page"]')?.textContent).toBe("loaded");
    expect(outlet.querySelector('[role="status"]')).toBeNull();
    expect(outlet.querySelector(".loading-skeleton")).toBeNull();
    outlet.remove();
    router.stop();
  });

  it("keeps the current route mounted until nested MCP Apps finish teardown", async () => {
    const teardown = deferred<void>();
    const teardownView = vi.fn(() => teardown.promise);
    const context = { label: "loaded" };
    const router = createRouter<RouteId, TestContext, TestModule, TestData>({
      routes: [
        definePage({
          id: "page",
          path: "/page",
          component: () => ({
            render: () => html`
              <mcp-app-view
                ${ref((element) => {
                  if (element) {
                    Reflect.set(element, "restartAfterTeardown", vi.fn());
                    Reflect.set(element, "teardown", teardownView);
                  }
                })}
              ></mcp-app-view>
              <div data-testid="route-page">page</div>
            `,
          }),
          loader: () => ({ label: "page" }),
        }),
        definePage({
          id: "next",
          path: "/next",
          component: () => ({
            render: () => html`<div data-testid="route-next">next</div>`,
          }),
          loader: () => ({ label: "next" }),
        }),
      ],
    });
    const outlet = createOutlet(router, context);
    await router.navigate("page", context);
    await settleOutlet(outlet);

    await router.navigate("next", context);
    await settleOutlet(outlet);
    expect(teardownView).toHaveBeenCalledOnce();
    expect(outlet.querySelector('[data-testid="route-page"]')).not.toBeNull();
    expect(outlet.querySelector('[data-testid="route-next"]')).toBeNull();

    teardown.resolve(undefined);
    await expect.poll(() => outlet.querySelector('[data-testid="route-next"]')).not.toBeNull();
    expect(outlet.querySelector("mcp-app-view")).toBeNull();
    outlet.remove();
    router.stop();
  });

  it("renders route data through the public custom-element boundary", async () => {
    const context = { label: "loaded" };
    const router = createRouter<RouteId, TestContext, TestModule, TestData>({
      routes: [
        definePage({
          id: "page",
          path: "/page",
          component: () => ({
            render: (data: TestData | undefined) =>
              html`<div data-testid="route-page">${data?.label}</div>`,
          }),
          loader: (loadContext) => ({ label: loadContext.label }),
        }),
      ],
    });
    const outlet = createOutlet(router, context);

    await router.navigate("page", context);
    await settleOutlet(outlet);

    expect(outlet.querySelector('[data-testid="route-page"]')?.textContent).toBe("loaded");
    outlet.remove();
    router.stop();
  });

  it("keeps a loaded route visible with an error and retries through the latest context", async () => {
    const firstLoad = deferred<TestData>();
    let loadCount = 0;
    const router = createRouter<RouteId, TestContext, TestModule, TestData>({
      routes: [
        definePage({
          id: "page",
          path: "/page",
          component: () => ({
            render: (data: TestData | undefined) =>
              html`<div data-testid="route-page">${data?.label ?? "pending"}</div>`,
          }),
          loader: (context) => {
            loadCount += 1;
            return loadCount === 1 ? firstLoad.promise : { label: context.label };
          },
        }),
      ],
    });
    const initialContext = { label: "initial" };
    const retryContext = { label: "retried" };
    const outlet = createOutlet(router, initialContext);
    const navigation = router.navigate("page", initialContext);
    await settleOutlet(outlet);
    firstLoad.reject(new Error("load failed"));
    await expect(navigation).rejects.toThrow("load failed");
    await settleOutlet(outlet);

    expect(outlet.querySelector('[data-testid="route-page"]')?.textContent).toBe("pending");
    expect(outlet.querySelector('[role="alert"]')?.textContent).toContain("load failed");

    outlet.retryContext = retryContext;
    await outlet.updateComplete;
    outlet.querySelector<HTMLButtonElement>("button")?.click();
    await settleOutlet(outlet);

    expect(loadCount).toBe(2);
    expect(outlet.querySelector('[data-testid="route-page"]')?.textContent).toBe("retried");
    expect(outlet.querySelector('[role="alert"]')).toBeNull();
    outlet.remove();
    router.stop();
  });

  it("waits out a restarting gateway before falling back to revalidation", async () => {
    vi.useFakeTimers();
    let loadCount = 0;
    const fetchMock = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("document probe aborted")), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const router = createRouter<RouteId, TestContext, TestModule, TestData>({
      routes: [
        definePage({
          id: "page",
          path: "/page",
          component: () => Promise.reject(new Error("Importing a module script failed.")),
          loader: (context) => {
            loadCount += 1;
            return { label: context.label };
          },
        }),
      ],
    });
    const context = { label: "stale" };
    const outlet = createOutlet(router, context);

    await expect(router.navigate("page", context)).rejects.toThrow(
      "Importing a module script failed.",
    );
    await settleOutlet(outlet);

    const alert = outlet.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Importing a module script failed.");
    expect(alert?.textContent).toContain("Reload to get the latest panel");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loadCount).toBe(1);
    const button = outlet.querySelector<HTMLButtonElement>("button");
    button?.click();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The gateway restart is what stranded the chunk, so one failed probe must
    // not end the retry: the click keeps waiting (and shows it) rather than
    // silently degrading to a revalidation that cannot fix a replaced chunk.
    await vi.advanceTimersByTimeAsync(3_000);
    vi.runAllTicks();
    await settleOutlet(outlet);
    expect(loadCount).toBe(1);
    expect(button?.disabled).toBe(true);

    // Past the bounded wait it still degrades to revalidation instead of
    // navigating into a fatal error page against an unreachable gateway.
    await vi.advanceTimersByTimeAsync(35_000);
    vi.runAllTicks();
    await settleOutlet(outlet);
    expect(loadCount).toBe(2);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    outlet.remove();
    router.stop();
  });
});
