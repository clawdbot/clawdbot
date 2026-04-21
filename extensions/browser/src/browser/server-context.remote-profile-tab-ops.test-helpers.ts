import { afterEach, beforeEach, vi } from "vitest";

export type RemoteProfileTestDeps = {
  chromeModule: typeof import("./chrome.js");
  InvalidBrowserNavigationUrlError: typeof import("./navigation-guard.js").InvalidBrowserNavigationUrlError;
  pwAiModule: typeof import("./pw-ai-module.js");
  closePlaywrightBrowserConnection: typeof import("./pw-session.js").closePlaywrightBrowserConnection;
  createBrowserRouteContext: typeof import("./server-context.js").createBrowserRouteContext;
  createJsonListFetchMock: typeof import("./server-context.remote-tab-ops.harness.js").createJsonListFetchMock;
  createRemoteRouteHarness: typeof import("./server-context.remote-tab-ops.harness.js").createRemoteRouteHarness;
  createSequentialPageLister: typeof import("./server-context.remote-tab-ops.harness.js").createSequentialPageLister;
  makeState: typeof import("./server-context.remote-tab-ops.harness.js").makeState;
  originalFetch: typeof import("./server-context.remote-tab-ops.harness.js").originalFetch;
};

let remoteProfileTestDepsPromise: Promise<RemoteProfileTestDeps> | undefined;

export async function loadRemoteProfileTestDeps(): Promise<RemoteProfileTestDeps> {
  remoteProfileTestDepsPromise ??= (async () => {
    await import("./server-context.chrome-test-harness.js");
    const chromeModule = await import("./chrome.js");
    const { InvalidBrowserNavigationUrlError } = await import("./navigation-guard.js");
    const pwAiModule = await import("./pw-ai-module.js");
    const { closePlaywrightBrowserConnection } = await import("./pw-session.js");
    const { createBrowserRouteContext } = await import("./server-context.js");
    const {
      createJsonListFetchMock,
      createRemoteRouteHarness,
      createSequentialPageLister,
      makeState,
      originalFetch,
    } = await import("./server-context.remote-tab-ops.harness.js");
    return {
      chromeModule,
      InvalidBrowserNavigationUrlError,
      pwAiModule,
      closePlaywrightBrowserConnection,
      createBrowserRouteContext,
      createJsonListFetchMock,
      createRemoteRouteHarness,
      createSequentialPageLister,
      makeState,
      originalFetch,
    };
  })();
  return await remoteProfileTestDepsPromise;
}

export function installRemoteProfileTestLifecycle(deps: RemoteProfileTestDeps): void {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = deps.originalFetch;
  });

  afterEach(async () => {
    await deps.closePlaywrightBrowserConnection().catch(() => {});
    globalThis.fetch = deps.originalFetch;
    vi.restoreAllMocks();
  });
}
