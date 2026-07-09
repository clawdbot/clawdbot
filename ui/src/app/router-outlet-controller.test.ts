import { createRouter, definePage, type RouteLocation } from "@openclaw/uirouter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterOutletController, selectRenderedRouteMatch } from "./router-outlet-controller.ts";

type RouteId = "first" | "second";
type TestContext = { label: string };
type TestModule = { render: (data: TestData | undefined) => unknown };
type TestData = { label: string };

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

function location(pathname: string): RouteLocation {
  return { pathname, search: "", hash: "" };
}

function module(label: string): TestModule {
  return { render: () => label };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RouterOutletController pending presentation", () => {
  it("delays a cold-start fallback until the route has been pending for one second", async () => {
    vi.useFakeTimers();
    const routeModule = deferred<TestModule>();
    const routeData = deferred<TestData>();
    const router = createRouter<RouteId, TestContext, TestModule, TestData>({
      routes: [
        definePage({
          id: "first",
          path: "/first",
          component: () => routeModule.promise,
          loader: () => routeData.promise,
        }),
      ],
    });
    const controller = new RouterOutletController<RouteId, TestContext, TestModule, TestData>(
      vi.fn(),
    );
    controller.setInputs({ router });
    controller.connect();

    const navigation = router.navigate("first", { label: "test" });
    expect(controller.snapshot.pending?.routeId).toBe("first");
    expect(controller.snapshot.showPending).toBe(false);

    await vi.advanceTimersByTimeAsync(999);
    expect(controller.snapshot.showPending).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.snapshot.showPending).toBe(true);

    routeModule.resolve(module("first"));
    routeData.resolve({ label: "loaded" });
    await navigation;
    expect(controller.snapshot.showPending).toBe(false);
    controller.disconnect();
    router.stop();
  });

  it("keeps active content while the next route module is cold", async () => {
    vi.useFakeTimers();
    const secondModule = deferred<TestModule>();
    const secondData = deferred<TestData>();
    const router = createRouter<RouteId, TestContext, TestModule, TestData>({
      routes: [
        definePage({
          id: "first",
          path: "/first",
          component: () => module("first"),
          loader: () => ({ label: "first" }),
        }),
        definePage({
          id: "second",
          path: "/second",
          component: () => secondModule.promise,
          loader: () => secondData.promise,
        }),
      ],
    });
    const controller = new RouterOutletController<RouteId, TestContext, TestModule, TestData>(
      vi.fn(),
    );
    controller.setInputs({ router });
    controller.connect();
    await router.navigate("first", { label: "test" });

    const navigation = router.navigate("second", { label: "test" });
    expect(
      selectRenderedRouteMatch(controller.snapshot.active, controller.snapshot.pending)?.routeId,
    ).toBe("first");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(controller.snapshot.showPending).toBe(false);

    secondModule.resolve(module("second"));
    await flushPromises();
    expect(
      selectRenderedRouteMatch(controller.snapshot.active, controller.snapshot.pending)?.routeId,
    ).toBe("second");
    expect(controller.snapshot.active?.data).toBeUndefined();

    secondData.resolve({ label: "second" });
    await navigation;
    controller.disconnect();
    router.stop();
  });

  it("restarts a canceled pending delay after reconnect", async () => {
    vi.useFakeTimers();
    const routeModule = deferred<TestModule>();
    const routeData = deferred<TestData>();
    const router = createRouter<RouteId, TestContext, TestModule, TestData>({
      routes: [
        definePage({
          id: "first",
          path: "/first",
          component: () => routeModule.promise,
          loader: () => routeData.promise,
        }),
      ],
    });
    const controller = new RouterOutletController<RouteId, TestContext, TestModule, TestData>(
      vi.fn(),
    );
    controller.setInputs({ router });
    controller.connect();
    const navigation = router.navigate("first", { label: "test" });

    await vi.advanceTimersByTimeAsync(500);
    controller.disconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.snapshot.showPending).toBe(false);

    controller.connect();
    await vi.advanceTimersByTimeAsync(999);
    expect(controller.snapshot.showPending).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.snapshot.showPending).toBe(true);

    routeModule.resolve(module("first"));
    routeData.resolve({ label: "loaded" });
    await navigation;
    controller.disconnect();
    router.stop();
  });
});

describe("RouterOutletController not-found boundary", () => {
  function createTestRouter() {
    return createRouter<RouteId, TestContext, TestModule, TestData>({
      routes: [
        definePage({
          id: "first",
          path: "/first",
          component: () => module("first"),
          loader: () => ({ label: "first" }),
        }),
      ],
    });
  }

  it("notifies once for an unmatched location", async () => {
    const router = createTestRouter();
    const onNotFound = vi.fn();
    const controller = new RouterOutletController<RouteId, TestContext, TestModule, TestData>(
      vi.fn(),
    );
    controller.setInputs({ router, onNotFound });
    controller.connect();

    await router.navigateLocation(location("/missing"), { label: "test" });
    await flushPromises();
    expect(onNotFound).toHaveBeenCalledTimes(1);

    controller.setInputs({ router, onNotFound });
    await flushPromises();
    expect(onNotFound).toHaveBeenCalledTimes(1);
    controller.disconnect();
    router.stop();
  });

  it("suppresses a queued fallback after the router recovers", async () => {
    const router = createTestRouter();
    const onNotFound = vi.fn();
    const controller = new RouterOutletController<RouteId, TestContext, TestModule, TestData>(
      vi.fn(),
    );
    controller.setInputs({ router, onNotFound });
    controller.connect();

    const missing = router.navigateLocation(location("/missing"), { label: "test" });
    const recovery = router.navigate("first", { label: "test" });
    await Promise.all([missing, recovery]);
    await flushPromises();
    expect(onNotFound).not.toHaveBeenCalled();
    controller.disconnect();
    router.stop();
  });

  it("cancels the queued fallback on disconnect and re-evaluates it on reconnect", async () => {
    const router = createTestRouter();
    const onNotFound = vi.fn();
    const controller = new RouterOutletController<RouteId, TestContext, TestModule, TestData>(
      vi.fn(),
    );
    controller.setInputs({ router, onNotFound });
    controller.connect();

    const missing = router.navigateLocation(location("/missing"), { label: "test" });
    controller.disconnect();
    await missing;
    await flushPromises();
    expect(onNotFound).not.toHaveBeenCalled();

    controller.connect();
    await flushPromises();
    expect(onNotFound).toHaveBeenCalledTimes(1);
    controller.disconnect();
    router.stop();
  });
});
