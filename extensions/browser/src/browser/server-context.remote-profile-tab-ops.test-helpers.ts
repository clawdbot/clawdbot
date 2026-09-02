import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
/**
 * Lazy-loaded dependency bundle for remote-profile tab operation tests.
 */
import { afterEach, beforeEach, vi } from "vitest";

/** Modules and helpers shared by remote-profile tab operation tests. */
export type RemoteProfileTestDeps = {
  cdpModule: typeof import("./cdp.js");
  chromeModule: typeof import("./chrome.js");
  BrowserCdpEndpointBlockedError: typeof import("./errors.js").BrowserCdpEndpointBlockedError;
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

/** Loads remote-profile tab operation dependencies after Chrome mocks are installed. */
const loadRemoteProfileTestDepsOnce = createLazyRuntimeModule(() =>
  (async () => {
    await import("./server-context.chrome-test-harness.js");
    const cdpModule = await import("./cdp.js");
    const chromeModule = await import("./chrome.js");
    const { BrowserCdpEndpointBlockedError } = await import("./errors.js");
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
      cdpModule,
      chromeModule,
      BrowserCdpEndpointBlockedError,
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
  })(),
);

export const loadRemoteProfileTestDeps = loadRemoteProfileTestDepsOnce;

/** Installs per-test mock reset and Playwright connection cleanup. */
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
