// Source-blind browser proof for bundled plugin lazy-view recovery.
import path from "node:path";
import type { Route } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

let artifactDir: string;
beforeEach(() => {
  artifactDir = createControlUiE2eArtifactDir("plugin-bundled-view-recovery");
});
const bundledChunk = /\/assets\/logbook-view-[^/]+\.js(?:\?.*)?$/;

const suite = createControlUiE2eSuite({
  name: "Control UI bundled plugin lazy-view recovery",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

suite.define(() => {
  it("stops automatic reloads after one failed recovery and keeps manual Reload", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          controlUiTabs: [
            { group: "control", id: "logbook", label: "Logbook", pluginId: "logbook" },
          ],
          methodResponses: {
            "logbook.days": { days: [] },
            "logbook.status": {
              analysisIntervalMinutes: 15,
              analysisRunning: false,
              captureEnabled: true,
              captureIntervalSeconds: 30,
              capturePaused: false,
              pendingFrames: 0,
              retentionDays: 30,
              timeZone: "UTC",
              today: "2026-08-12",
              todayCards: 0,
              visionModelSource: "missing",
            },
            "logbook.timeline": {
              cards: [],
              day: "2026-08-12",
              stats: { apps: [], categories: [], distractionMs: 0, trackedMs: 0 },
            },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}plugin?plugin=missing&id=missing`);
        expect(response?.status()).toBe(200);
        await page.getByText("Plugin panel unavailable").waitFor();
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "before.png"),
        });

        let failedRequests = 0;
        let assetRequests = 0;
        let failingChunkPath: string | null = null;
        const failBundledChunkTwice = async (route: Route) => {
          assetRequests += 1;
          const requestPath = new URL(route.request().url()).pathname;
          failingChunkPath ??= requestPath;
          if (requestPath === failingChunkPath && failedRequests < 2) {
            failedRequests += 1;
            await route.abort("internetdisconnected");
            return;
          }
          await route.continue();
        };
        let markDocumentReachable!: () => void;
        const documentReachable = new Promise<void>((resolve) => {
          markDocumentReachable = resolve;
        });
        await page.route(/\/plugin(?:\?.*)?$/u, async (route) => {
          if (route.request().method() !== "HEAD") {
            await route.continue();
            return;
          }
          await documentReachable;
          await route.fulfill({ status: 200 });
        });
        await page.route(bundledChunk, failBundledChunkTwice);
        await page.getByRole("link", { name: "Logbook", exact: true }).click();
        await expect.poll(() => failedRequests).toBe(1);

        const alert = page.getByRole("alert");
        await alert.waitFor();
        expect(await alert.textContent()).toContain("A new version is available");
        expect(await alert.textContent()).toContain("Failed to fetch dynamically imported module");
        await alert.getByRole("button", { name: "Reload" }).waitFor();
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "failure.png"),
        });

        let documentRequestCount = 0;
        page.on("request", (request) => {
          if (request.resourceType() === "document") {
            documentRequestCount += 1;
          }
        });
        markDocumentReachable();

        await expect.poll(() => failedRequests).toBe(2);
        await alert.waitFor();
        await page.waitForTimeout(500);
        expect(await alert.count()).toBe(1);
        expect(documentRequestCount).toBe(1);

        await alert.getByRole("button", { name: "Reload" }).click();
        await page.locator(".logbook").waitFor();
        expect(await alert.count()).toBe(0);
        expect(assetRequests).toBeGreaterThan(2);
        expect(documentRequestCount).toBe(2);
        await gateway.waitForRequest("logbook.status");
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "recovered.png"),
        });
        expect(new URL(page.url()).pathname).toBe("/plugin");
      },
    );
  });
});
