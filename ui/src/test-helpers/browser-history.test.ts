/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { installBrowserHistoryIsolation } from "./browser-history.ts";

describe.sequential("browser history isolation", () => {
  installBrowserHistoryIsolation();

  it("allows a test to replace both its route and history state", () => {
    window.history.replaceState({ isolated: true }, "", "/settings/general?tab=test#details");

    expect(window.history.state).toEqual({ isolated: true });
    expect(window.location.pathname).toBe("/settings/general");
  });

  it("restores both route and history state before the next test", () => {
    expect(window.history.state).not.toEqual({ isolated: true });
    expect(window.location.pathname).not.toBe("/settings/general");
    expect(window.location.search).not.toBe("?tab=test");
    expect(window.location.hash).not.toBe("#details");
  });
});
