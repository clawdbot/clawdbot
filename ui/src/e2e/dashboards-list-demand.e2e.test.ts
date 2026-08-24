// Control UI E2E proves dashboard tabs do not multiply server-owned session-list demand.
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  installMockGateway,
  waitForControlUiRoute,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI dashboard session-list demand",
});

const DASHBOARD_REQUEST_PARAMS = {
  archived: "all",
  boardFace: "dashboard",
  configuredAgentsOnly: true,
  includeGlobal: true,
  includeUnknown: true,
  limit: 50,
} as const;

function sessionsResult(key: string, label: string, updatedAt: number) {
  return {
    count: 1,
    defaults: { contextTokens: null, model: null, modelProvider: null },
    path: "",
    sessions: [
      {
        boardFace: "dashboard",
        key,
        kind: "direct",
        label,
        updatedAt,
      },
    ],
    ts: updatedAt,
  };
}

function isDashboardRequest(request: { params?: unknown }): boolean {
  return (
    typeof request.params === "object" &&
    request.params !== null &&
    "boardFace" in request.params &&
    request.params.boardFace === "dashboard"
  );
}

async function requestCounts(gateways: MockGatewayControls[]) {
  const requests = (
    await Promise.all(gateways.map((gateway) => gateway.getRequests("sessions.list")))
  ).flat();
  const dashboard = requests.filter(isDashboardRequest).length;
  return { canonical: requests.length - dashboard, dashboard, total: requests.length };
}

suite.define(() => {
  it("keeps dashboard query demand at one request per real browser tab", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const tabs: Array<{
      gateway: MockGatewayControls;
      page: Page;
      canonicalLabel: string;
      dashboardLabel: string;
      updatedDashboardLabel: string;
    }> = [];
    try {
      for (const index of [1, 2]) {
        const page = await context.newPage();
        const dashboardLabel = `Dashboard tab ${index}`;
        const gateway = await installMockGateway(page, {
          deferredMethods: ["sessions.list"],
          methodResponses: {
            "sessions.list": {
              cases: [
                {
                  match: { archived: "all", boardFace: "dashboard" },
                  response: sessionsResult(`agent:main:dashboard-${index}`, dashboardLabel, index),
                },
              ],
            },
          },
        });
        const canonicalLabel = `Older canonical tab ${index}`;
        const updatedDashboardLabel = `Updated dashboard tab ${index}`;
        tabs.push({ gateway, page, canonicalLabel, dashboardLabel, updatedDashboardLabel });
      }

      await Promise.all(
        tabs.map(async ({ gateway, page }) => {
          await page.goto(suite.server.baseUrl);
          const canonical = await gateway.waitForRequest("sessions.list");
          expect(isDashboardRequest(canonical)).toBe(false);
          await page.waitForFunction(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime?: { context: { agents: { state: { agentsList: unknown } } } };
            };
            return app.runtime?.context.agents.state.agentsList != null;
          });
          await page.evaluate(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime?: {
                context: {
                  navigate: (routeId: string) => void;
                  agentSelection: {
                    state: { scopeId: string | null };
                    setScope: (agentId: string | null) => void;
                  };
                };
              };
            };
            if (!app.runtime) {
              throw new Error("OpenClaw application runtime is unavailable");
            }
            app.runtime.context.agentSelection.setScope(null);
            if (app.runtime.context.agentSelection.state.scopeId !== null) {
              throw new Error("Control UI did not enter all-agent scope");
            }
            app.runtime.context.navigate("dashboards");
          });
          await waitForControlUiRoute(page, { pathname: "/dashboards", routeId: "dashboards" });
        }),
      );
      await Promise.all(
        tabs.map(({ page, dashboardLabel }) =>
          page.getByText(dashboardLabel, { exact: true }).waitFor(),
        ),
      );
      expect(await requestCounts(tabs.map(({ gateway }) => gateway))).toEqual({
        canonical: 2,
        dashboard: 2,
        total: 4,
      });
      for (const tabGateway of tabs.map(({ gateway }) => gateway)) {
        const dashboardRequest = (await tabGateway.getRequests("sessions.list")).find(
          isDashboardRequest,
        );
        expect(dashboardRequest?.params).toEqual(DASHBOARD_REQUEST_PARAMS);
        expect(dashboardRequest?.params).not.toHaveProperty("agentId");
      }
      await Promise.all(
        tabs.map(async ({ canonicalLabel, gateway, page }, index) => {
          await gateway.resolveDeferred(
            "sessions.list",
            sessionsResult(`agent:main:canonical-${index + 1}`, canonicalLabel, 10 + index),
          );
          await page.getByText(canonicalLabel, { exact: true }).first().waitFor();
        }),
      );

      expect(await requestCounts(tabs.map(({ gateway }) => gateway))).toEqual({
        canonical: 2,
        dashboard: 2,
        total: 4,
      });

      const beforeWave = await Promise.all(
        tabs.map(({ gateway }) => gateway.getRequests("sessions.list")),
      );
      await Promise.all(
        tabs.map(async ({ gateway, updatedDashboardLabel }, index) => {
          await gateway.setMethodResponse("sessions.list", {
            cases: [
              {
                match: { archived: "all", boardFace: "dashboard" },
                response: sessionsResult(
                  `agent:main:updated-dashboard-${index + 1}`,
                  updatedDashboardLabel,
                  20 + index,
                ),
              },
            ],
          });
          await gateway.emitGatewayEvent("sessions.changed", {
            agentId: "main",
            key: `agent:main:changed-${index + 1}`,
            kind: "direct",
            reason: "update",
            sessionKey: `agent:main:changed-${index + 1}`,
            updatedAt: 20 + index,
          });
        }),
      );
      await Promise.all(
        tabs.map(({ gateway }, index) =>
          expect
            .poll(async () => {
              const added = (await gateway.getRequests("sessions.list")).slice(
                beforeWave[index]?.length ?? 0,
              );
              const dashboard = added.filter(isDashboardRequest).length;
              return { canonical: added.length - dashboard, dashboard };
            })
            .toEqual({ canonical: 1, dashboard: 1 }),
        ),
      );

      const afterWave = await Promise.all(
        tabs.map(({ gateway }) => gateway.getRequests("sessions.list")),
      );
      for (const [index, requests] of afterWave.entries()) {
        const added = requests.slice(beforeWave[index]?.length ?? 0);
        expect(added.filter(isDashboardRequest)).toHaveLength(1);
        expect(added.filter((request) => !isDashboardRequest(request))).toHaveLength(1);
      }
      const dashboardRequests = afterWave.flat().filter(isDashboardRequest);
      expect(dashboardRequests).toHaveLength(4);
      for (const request of dashboardRequests) {
        expect(request.params).toEqual(DASHBOARD_REQUEST_PARAMS);
        expect(request.params).not.toHaveProperty("agentId");
      }
      await Promise.all(
        tabs.map(({ page, updatedDashboardLabel }) =>
          page.getByText(updatedDashboardLabel, { exact: true }).waitFor(),
        ),
      );
    } finally {
      await context.close();
    }
  });
});
