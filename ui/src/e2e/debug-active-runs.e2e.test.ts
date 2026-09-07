import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Debug active run IDs mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it("reads exact active run IDs back from the Debug overlay", async () => {
    const proofDir = captureUiProof ? suite.artifactDir : "";
    if (captureUiProof) {
      // suite.artifactDir is exclusive per retry/process, so fixed capture names stay isolated.
      await mkdir(path.join(proofDir, "video"), { recursive: true });
    }
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
        ...(captureUiProof
          ? {
              recordVideo: {
                dir: path.join(proofDir, "video"),
                size: { height: 900, width: 1280 },
              },
            }
          : {}),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "diagnostics.lanes": { lanes: [], dynamic: null },
            "sessions.list": {
              sessions: [
                {
                  activeRunIds: ["run-primary", "run-observer"],
                  hasActiveRun: true,
                  sessionId: "session-diagnostics",
                },
              ],
            },
            status: {},
            "system.info": {},
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}debug`);
        expect(response?.status()).toBe(200);
        await page.locator(".page-title", { hasText: "Debug" }).waitFor();
        const sessionsRequestCount = (await gateway.getRequests("sessions.list")).length;
        await page.evaluate(() => {
          window.dispatchEvent(new CustomEvent("openclaw:debug-overlay-request"));
        });
        await gateway.waitForRequest("sessions.list", { after: sessionsRequestCount });

        const overlay = page.locator(".debug-overlay");
        await overlay.waitFor();
        const activeRuns = overlay.locator(".debug-overlay__section", {
          has: page.getByRole("heading", { name: "Active runs" }),
        });
        await expect.poll(() => activeRuns.textContent()).toContain("2 active");
        await expect.poll(() => activeRuns.textContent()).toContain("run-primary");
        await expect.poll(() => activeRuns.textContent()).toContain("run-observer");
        const rows = activeRuns.locator("li");
        expect(await rows.count()).toBe(2);
        expect(await rows.nth(0).getAttribute("title")).toBe("session-diagnostics / run-primary");
        expect(await rows.nth(1).getAttribute("title")).toBe("session-diagnostics / run-observer");
        expect(
          (await gateway.getRequests("sessions.list")).at(sessionsRequestCount)?.params,
        ).toEqual({});
        expect(
          await overlay.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);

        if (captureUiProof) {
          await overlay.screenshot({
            animations: "disabled",
            path: path.join(proofDir, "active-run-ids-desktop.png"),
          });
        }

        await page.setViewportSize({ height: 844, width: 390 });
        expect(
          await overlay.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        if (captureUiProof) {
          await overlay.screenshot({
            animations: "disabled",
            path: path.join(proofDir, "active-run-ids-mobile.png"),
          });
        }
      },
    );
  });
});
