/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  beginPanelRefresh,
  completePanelRefresh,
  createPanelRefreshStatus,
  failPanelRefresh,
  renderPanelRefreshStatus,
} from "./panel-refresh-status.ts";

describe("panel refresh status", () => {
  it("marks previously loaded data stale until a retry succeeds", () => {
    const ready = completePanelRefresh();
    const failed = failPanelRefresh(ready, "request failed");

    expect(failed).toEqual({ error: "request failed", hasLoaded: true, stale: true });
    expect(beginPanelRefresh(failed)).toEqual({ error: null, hasLoaded: true, stale: true });
    expect(completePanelRefresh()).toEqual({ error: null, hasLoaded: true, stale: false });
  });

  it("renders a local retry action and stale-data marker", () => {
    const onRetry = vi.fn();
    const container = document.createElement("div");
    const status = failPanelRefresh(completePanelRefresh(), "request failed");

    render(renderPanelRefreshStatus({ status, onRetry }), container);

    expect(container.textContent).toContain("request failed");
    expect(container.textContent).toContain("Showing stale data");
    container.querySelector<HTMLButtonElement>("button")?.click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("does not mark a first-load failure stale", () => {
    expect(failPanelRefresh(createPanelRefreshStatus(), "request failed")).toEqual({
      error: "request failed",
      hasLoaded: false,
      stale: false,
    });
  });
});
