import { createRouter, definePage, type Router } from "@openclaw/uirouter";
import { html, type LitElement } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { retryStaleChunkReload, scheduleStaleChunkReload } from "./stale-chunk-reload.ts";
import "./router-outlet.ts";

vi.mock("./stale-chunk-reload.ts", async (importActual) => {
  const actual = await importActual<typeof import("./stale-chunk-reload.ts")>();
  return {
    ...actual,
    retryStaleChunkReload: vi.fn(async () => true),
    scheduleStaleChunkReload: vi.fn(async () => false),
  };
});

type RouteId = "page";
type TestContext = { label: string };
type TestData = { label: string };
type TestModule = { render: (data: TestData | undefined) => unknown };
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

async function settleOutlet(outlet: RouterOutletElement): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await Promise.resolve();
    await outlet.updateComplete;
  }
}

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("openclaw-router-outlet", () => {
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

  it("recovers stale-chunk import failures with a document reload instead of revalidate", async () => {
    let loadCount = 0;
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
    expect(alert?.textContent).toContain("Reload the page");
    expect(vi.mocked(scheduleStaleChunkReload)).toHaveBeenCalled();

    outlet.querySelector<HTMLButtonElement>("button")?.click();
    await settleOutlet(outlet);

    expect(vi.mocked(retryStaleChunkReload)).toHaveBeenCalledTimes(1);
    expect(loadCount).toBe(1);
    outlet.remove();
    router.stop();
  });
});
