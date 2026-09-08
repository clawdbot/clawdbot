import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar refresh availability" });
const suspensionError = {
  code: "UNAVAILABLE",
  message: "sessions.catalog.list unavailable during gateway suspension",
  retryable: true,
  details: { reason: "gateway-suspending", phase: "draining", method: "sessions.catalog.list" },
};

function catalog(name: string) {
  return {
    catalogs: [
      {
        id: "codex",
        label: "Codex",
        capabilities: { continueSession: true, archive: true },
        hosts: [
          {
            hostId: "gateway:local",
            label: "Local Codex",
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId: "synthetic-thread",
                name,
                status: "idle",
                archived: false,
                canContinue: true,
                canArchive: true,
              },
            ],
          },
        ],
      },
    ],
  };
}

suite.define(() => {
  it("keeps suspension in the footer and refreshes retained rows when admission reopens", async () => {
    const artifactDir = createControlUiE2eArtifactDir(
      "sidebar-availability",
      ".artifacts/error-consolidation",
    );
    const context = await suite.browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "sessions.catalog.list"],
        methodResponses: { "sessions.catalog.list": catalog("Retained sample session") },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.getByText("Retained sample session", { exact: true }).waitFor();
      await gateway.setMethodResponse("sessions.catalog.list", { __mockError: suspensionError });
      await gateway.emitGatewayEvent("gateway.suspension", { phase: "draining" });
      await gateway.emitGatewayEvent("presence", {
        presence: [{ instanceId: "synthetic-host", mode: "node" }],
      });
      await expect
        .poll(async () => {
          const app = await sidebar.evaluate(
            (element) =>
              (
                element as HTMLElement & {
                  sessionData: { sessionCatalogRefreshStatus: { awaitingGateway: boolean } };
                }
              ).sessionData.sessionCatalogRefreshStatus.awaitingGateway,
          );
          return app;
        })
        .toBe(true);
      expect(await sidebar.getByRole("alert").count()).toBe(0);
      await sidebar.getByText("Suspending…", { exact: true }).waitFor();
      expect(await sidebar.getByText("Retained sample session", { exact: true }).isVisible()).toBe(
        true,
      );
      await page.screenshot({ path: path.join(artifactDir, "suspending.png") });
      const before = (await gateway.getRequests("sessions.catalog.list")).length;
      await gateway.setMethodResponse("sessions.catalog.list", catalog("Recovered sample session"));
      await gateway.emitGatewayEvent("gateway.suspension", { phase: "accepting" });
      await sidebar.getByText("Recovered sample session", { exact: true }).waitFor();
      expect((await gateway.getRequests("sessions.catalog.list")).length).toBe(before + 1);
      expect(await gateway.getSocketCount()).toBe(1);
      expect(await sidebar.getByRole("alert").count()).toBe(0);
      await page.screenshot({ path: path.join(artifactDir, "recovered.png") });

      await gateway.setMethodResponse("sessions.catalog.list", {
        __mockError: { code: "UNAVAILABLE", message: "Catalog service failed" },
      });
      await gateway.emitGatewayEvent("presence", {
        presence: [{ instanceId: "synthetic-host", mode: "node", reason: "disconnect" }],
      });
      const alert = sidebar.getByRole("alert");
      await alert.waitFor();
      expect(await alert.textContent()).toContain("Catalog service failed");
      expect(await alert.textContent()).toContain("Showing stale data");
      expect(await alert.getByRole("button").count()).toBe(0);
      await page.screenshot({ path: path.join(artifactDir, "after-hard-error.png") });

      await gateway.setMethodResponse("sessions.catalog.list", { __mockError: suspensionError });
      await gateway.emitGatewayEvent("gateway.suspension", { phase: "draining" });
      await gateway.emitGatewayEvent("presence", {
        presence: [{ instanceId: "synthetic-host", mode: "node" }],
      });
      await expect.poll(() => sidebar.getByRole("alert").count()).toBe(0);
      await gateway.setMethodResponse("connect", { __mockError: suspensionError });
      await gateway.closeLatest();
      await expect
        .poll(async () => (await gateway.getRequests("connect")).length)
        .toBeGreaterThan(1);
      await sidebar.getByText("Suspending…", { exact: true }).waitFor();
      expect(await sidebar.getByRole("alert").count()).toBe(0);
      await page.screenshot({ path: path.join(artifactDir, "after-sidebar.png") });
    } finally {
      await context.close();
    }
  });
});
