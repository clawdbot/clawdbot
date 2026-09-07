import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
// Control UI E2E proves dashboard tabs do not multiply server-owned session-list demand.
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../src/shared/session-list-limits.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
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
  configuredAgentsOnly: true,
  hasBoard: true,
  includeGlobal: true,
  includeUnknown: true,
  limit: SIDEBAR_SESSION_ROSTER_LIMIT,
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
    "hasBoard" in request.params &&
    request.params.hasBoard === true
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
  it("shows failed dashboard refreshes beside retained rows and retries the same query", async () => {
    const artifactDir = createControlUiE2eArtifactDir("dashboard-refresh-errors");
    const context = await suite.browser.newContext({ viewport: { height: 900, width: 1440 } });
    const page = await context.newPage();
    try {
      const key = "agent:main:dashboard-12345678";
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.list": {
            cases: [
              {
                match: { hasBoard: true },
                response: sessionsResult(key, "Deploy monitor", 1),
              },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}dashboards`);
      const dashboards = page.locator("openclaw-dashboards-page");
      await dashboards.getByText("Deploy monitor", { exact: true }).waitFor();
      const before = (await gateway.getRequests("sessions.list")).filter(isDashboardRequest);
      await gateway.deferNext("sessions.list", { hasBoard: true });
      await gateway.emitGatewayEvent("sessions.changed", {
        agentId: "main",
        key,
        sessionKey: key,
        kind: "direct",
        reason: "update",
        updatedAt: 2,
      });
      await expect
        .poll(
          async () =>
            (await gateway.getRequests("sessions.list")).filter(isDashboardRequest).length,
        )
        .toBe(before.length + 1);
      await gateway.rejectDeferred("sessions.list", {
        code: "UNAVAILABLE",
        message: "Dashboard refresh unavailable",
        retryable: true,
      });
      // Confirm the real store consumed the failed wire response before capturing the UI.
      // The predicate runs in the page, so the limit crosses as an argument.
      await page.waitForFunction((rosterLimit) => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: {
            context: {
              agentSelection: { state: { scopeId: string | null } };
              sessions: {
                listSnapshot: (query: Record<string, unknown>) => {
                  error: string | null;
                  loading: boolean;
                };
              };
            };
          };
        };
        const appContext = app.runtime?.context;
        return (
          appContext?.sessions.listSnapshot({
            limit: rosterLimit,
            hasBoard: true,
            archivedFilter: "all",
            agentId: appContext.agentSelection.state.scopeId ?? undefined,
          }).error === "Dashboard refresh unavailable"
        );
      }, SIDEBAR_SESSION_ROSTER_LIMIT);
      await page.screenshot({ path: path.join(artifactDir, "refresh-failed.png") });
      expect(await dashboards.getByText("Deploy monitor", { exact: true }).isVisible()).toBe(true);
      expect(await page.locator("openclaw-router-outlet").getAttribute("inert")).toBeNull();
      await expect.poll(() => dashboards.getByRole("alert").allTextContents()).toHaveLength(1);
      expect(await dashboards.getByRole("alert").textContent()).toContain(
        "Dashboard refresh unavailable",
      );
      expect(await dashboards.getByRole("alert").textContent()).toContain("Showing stale data");
      expect(await dashboards.getByRole("alert").getByRole("button").count()).toBe(0);

      await gateway.setMethodResponse("sessions.list", {
        cases: [
          {
            match: { hasBoard: true },
            response: sessionsResult(key, "Updated deploy monitor", 2),
          },
        ],
      });
      await gateway.emitGatewayEvent("gateway.suspension", { phase: "draining" });
      await gateway.emitGatewayEvent("gateway.suspension", { phase: "accepting" });
      await dashboards.getByText("Updated deploy monitor", { exact: true }).waitFor();
      expect(await dashboards.getByRole("alert").count()).toBe(0);
      const after = (await gateway.getRequests("sessions.list")).filter(isDashboardRequest);
      expect(after).toHaveLength(before.length + 2);
      expect(after.at(-1)?.params).toEqual(before.at(-1)?.params);
      await page.screenshot({ path: path.join(artifactDir, "refresh-recovered.png") });
    } finally {
      await context.close();
    }
  });

  it.each([false, true])(
    "recovers an initial dashboard failure without claiming the list is empty (suspending: %s)",
    async (suspending) => {
      const context = await suite.browser.newContext({ viewport: { height: 900, width: 1440 } });
      const page = await context.newPage();
      try {
        const gateway = await installMockGateway(page, {
          gatewaySuspensionPhase: suspending ? "draining" : "accepting",
          methodResponses: {
            "sessions.list": {
              cases: [
                {
                  match: { hasBoard: true },
                  response: {
                    __mockError: {
                      code: "UNAVAILABLE",
                      message: "Dashboard list unavailable",
                      retryable: true,
                      ...(suspending
                        ? { details: { reason: "gateway-suspending", phase: "draining" } }
                        : {}),
                    },
                  },
                },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}dashboards`);
        const dashboards = page.locator("openclaw-dashboards-page");
        if (suspending) {
          await dashboards.locator('[aria-busy="true"]').waitFor();
          expect(await dashboards.getByRole("alert").count()).toBe(0);
        } else {
          await dashboards.getByRole("alert").waitFor();
          expect(await dashboards.getByRole("alert").textContent()).toContain(
            "Dashboard list unavailable",
          );
          await gateway.setMethodResponse("sessions.list", {
            cases: [
              {
                match: { hasBoard: true },
                response: {
                  __mockError: {
                    code: "UNAVAILABLE",
                    message: "Gateway is suspending",
                    retryable: true,
                    details: { reason: "gateway-suspending", phase: "draining" },
                  },
                },
              },
            ],
          });
          await gateway.emitGatewayEvent("gateway.suspension", { phase: "draining" });
          await gateway.emitGatewayEvent("sessions.changed", {
            agentId: "main",
            key: "agent:main:dashboard",
            sessionKey: "agent:main:dashboard",
            reason: "update",
          });
          await dashboards.locator('[aria-busy="true"]').waitFor();
          expect(await dashboards.getByRole("alert").count()).toBe(0);
        }
        expect(await dashboards.getByRole("button", { name: "Retry", exact: true }).count()).toBe(
          0,
        );
        expect(await dashboards.textContent()).not.toContain("Showing stale data");
        expect(await dashboards.locator("[data-dashboards-empty]").count()).toBe(0);
        const emptyResult = { ...sessionsResult("", "", 1), count: 0, sessions: [] };
        await gateway.setMethodResponse("sessions.list", {
          cases: [{ match: { hasBoard: true }, response: emptyResult }],
        });
        await gateway.emitGatewayEvent("gateway.suspension", { phase: "draining" });
        await gateway.emitGatewayEvent("gateway.suspension", { phase: "accepting" });
        await dashboards.locator("[data-dashboards-empty]").waitFor();
        expect(await dashboards.getByRole("alert").count()).toBe(0);
      } finally {
        await context.close();
      }
    },
  );

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
                  match: { archived: "all", hasBoard: true },
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
          // Chat hydrates its own Swarm child roster; start without that unrelated demand.
          await page.goto(`${suite.server.baseUrl}new`);
          const canonical = await gateway.waitForRequest("sessions.list");
          expect(canonical.params).toEqual({
            agentId: "main",
            configuredAgentsOnly: true,
            includeDerivedTitles: true,
            includeGlobal: true,
            includeLastMessage: true,
            includeUnknown: true,
            limit: SIDEBAR_SESSION_ROSTER_LIMIT,
          });
          await waitForControlUiRoute(page, { pathname: "/new", routeId: "new-session" });
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
                match: { archived: "all", hasBoard: true },
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
