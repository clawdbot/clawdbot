import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI mount recovery E2E",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it("reloads a fresh document after the initial app module is unavailable", async () => {
    const artifactDir = createControlUiE2eArtifactDir("mount-recovery");
    await suite.withPage(
      {
        locale: "en-US",
        recordVideo: { dir: artifactDir, size: { height: 720, width: 1280 } },
        serviceWorkers: "block",
        viewport: { height: 720, width: 1280 },
      },
      async ({ page }) => {
        const baseUrl = new URL(suite.server.baseUrl);
        let documentRequests = 0;
        let failedModuleRequests = 0;
        await page.route(`${baseUrl.origin}/**`, async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (request.resourceType() === "document") {
            documentRequests += 1;
            const response = await route.fetch();
            const documentHtml = await response.text();
            // Accelerate only the broken document. The recovered Vite module needs the
            // real mount deadline so a loaded CI runner cannot race its own recovery.
            const body =
              documentRequests === 1
                ? documentHtml.replace(
                    'data-openclaw-mount-timeout-ms="12000"',
                    'data-openclaw-mount-timeout-ms="250"',
                  )
                : documentHtml;
            await route.fulfill({ response, body });
            return;
          }
          if (url.pathname === "/src/main.ts" && failedModuleRequests === 0) {
            failedModuleRequests += 1;
            await route.fulfill({ body: "gateway restarting", status: 503 });
            return;
          }
          await route.continue();
        });
        await installMockGateway(page);

        expect(
          (
            await page.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" })
          )?.status(),
        ).toBe(200);
        await page.locator("openclaw-app-shell").waitFor();
        await page.locator(".agent-chat__welcome").waitFor();

        expect(documentRequests).toBe(2);
        expect(failedModuleRequests).toBe(1);
        await expect.poll(() => page.url()).not.toContain("openclaw_mount_recovery");
        await page.screenshot({ path: path.join(artifactDir, "recovered-control-ui.png") });
      },
    );
  });
});
