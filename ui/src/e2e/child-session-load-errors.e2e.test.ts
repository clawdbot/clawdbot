import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);
const rosterMatch = { includeGlobal: true };

suite.define(() => {
  it("keeps one failed child load and alert until the operator retries", async () => {
    const mainKey = "agent:main:main";
    const parentKey = "agent:main:parent";
    const childKey = "agent:worker:child";
    const unrelatedKey = "agent:main:unrelated";
    const rootRows = () =>
      sessionsListResponse([
        sessionRow(mainKey, "Main", 30),
        sessionRow(parentKey, "Parent task", 20, { childSessions: [childKey] }),
        sessionRow(unrelatedKey, "Unrelated active task", 10),
      ]);
    const childFailure = {
      __mockError: {
        code: "UNAVAILABLE",
        message: "Child sessions unavailable",
      },
    };
    const childResponse = sessionsListResponse([
      sessionRow(childKey, "Recovered child", 40, { spawnedBy: parentKey }),
    ]);
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          cases: [
            { match: { spawnedBy: parentKey }, response: childFailure },
            { response: rootRows() },
          ],
        },
      },
      sessionKey: mainKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, mainKey));
      const parent = page.locator(`[data-session-key="${parentKey}"]`);
      await parent.waitFor({ state: "visible", timeout: 10_000 });
      await page.evaluate(() => {
        const marker = { insertions: 0 };
        Object.assign(globalThis, { childSessionAlertMarker: marker });
        new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (!(node instanceof Element)) {
                continue;
              }
              if (node.matches('[role="alert"]')) {
                marker.insertions += 1;
              }
              marker.insertions += node.querySelectorAll('[role="alert"]').length;
            }
          }
        }).observe(document.body, { childList: true, subtree: true });
      });
      await parent.locator(`[data-child-session-toggle="${parentKey}"]`).click();

      const alert = page.locator(`[data-child-session-error="${parentKey}"]`);
      await alert.waitFor({ state: "visible" });
      const mountedAlert = await alert.elementHandle();
      const childRequestCount = async () =>
        (await gateway.getRequests("sessions.list")).filter(
          (request) =>
            typeof request.params === "object" &&
            request.params !== null &&
            "spawnedBy" in request.params &&
            request.params.spawnedBy === parentKey,
        ).length;
      expect(await childRequestCount()).toBe(1);
      await captureUiProof(suite, page, "child-session-load-error.png");

      for (let revision = 1; revision <= 3; revision += 1) {
        const listRequests = (await gateway.getRequests("sessions.list", rosterMatch)).length;
        await gateway.emitGatewayEvent("sessions.changed", {
          key: unrelatedKey,
          reason: "run",
          sessionKey: unrelatedKey,
          updatedAt: 30 + revision,
        });
        await expect
          .poll(async () => (await gateway.getRequests("sessions.list", rosterMatch)).length)
          .toBeGreaterThan(listRequests);
        expect(await childRequestCount()).toBe(1);
        expect(await alert.count()).toBe(1);
        expect(await alert.evaluate((node, original) => node === original, mountedAlert)).toBe(
          true,
        );
      }
      expect(
        await page.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                childSessionAlertMarker: { insertions: number };
              }
            ).childSessionAlertMarker.insertions,
        ),
      ).toBe(1);

      await gateway.setMethodResponse("sessions.list", {
        cases: [
          { match: { spawnedBy: parentKey }, response: childResponse },
          { response: rootRows() },
        ],
      });
      await alert.getByRole("button", { name: "Retry" }).click();
      await page.getByText("Recovered child", { exact: true }).waitFor();
      expect(await childRequestCount()).toBe(2);
      expect(await alert.count()).toBe(0);
      await captureUiProof(suite, page, "child-session-load-recovered.png");
    } finally {
      await context.close();
    }
  });
});
