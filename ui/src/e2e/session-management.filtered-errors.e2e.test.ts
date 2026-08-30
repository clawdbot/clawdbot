import { expect, it } from "vitest";
import {
  captureUiProof,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
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
          await captureUiProof(page, "filtered-session-error-recovery-before.png");
        }

        await gateway.setMethodResponse("sessions.list", healthy);
        await refresh();
        await expect.poll(() => alert.count()).toBe(0);
        await page.getByText("Archived planning", { exact: true }).first().waitFor();
        if (statusFilter === "Archived") {
          await captureUiProof(page, "filtered-session-error-recovery-after.png");
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
