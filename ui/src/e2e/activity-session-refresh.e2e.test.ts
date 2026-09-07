import path from "node:path";
import { expect, it } from "vitest";
import { chatSessionListResponse, installMockGateway } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Activity session refresh lifecycle" });

suite.define(() => {
  it("holds hidden Activity invalidations and catches up once before coalescing visible bursts", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
        recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } },
      },
      async ({ page }) => {
        const key = "agent:main:activity-refresh";
        const response = (label: string) =>
          chatSessionListResponse([{ key, kind: "direct", label, updatedAt: Date.now() }]);
        const gateway = await installMockGateway(page, {
          sessionKey: key,
          methodResponses: { "sessions.list": response("Initial activity") },
        });
        await page.goto(`${suite.server.baseUrl}activity`);
        const row = page.locator(`[data-activity-session="${key}"]`);
        await expect.poll(() => row.textContent()).toContain("Initial activity");
        await page.screenshot({ path: path.join(suite.artifactDir, "01-initial.png") });
        const activityRequests = async () =>
          (await gateway.getRequests("sessions.list")).filter(
            (request) =>
              request.params !== null &&
              typeof request.params === "object" &&
              "includePeople" in request.params &&
              request.params.includePeople === true,
          ).length;
        const initialRequests = await activityRequests();
        await page.clock.install();
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await gateway.setSessionsListResponse(response("Caught up activity"));
        for (let index = 0; index < 10; index += 1) {
          await gateway.emitGatewayEvent("sessions.changed", { sessionKey: key, reason: "update" });
          await page.clock.runFor(50);
        }
        expect(await activityRequests()).toBe(initialRequests);
        expect(await row.textContent()).toContain("Initial activity");

        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "visible",
          });
          document.dispatchEvent(new Event("visibilitychange"));
          globalThis.dispatchEvent(new Event("pageshow"));
        });
        await page.clock.runFor(0);
        await expect.poll(() => row.textContent()).toContain("Caught up activity");
        expect(await activityRequests()).toBe(initialRequests + 1);
        await page.screenshot({ path: path.join(suite.artifactDir, "02-caught-up.png") });

        await gateway.setSessionsListResponse(response("Latest activity"));
        for (let index = 0; index < 10; index += 1) {
          await gateway.emitGatewayEvent("sessions.changed", { sessionKey: key, reason: "update" });
          await page.clock.runFor(10);
        }
        expect(await activityRequests()).toBe(initialRequests + 1);
        await page.clock.runFor(200);
        await expect.poll(() => row.textContent()).toContain("Latest activity");
        expect(await activityRequests()).toBe(initialRequests + 2);
        await page.screenshot({ path: path.join(suite.artifactDir, "03-visible-burst.png") });

        await gateway.emitGatewayEvent("agent", {
          runId: "run-activity",
          stream: "tool",
          sessionKey: "main",
          data: {
            phase: "result",
            name: "exec",
            toolCallId: "tool-activity",
            result: { content: [{ type: "text", text: "Retained while viewing sessions." }] },
          },
        });
        await page.getByRole("tab", { name: "Live activity", exact: true }).click();
        const entry = page.locator(".activity-entry");
        await expect.poll(() => entry.count()).toBe(1);
        await entry.locator("summary").click();
        await entry.getByText("Retained while viewing sessions.", { exact: true }).waitFor();
        await page.screenshot({ path: path.join(suite.artifactDir, "04-live-activity.png") });
        for (let index = 0; index < 20; index += 1) {
          await gateway.emitGatewayEvent("agent", {
            runId: "run-activity",
            stream: "tool",
            sessionKey: "main",
            data: { phase: "start", name: "exec", toolCallId: `tool-${index}` },
          });
        }
        const stream = page.locator(".activity-stream");
        await expect
          .poll(() =>
            stream.evaluate((element) => element.scrollHeight > element.clientHeight + 120),
          )
          .toBe(true);
        const autoFollow = page.locator(".activity-live-autofollow wa-switch");
        await autoFollow.click();
        await stream.evaluate((element) => {
          element.scrollTop = 0;
          element.dispatchEvent(new Event("scroll"));
        });
        await autoFollow.click();
        await page.clock.runFor(100);
        await expect
          .poll(() =>
            stream.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        const current = page.getByRole("region", { name: "Active sessions", exact: true });
        await expect
          .poll(() =>
            current.evaluate((element) => {
              const rows = element.querySelector(".activity-current-work__rows");
              const feedback = element.querySelector(".activity-current-work__feedback");
              if (!rows || !feedback) {
                return false;
              }
              const clip = rows.getBoundingClientRect();
              const content = feedback.getBoundingClientRect();
              return (
                content.height > 0 &&
                content.top >= clip.top - 1 &&
                content.bottom <= clip.bottom + 1
              );
            }),
          )
          .toBe(true);
        await page.screenshot({ path: path.join(suite.artifactDir, "05-live-burst.png") });
        await page.getByRole("tab", { name: "Sessions", exact: true }).click();
        await expect.poll(() => row.textContent()).toContain("Latest activity");
      },
    );
  });
});
