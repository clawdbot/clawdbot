import { afterEach, beforeEach } from "vitest";

/** Keep route and history state local to UI suites sharing one browser environment. */
export function installBrowserHistoryIsolation(): void {
  let previousLocation: { state: unknown; url: string };

  beforeEach(() => {
    previousLocation = {
      state: window.history.state,
      url: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    };
  });

  afterEach(() => {
    window.history.replaceState(previousLocation.state, "", previousLocation.url);
  });
}
