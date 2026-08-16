/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import { renderDashboards, type DashboardsRouteData } from "./view.ts";

function routeData(sessions: SessionsListResult["sessions"]): DashboardsRouteData {
  return {
    result: {
      ts: 1,
      path: "(multiple)",
      count: sessions.length,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions,
    },
    error: null,
    basePath: "",
    fallbackAgentId: "main",
    mainKey: "main",
  };
}

describe("dashboards index", () => {
  it("links each row through the dashboard session namespace", () => {
    const container = document.createElement("div");
    render(
      renderDashboards(
        routeData([
          {
            key: "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef",
            kind: "direct",
            boardFace: "dashboard",
            displayName: "Deploy monitor",
            updatedAt: 2,
          },
        ]),
      ),
      container,
    );

    const row = container.querySelector<HTMLAnchorElement>("[data-dashboard-session]");
    expect(row?.textContent).toContain("Deploy monitor");
    expect(row?.getAttribute("href")).toBe("/dashboard/main/deploy-monitor-12345678");
  });

  it("explains how to create a dashboard when the list is empty", () => {
    const container = document.createElement("div");
    render(renderDashboards(routeData([])), container);

    const empty = container.querySelector("[data-dashboards-empty]");
    expect(empty?.textContent).toContain("No dashboards yet");
    expect(empty?.textContent).toContain("Open a session and switch to the Dashboard face");
  });
});
