import { expect, it } from "vitest";
import {
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const archived = sessionRow(
  "agent:main:archived-write-scope",
  "Archived write scope",
  Date.parse("2026-08-01T12:00:00.000Z"),
  { archived: true },
);

async function confirmDelete(page: import("playwright").Page) {
  await page
    .locator("openclaw-modal-dialog")
    .last()
    .getByRole("button", { name: "Delete", exact: true })
    .click();
}

async function openArchivedPage(operatorScopes: string[]) {
  const context = await suite.browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    featureMethods: ["chat.metadata", "chat.startup", "sessions.delete"],
    operatorScopes,
    sessionArchiveFiltering: true,
    methodResponses: {
      "sessions.delete": { deleted: true },
      "sessions.list": sessionsListResponse([archived]),
    },
  });
  await page.goto(`${suite.server.baseUrl}sessions?status=archived`);
  const deleteAll = page.getByRole("button", { name: /Delete all archived/ });
  await deleteAll.waitFor();
  return { context, deleteAll, gateway, page };
}

suite.define(() => {
  it("lets write-scoped operators delete archived sessions with archivedOnly", async () => {
    const { context, deleteAll, gateway, page } = await openArchivedPage([
      "operator.read",
      "operator.write",
    ]);
    try {
      await expect.poll(() => deleteAll.isEnabled()).toBe(true);
      await deleteAll.click();
      await confirmDelete(page);

      await expect(gateway.waitForRequest("sessions.delete")).resolves.toMatchObject({
        params: {
          archivedOnly: true,
          deleteTranscript: true,
          key: archived.key,
        },
      });
    } finally {
      await context.close();
    }
  });

  it("keeps archived deletion disabled for read-scoped operators", async () => {
    const { context, deleteAll, gateway } = await openArchivedPage(["operator.read"]);
    try {
      await expect.poll(() => deleteAll.isDisabled()).toBe(true);
      await deleteAll.click({ force: true });
      expect(await gateway.getRequests("sessions.delete")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
