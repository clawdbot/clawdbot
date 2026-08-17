// Control UI E2E tests cover session-list event scope through the Gateway WebSocket.
import type { Page } from "playwright";
import { afterEach, expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session-list event scope",
});

// Browser contexts preserve test isolation; keep one process warm for this file.
let page: Page | undefined;
suite.define(() => {
  afterEach(async () => {
    await page
      ?.context()
      .close()
      .catch(() => {});
    page = undefined;
  });

  it("refetches instead of showing a row excluded by configured-agent filtering", async () => {
    const visibleLabel = "Visible configured session";
    const hiddenLabel = "Hidden unconfigured session";
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, {
      sessionKey: "unknown",
      methodResponses: {
        "sessions.list": {
          count: 1,
          defaults: { contextTokens: null, model: null, modelProvider: null },
          path: "",
          sessions: [
            {
              key: "agent:main:visible",
              kind: "direct",
              label: visibleLabel,
              updatedAt: 1,
            },
          ],
          ts: 1,
        },
      },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}sessions`);
    const visibleRow = currentPage.getByText(visibleLabel, { exact: true }).first();
    await visibleRow.waitFor({ timeout: 10_000 });
    // Arm the deferred response before sampling requests; startup may still finish in between.
    await gateway.deferNext("sessions.list");
    const requestsBeforeEvent = await gateway.getRequests("sessions.list");
    expect(
      requestsBeforeEvent.some(
        (request) =>
          (request.params as { configuredAgentsOnly?: unknown } | undefined)
            ?.configuredAgentsOnly === true,
      ),
    ).toBe(true);

    await gateway.emitGatewayEvent("sessions.changed", {
      sessionKey: "agent:local:hidden",
      reason: "create",
      key: "agent:local:hidden",
      kind: "direct",
      label: hiddenLabel,
      updatedAt: 2,
    });

    await expect
      .poll(async () => (await gateway.getRequests("sessions.list")).length)
      .toBeGreaterThan(requestsBeforeEvent.length);
    expect(await currentPage.getByText(hiddenLabel, { exact: true }).count()).toBe(0);
    await gateway.resolveDeferred("sessions.list", {
      count: 1,
      defaults: { contextTokens: null, model: null, modelProvider: null },
      path: "",
      sessions: [
        {
          key: "agent:main:visible",
          kind: "direct",
          label: visibleLabel,
          updatedAt: 3,
        },
      ],
      ts: 3,
    });
    await visibleRow.waitFor();
    expect(await currentPage.getByText(hiddenLabel, { exact: true }).count()).toBe(0);
  });

  it("keeps the Sessions page query stable when the startup roster completes", async () => {
    const visibleLabel = "Visible page-owned session";
    const pageQueryParams = {
      agentId: "main",
      configuredAgentsOnly: true,
      includeGlobal: true,
      includeUnknown: false,
      limit: 50,
    };
    const visibleResponse = {
      count: 1,
      defaults: { contextTokens: null, model: null, modelProvider: null },
      path: "",
      sessions: [
        {
          key: "agent:main:page-owned",
          kind: "direct",
          label: visibleLabel,
          updatedAt: 1,
        },
      ],
      ts: 1,
    };
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, {
      deferredMethods: ["sessions.list"],
      sessionKey: "agent:main:main",
      methodResponses: {
        "sessions.list": {
          cases: [
            { match: pageQueryParams, response: visibleResponse },
            {
              response: {
                count: 0,
                defaults: visibleResponse.defaults,
                path: "",
                sessions: [],
                ts: 1,
              },
            },
          ],
        },
      },
    });
    const exactPageQueries = async () =>
      (await gateway.getRequests("sessions.list")).filter((request) => {
        const params = request.params;
        if (!params || typeof params !== "object" || Array.isArray(params)) {
          return false;
        }
        const record = params as Record<string, unknown>;
        const entries = Object.entries(pageQueryParams);
        return (
          Object.keys(record).length === entries.length &&
          entries.every(([key, value]) => record[key] === value)
        );
      });

    await currentPage.goto(`${suite.server.baseUrl}sessions`);
    const visibleRow = currentPage.getByText(visibleLabel, { exact: true }).first();
    await visibleRow.waitFor({ timeout: 10_000 });

    const startupAndPageRequests = await gateway.getRequests("sessions.list");
    expect(startupAndPageRequests[0]?.params).toEqual({
      agentId: "main",
      configuredAgentsOnly: true,
      includeDerivedTitles: true,
      includeGlobal: true,
      includeLastMessage: true,
      includeUnknown: true,
      limit: 50,
    });
    expect
      .soft((await exactPageQueries()).map((request) => request.params))
      .toEqual([pageQueryParams]);

    await gateway.resolveDeferred("sessions.list", visibleResponse);
    await visibleRow.waitFor();

    const stabilityDeadline = Date.now() + 500;
    do {
      expect(await exactPageQueries()).toHaveLength(1);
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    } while (Date.now() < stabilityDeadline);
  });

  it("keeps older Gateway sessions consistent between the sidebar and Sessions page", async () => {
    const sessionKey = "agent:main:older-stored";
    const sessionLabel = "Older stored session";
    const populatedResponse = {
      count: 1,
      defaults: { contextTokens: null, model: null, modelProvider: null },
      path: "",
      sessions: [
        {
          key: sessionKey,
          kind: "direct",
          label: sessionLabel,
          updatedAt: 1,
        },
      ],
      ts: 1,
    };
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, {
      sessionKey: "agent:main:main",
      methodResponses: {
        "sessions.list": {
          cases: [
            {
              match: { activeMinutes: 60 },
              response: {
                count: 0,
                defaults: populatedResponse.defaults,
                path: "",
                sessions: [],
                ts: 2,
              },
            },
            { response: populatedResponse },
          ],
        },
      },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}chat`);
    const sidebarRow = currentPage.locator(
      `.sidebar-recent-session[data-session-key="${sessionKey}"]`,
    );
    await sidebarRow.getByText(sessionLabel, { exact: true }).waitFor({ timeout: 10_000 });
    const sidebarRequests = await gateway.getRequests("sessions.list");
    const sidebarParams = sidebarRequests.find(
      (request) =>
        (request.params as { includeUnknown?: unknown } | undefined)?.includeUnknown === true,
    )?.params as Record<string, unknown> | undefined;
    expect(sidebarParams).toMatchObject({ limit: 50 });
    expect(sidebarParams).not.toHaveProperty("activeMinutes");

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}sessions`);
    const sessionsPage = currentPage.locator("openclaw-sessions-page");
    await sessionsPage.getByText(sessionLabel, { exact: true }).waitFor({ timeout: 10_000 });
    const initialPageRequests = await gateway.getRequests("sessions.list");
    const initialPageParams = initialPageRequests.find(
      (request) =>
        (request.params as { includeUnknown?: unknown } | undefined)?.includeUnknown === false,
    )?.params as Record<string, unknown> | undefined;
    expect(initialPageParams).toMatchObject({ limit: 50 });
    expect(initialPageParams).not.toHaveProperty("activeMinutes");

    const activeMinutes = sessionsPage.getByLabel("Updated within");
    const limit = sessionsPage.getByLabel("Limit");
    await expect.poll(() => activeMinutes.inputValue()).toBe("");
    await expect.poll(() => limit.inputValue()).toBe("50");

    let requestCount = initialPageRequests.length;
    await activeMinutes.fill("60");
    await expect
      .poll(async () => (await gateway.getRequests("sessions.list")).length)
      .toBeGreaterThan(requestCount);
    const filteredParams = (await gateway.getRequests("sessions.list")).at(-1)?.params as
      | Record<string, unknown>
      | undefined;
    expect(filteredParams).toMatchObject({ activeMinutes: 60, limit: 50 });
    await expect.poll(() => sessionsPage.getByText(sessionLabel, { exact: true }).count()).toBe(0);

    requestCount = (await gateway.getRequests("sessions.list")).length;
    await sessionsPage.getByRole("button", { name: "Show all" }).click();
    await expect
      .poll(async () => (await gateway.getRequests("sessions.list")).length)
      .toBeGreaterThan(requestCount);
    await sessionsPage.getByText(sessionLabel, { exact: true }).waitFor();
    const resetParams = (await gateway.getRequests("sessions.list")).at(-1)?.params as
      | Record<string, unknown>
      | undefined;
    expect(resetParams).toMatchObject({ includeUnknown: false, limit: 50 });
    expect(resetParams).not.toHaveProperty("activeMinutes");
    await expect.poll(() => activeMinutes.inputValue()).toBe("");
    await expect.poll(() => limit.inputValue()).toBe("50");
  });

  it("omits noncanonical numeric filters from sessions.list requests", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const currentPage = await context.newPage();
    page = currentPage;
    const gateway = await installMockGateway(currentPage, {
      sessionKey: "unknown",
      methodResponses: {
        "sessions.list": {
          count: 0,
          defaults: { contextTokens: null, model: null, modelProvider: null },
          path: "",
          sessions: [],
          ts: 1,
        },
      },
    });

    await currentPage.goto(`${suite.server?.baseUrl ?? ""}sessions`);
    await gateway.waitForRequest("sessions.list");
    const activeMinutes = currentPage.getByLabel("Updated within");
    const limit = currentPage.getByLabel("Limit");
    const cases = [
      { activeMinutes: "60minutes", limit: "70junk", expected: { limit: 50 } },
      { activeMinutes: "12.5", limit: "1e2", expected: { limit: 50 } },
      { activeMinutes: "9007199254740993", limit: "9007199254740993", expected: { limit: 50 } },
      { activeMinutes: "+30", limit: "060", expected: { activeMinutes: 30, limit: 60 } },
      { activeMinutes: " 80 ", limit: " 090 ", expected: { activeMinutes: 80, limit: 90 } },
    ];
    for (const testCase of cases) {
      const requestCount = (await gateway.getRequests("sessions.list")).length;
      await activeMinutes.fill(testCase.activeMinutes);
      await limit.fill(testCase.limit);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(requestCount);
      await expect
        .poll(async () => {
          const params = (await gateway.getRequests("sessions.list")).at(-1)?.params as
            | Record<string, unknown>
            | undefined;
          return { activeMinutes: params?.activeMinutes, limit: params?.limit };
        })
        .toEqual({ activeMinutes: undefined, ...testCase.expected });
    }
  });
});
