import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("searches Sessions through the Gateway, appends matches, and retires failed or replaced queries", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const rows = Array.from({ length: 51 }, (_, index) =>
      sessionRow(`agent:main:match-${index}`, `Match ${index}`, 1000 - index),
    );
    const latest = sessionRow("agent:main:latest", "Latest result", 2000);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          cases: [
            {
              match: { search: "observatory", offset: 50 },
              response: sessionsListResponse(rows.slice(50), { offset: 50, totalCount: 51 }),
            },
            {
              match: { search: "observatory" },
              response: sessionsListResponse(rows.slice(0, 50), {
                hasMore: true,
                nextOffset: 50,
                totalCount: 51,
              }),
            },
            { match: { search: "latest" }, response: sessionsListResponse([latest]) },
            {
              match: { search: "failed" },
              response: {
                __mockError: { code: "UNAVAILABLE", message: "Metadata search unavailable" },
              },
            },
            { match: {}, response: sessionsListResponse([]) },
          ],
        },
      },
      sessionKey: "agent:main:main",
    });
    try {
      await page.goto(`${suite.server.baseUrl}sessions`);
      const roster = page.locator("openclaw-sessions-page");
      const search = roster.locator(".sessions-toolbar__search input");
      await search.pressSequentially("observatory", { delay: 40 });
      await roster.getByRole("button", { name: "Load more sessions", exact: true }).click();
      await expect
        .poll(() => gateway.getRequests("sessions.list"))
        .toContainEqual(
          expect.objectContaining({
            params: expect.objectContaining({ search: "observatory", offset: 50, limit: 50 }),
          }),
        );
      await roster.getByRole("button", { name: "Next", exact: true }).click();
      await roster.getByRole("button", { name: "Next", exact: true }).click();
      await roster.getByText("Match 50", { exact: true }).waitFor();
      const searches = (await gateway.getRequests("sessions.list")).filter(
        (request) => typeof requireRecord(request.params).search === "string",
      );
      expect(searches).toEqual([
        expect.objectContaining({ params: expect.objectContaining({ search: "observatory" }) }),
        expect.objectContaining({
          params: expect.objectContaining({ search: "observatory", offset: 50 }),
        }),
      ]);
      await gateway.deferNext("sessions.list", { search: "older" });
      await search.fill("older");
      await expect
        .poll(() => gateway.getRequests("sessions.list"))
        .toContainEqual(
          expect.objectContaining({ params: expect.objectContaining({ search: "older" }) }),
        );
      expect(
        await roster.getByText("No sessions match your filters.", { exact: true }).count(),
      ).toBe(0);
      const beforeTyping = await gateway.getRequests("sessions.list");
      await search.fill("");
      await search.pressSequentially("superseded", { delay: 40 });
      await search.fill("");
      await search.pressSequentially("latest", { delay: 40 });
      await roster.locator('.sessions-view-segment wa-radio[value="archived"]').click();
      await roster.locator('.sessions-view-segment wa-radio[value="all"]').click();
      expect(await search.inputValue()).toBe("latest");
      expect(await gateway.getRequests("sessions.list")).toEqual(beforeTyping);
      await gateway.resolveDeferred(
        "sessions.list",
        sessionsListResponse([sessionRow("agent:main:older", "Retired result", 1)]),
      );
      await roster.getByText("Latest result", { exact: true }).waitFor();
      expect((await gateway.getRequests("sessions.list")).slice(beforeTyping.length)).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({ search: "latest", archived: "all" }),
        }),
      ]);
      expect(await roster.getByText("Retired result", { exact: true }).count()).toBe(0);
      await search.fill("failed");
      await roster.getByText("Metadata search unavailable", { exact: false }).waitFor();
      expect(
        await roster.getByText("No sessions match your filters.", { exact: true }).count(),
      ).toBe(0);
    } finally {
      await context.close();
    }
  });

  it.each(["Archived", "All"] as const)(
    "clears the visible %s sidebar error after its failed roster recovers or retires",
    async (statusFilter) => {
      const context = await suite.browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const page = await context.newPage();
      const updatedAt = Date.parse("2026-07-01T16:00:00.000Z");
      const main = sessionRow("agent:main:main", "Main", updatedAt);
      const archived = sessionRow("agent:main:archived", "Archived planning", updatedAt - 1, {
        archived: true,
      });
      const healthy = sessionsListResponse([main, archived]);
      const gateway = await installMockGateway(page, {
        methodResponses: { "sessions.list": healthy },
        sessionArchiveFiltering: true,
        sessionKey: main.key,
      });

      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        const selectFilter = async (label: "Archived" | "All" | "Active") => {
          await page.getByRole("button", { name: "Filter & sort" }).click();
          await page
            .locator(".sidebar-session-sort-menu")
            .getByRole("menuitemradio", { name: label, exact: true })
            .click();
        };
        await selectFilter(statusFilter);
        await page.getByText("Archived planning", { exact: true }).first().waitFor();

        const failure = {
          __mockError: { code: "UNAVAILABLE", message: "Session list temporarily unavailable" },
        };
        const refresh = () =>
          gateway.emitGatewayEvent("sessions.changed", {
            ...archived,
            agentId: "main",
            reason: "update",
            sessionKey: archived.key,
          });
        const alert = page.locator("[data-sidebar-session-error]");

        await gateway.setMethodResponse("sessions.list", failure);
        await refresh();
        await expect
          .poll(() => alert.textContent())
          .toContain("Session list temporarily unavailable");
        if (statusFilter === "Archived") {
          await captureUiProof(suite, page, "filtered-session-error-recovery-before.png");
        }

        await gateway.setMethodResponse("sessions.list", healthy);
        await refresh();
        await expect.poll(() => alert.count()).toBe(0);
        await page.getByText("Archived planning", { exact: true }).first().waitFor();
        if (statusFilter === "Archived") {
          await captureUiProof(suite, page, "filtered-session-error-recovery-after.png");
        }

        await gateway.setMethodResponse("sessions.list", failure);
        await refresh();
        await expect
          .poll(() => alert.textContent())
          .toContain("Session list temporarily unavailable");

        await selectFilter("Active");
        await expect.poll(() => alert.count()).toBe(0);
      } finally {
        await context.close();
      }
    },
  );
});
