import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Live Activity current sessions mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (path) => `Playwright Chromium is unavailable at ${path}`,
});
const at = 1_800_000_000_000;
const running = {
  key: "agent:main:main",
  agentId: "main",
  sessionId: "session-running",
  kind: "direct",
  updatedAt: at,
  label: "Review release notes",
  hasActiveRun: true,
  status: "running",
  activeRunIds: ["run-review"],
};
const queued = {
  ...running,
  key: "agent:main:links",
  sessionId: "session-queued",
  label: "Check documentation links",
  status: "queued",
  activeRunIds: ["run-links"],
};
const listing = (sessions: object[]) => ({
  ts: at,
  path: "",
  count: sessions.length,
  totalCount: sessions.length,
  hasMore: false,
  sessions,
  defaults: { model: null, modelProvider: null, contextTokens: null },
});

suite.define(() => {
  it("loads running and queued sessions before events and refreshes current work on reconnect", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: "main",
        sessions: [running, queued],
        methodResponses: { "sessions.list": listing([running, queued]) },
      });
      await page.goto(`${suite.server.baseUrl}activity?view=live`);
      await waitForControlUiRoute(page, { routeId: "activity", search: "?view=live" });
      await gateway.waitForRequest("sessions.list", { match: { activeOnly: true } });
      const current = page.getByRole("region", { name: "Active sessions", exact: true });
      await current.getByText("Review release notes", { exact: true }).waitFor();
      await current.getByText("Queued", { exact: true }).waitFor();
      expect(await current.locator(".activity-current-work__row").count()).toBe(2);
      expect(await page.locator(".activity-entry").count()).toBe(0);

      await gateway.emitGatewayEvent("session.tool", {
        stream: "tool",
        runId: "run-review",
        sessionKey: running.key,
        data: {
          phase: "result",
          name: "read",
          toolCallId: "read-release-notes",
          result: { text: "Release notes checked." },
        },
      });
      await expect.poll(() => page.locator(".activity-entry").count()).toBe(1);
      await page.getByRole("button", { name: "Clear", exact: true }).click();
      await expect.poll(() => page.locator(".activity-entry").count()).toBe(0);
      expect(await current.locator(".activity-current-work__row").count()).toBe(2);

      await gateway.setMethodResponse("sessions.list", listing([queued]));
      await gateway.emitGatewayEvent("sessions.changed", {
        key: running.key,
        agentId: running.agentId,
        sessionId: running.sessionId,
        updatedAt: at + 1000,
        status: "done",
        hasActiveRun: false,
        activeRunIds: [],
      });
      await expect.poll(() => current.locator(".activity-current-work__row").count()).toBe(1);
      await gateway.setOnline(false);
      await current
        .getByText("Connect to the Gateway to load active sessions.", { exact: true })
        .waitFor();
      expect(await current.locator(".activity-current-work__row").count()).toBe(0);
      await gateway.setMethodResponse("sessions.list", listing([]));
      await gateway.setOnline(true);
      await current.getByText("No active sessions.", { exact: true }).waitFor();
      expect(await current.locator(".activity-current-work__row").count()).toBe(0);
      await gateway.setMethodResponse("sessions.list", {
        __mockError: { code: "UNAVAILABLE", message: "Snapshot unavailable" },
      });
      await gateway.emitGatewayEvent("sessions.changed", { reason: "update" });
      await current.getByText("Could not load active sessions.", { exact: true }).waitFor();
      await gateway.setMethodResponse("sessions.list", listing([]));
      await current.getByRole("button", { name: "Retry", exact: true }).click();
      await current.getByText("No active sessions.", { exact: true }).waitFor();
    });
  });

  it("reconciles completion during the first snapshot and keeps global navigation owner-specific", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const globalRow = (agentId: string) =>
        Object.assign({}, running, {
          key: "global",
          agentId,
          kind: "global",
          label: `${agentId} global work`,
          sessionId: `global-${agentId}`,
          activeRunIds: [`run-${agentId}`],
        });
      const mainGlobal = globalRow("main");
      const workGlobal = globalRow("work");
      const literal = {
        ...running,
        key: "agent:work:global",
        agentId: "work",
        sessionId: "literal-global",
        label: "Literal global session",
      };
      const unknown = ["main", "work"].map((agentId) =>
        Object.assign({}, running, {
          key: "unknown",
          kind: "unknown",
          agentId,
          sessionId: `unknown-${agentId}`,
          label: `${agentId} unknown work`,
        }),
      );
      const literalUnknown = {
        ...literal,
        key: "agent:work:unknown",
        sessionId: "literal-unknown",
        label: "Literal unknown session",
      };
      const activeRows = [mainGlobal, workGlobal, literal, ...unknown, literalUnknown];
      const gateway = await installMockGateway(page, {
        sessionScope: "global",
        heldMethods: ["sessions.list"],
        sessions: activeRows,
        methodResponses: {
          "agents.list": {
            defaultId: "main",
            mainKey: "main",
            scope: "global",
            agents: [{ id: "main" }, { id: "work" }],
          },
          "sessions.list": {
            cases: [
              { match: { activeOnly: true }, response: listing(activeRows) },
              { match: { agentId: "work" }, response: listing([workGlobal, literal]) },
              { match: {}, response: listing([mainGlobal, literal]) },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}activity?view=live`);
      await waitForControlUiRoute(page, { routeId: "activity", search: "?view=live" });
      await gateway.waitForRequest("sessions.list", { match: { activeOnly: true } });
      const current = page.getByRole("region", { name: "Active sessions", exact: true });
      await current.getByText("Loading active sessions…", { exact: true }).waitFor();
      await gateway.emitGatewayEvent("sessions.changed", {
        key: "global",
        agentId: "main",
        sessionId: "global-main",
        updatedAt: at + 1000,
        status: "done",
        hasActiveRun: false,
      });
      await gateway.resolveDeferred("sessions.list", listing(activeRows));
      await expect.poll(() => current.locator(".activity-current-work__row").count()).toBe(5);
      const work = current.locator('[data-session-key="global"][data-agent-id="work"]');
      await work.getByText("work global work", { exact: true }).waitFor();
      expect(await work.getAttribute("href")).toBe("/chat/work");
      expect(
        await current.locator('[data-session-key="agent:work:global"]').getAttribute("href"),
      ).toBe("/chat/work/~key/global");
      expect(
        await current.locator('[data-session-key="global"][data-agent-id="main"]').count(),
      ).toBe(0);
      expect(await current.locator('[data-session-key="unknown"]').count()).toBe(2);
      expect(await current.locator('a[data-session-key="unknown"]').count()).toBe(0);
      expect(
        await current.locator('a[data-session-key="agent:work:unknown"]').getAttribute("href"),
      ).toBe("/chat/work/unknown");
      expect(await page.locator(".activity-entry").count()).toBe(0);
      await work.click();
      await waitForControlUiRoute(page, { routeId: "chat", pathname: "/chat/work" });
      await gateway.waitForRequest("chat.startup", {
        match: { sessionKey: "agent:work:main", agentId: "work" },
      });
    });
  });
});
